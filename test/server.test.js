import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('HTTP lifecycle with isolated Claude history and no external services', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-http-test-'));
  const app = path.join(root, 'app');
  const home = path.join(root, 'home');
  const project = path.join(home, '.claude', 'projects', 'fixture');
  await fs.mkdir(path.join(app, 'public'), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  for (const name of ['server.js', 'thread-lifecycle.js', 'claude-errors.js', 'live-reload.js', 'work-items.js', 'integrations.js', 'config.js', 'secrets.js', 'settings.js', 'clockify.js', 'package.json']) {
    if (name === 'server.js') {
      const original = await fs.readFile(path.join(source, name), 'utf8');
      const guarded = original.replace("import { spawn, execFile } from 'node:child_process';",
        "import { spawn as realSpawn, execFile } from 'node:child_process';\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { EventEmitter } from 'node:events';")
        .replace('const ROOT =', `const spawn = (command, args, options) => {
          if (command !== 'claude') return realSpawn(command, args, options);
          appendFileSync(${JSON.stringify(path.join(root, 'claude-called'))}, JSON.stringify(args) + '\\n');
          const plan = JSON.parse(readFileSync(${JSON.stringify(path.join(root, 'claude-plan.json'))}, 'utf8'));
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
          child.kill = () => child.emit('close', null);
          child.stdin.end = () => setImmediate(() => {
            if (plan.spawnError) { child.emit('error', new Error('Mock spawn error')); child.emit('close', 1); return; }
            child.stdout.emit('data', plan.raw ?? JSON.stringify(plan.payload) + '\\n');
            child.emit('close', plan.exitCode ?? 0);
          });
          return child;
        };\nconst ROOT =`);
      assert.notEqual(guarded, original);
      await fs.writeFile(path.join(app, name), guarded);
    } else await fs.copyFile(path.join(source, name), path.join(app, name));
  }
  await fs.mkdir(path.join(app, 'data'), { recursive: true });
  await fs.writeFile(path.join(app, 'data', 'slack.json'), JSON.stringify({
    fetchedAt: '2026-10-15T12:00:00Z', items: [{ id: 'slack-fixture', channel: '#fixture', author: 'Fixture',
      text: 'Cached message', channelId: 'C123456789', slackTs: '1760562395.123456', threadTs: '1760562395.123456' }],
  }));
  await fs.writeFile(path.join(app, 'data', 'jira.json'), JSON.stringify({
    fetchedAt: '2026-10-15T12:00:00Z', items: [{ key: 'TEST-1', summary: 'Cached ticket' }],
  }));
  const old = new Date(Date.now() - 60_000);
  for (const id of ['first-session', 'second-session', 'third-session', 'active-session']) {
    const file = path.join(project, `${id}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({ type: 'user', cwd: home,
      timestamp: old.toISOString(), message: { content: `Fixture ${id} searchable` } })}\n`);
    if (id !== 'active-session') await fs.utimes(file, old, old);
  }
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  };
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: app, env: { ...process.env, HOME: home, PORT: String(port), DEVTOWER_KEYCHAIN: '0', DEVTOWER_BACKGROUND: '0', DEVTOWER_CONFIG: path.join(root, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error(`Fixture server exited: ${errors}`); }),
    ]);
  };
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  await start();
  const request = async (url, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };

  const quota = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
    result: "You've hit your session limit · resets 1:50pm (America/Cordoba)", session_id: 'private-session' };
  const plan = (payload) => fs.writeFile(path.join(root, 'claude-plan.json'), JSON.stringify({ payload }));
  const waitSource = async (provider) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = (await request(`/api/${provider}`)).data;
      if (!result.running) return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Fixture source did not complete');
  };

  await t.test('navigation serves cached data without invoking Claude', async () => {
    for (const provider of ['slack', 'jira']) {
      const { status, data } = await request(`/api/${provider}`);
      assert.equal(status, 200); assert.equal(data.items.length, 1);
      assert.equal(data.running, false); assert.equal(data.error, null);
    }
    await assert.rejects(fs.access(path.join(root, 'claude-called')), { code: 'ENOENT' });
  });

  await t.test('live reload sends a greeting and filesystem changes over SSE without Claude', async () => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${port}/api/dev/events`, { signal: abort.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      const first = decoder.decode((await reader.read()).value);
      assert.match(first, /event: hello/);
      await fs.writeFile(path.join(app, 'public', 'app.js'), '// fixture frontend change');
      let events = '';
      while (!events.includes('event: change')) events += decoder.decode((await reader.read()).value);
      assert.match(events, /"files":\["app.js"\]/);
      assert.doesNotMatch(events, /fixture frontend change/);
      await assert.rejects(fs.access(path.join(root, 'claude-called')), { code: 'ENOENT' });
    } finally { clearTimeout(timeout); abort.abort(); await reader.cancel().catch(() => {}); }
  });

  await t.test('local works create, update and reopen without Claude or connector calls', async () => {
    assert.deepEqual((await request('/api/work-items')).data.items, []);
    const draft = { title: 'Fixture work', projects: [home], links: ['https://example.test/TEST-1'],
      notes: 'Checked locally', nextStep: 'Continue tomorrow', threadIds: ['first-session'] };
    assert.equal((await request('/api/work-items', draft, { 'x-cockpit': '' })).status, 403);
    assert.equal((await request('/api/work-items', draft, { origin: 'https://evil.example' })).status, 403);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/work-items`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1' }, body: '{bad',
    });
    assert.equal(malformed.status, 400);
    const created = await request('/api/work-items', draft);
    assert.equal(created.status, 201);
    const item = created.data.item;
    assert.equal(item.threads[0].id, 'first-session');
    assert.equal((await request(`/api/work-items/${item.id}`, { ...draft, revision: 1, nextStep: 'Check tests' })).status, 200);
    assert.equal((await request(`/api/work-items/${item.id}`, { ...draft, revision: 1 })).status, 409);
    assert.equal((await request('/api/work-items', { ...draft, links: ['javascript:alert(1)'] })).status, 400);
    assert.equal((await request('/api/work-items', { ...draft, threadIds: ['missing'] })).status, 404);
    await stop(); await start();
    const saved = (await request('/api/work-items')).data.items[0];
    assert.equal(saved.nextStep, 'Check tests');
    assert.equal(saved.threads[0].status, 'active');
    await fs.access(path.join(project, 'first-session.jsonl'));
    await assert.rejects(fs.access(path.join(root, 'claude-called')), { code: 'ENOENT' });
  });

  await t.test('explicit refresh reports quota and preserves cached items and timestamps', async () => {
    await plan(quota);
    for (const provider of ['slack', 'jira']) {
      assert.equal((await request(`/api/${provider}/refresh`, {})).status, 200);
      const result = await waitSource(provider);
      assert.equal(result.errorCode, 'claude_usage_limit');
      assert.equal(result.resetAt, '1:50pm (America/Cordoba)');
      assert.match(result.error, /límite de uso de Claude/);
      assert.doesNotMatch(result.error, /private-session|session_id|is_error/);
      assert.equal(result.items.length, 1);
      assert.equal(result.fetchedAt, '2026-10-15T12:00:00Z');
    }
    const calls = (await fs.readFile(path.join(root, 'claude-called'), 'utf8')).trim().split('\n').map(JSON.parse);
    const slackArgs = calls[0];
    const allowed = slackArgs.slice(slackArgs.indexOf('--allowedTools') + 1);
    assert.equal(allowed.length, 5);
    assert.ok(allowed.every((tool) => tool.startsWith('mcp__claude_ai_Slack__slack_') && !tool.includes('*')));
    assert.ok(calls[1].includes('mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql'));
  });

  await t.test('suggest, draft and Jira actions return descriptive HTTP429, never raw CLI JSON', async () => {
    await plan(quota);
    for (const route of ['slack/suggest', 'slack/draft', 'jira/comment', 'jira/transitions', 'jira/transition']) {
      const result = await request(`/api/${route}`, { id: route === 'jira/transition' ? '31' : 'slack-fixture', key: 'TEST-1', text: 'fixture', name: 'Done' });
      assert.equal(result.status, 429, route);
      assert.equal(result.data.code, 'claude_usage_limit');
      assert.match(result.data.error, /1:50pm/);
      assert.doesNotMatch(result.data.error, /private-session|session_id|is_error/);
    }
  });

  await t.test('direct send without a Slack token fails clearly and never calls Claude', async () => {
    const before = await fs.readFile(path.join(root, 'claude-called'), 'utf8');
    const result = await request('/api/slack/send', { id: 'slack-fixture', text: 'hola' });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'token_missing');
    assert.equal((await request('/api/slack')).data.source, 'claude');
    const issue = await request('/api/jira/issue?key=TEST-1');
    assert.equal(issue.status, 503);
    assert.equal(issue.data.code, 'token_missing');
    assert.equal(await fs.readFile(path.join(root, 'claude-called'), 'utf8'), before);
  });

  await t.test('settings save validates input, ignores unknown keys and needs a manual restart outside launchd', async () => {
    assert.equal((await request('/api/settings', { jira: { ticketPattern: '([' } })).status, 400);
    assert.equal((await request('/api/settings', { jira: { site: 'http://insecure.example' } })).status, 400);
    assert.equal((await request('/api/settings', { user: { name: 'Ada' } }, { 'x-cockpit': '' })).status, 403);
    const saved = await request('/api/settings', { user: { name: 'Ada' }, github: { org: 'acme', coreRepos: ['api', 'bad repo!'] },
      links: [{ name: 'CI', url: 'https://ci.example' }, { name: 'Bad', url: 'javascript:alert(1)' }], token: 'xoxp-should-not-persist' });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.restart, 'manual');
    assert.deepEqual(saved.data.config.github, { org: 'acme', coreRepos: ['api'] });
    assert.deepEqual(saved.data.config.links.map((l) => l.name), ['CI']);
    const file = await fs.readFile(path.join(root, 'config.json'), 'utf8');
    assert.doesNotMatch(file, /xoxp-should-not-persist/);
    assert.equal((await fs.stat(path.join(root, 'config.json'))).mode & 0o777, 0o600);
    assert.equal((await request('/api/settings/link', { name: 'nope', token: 'x' })).status, 400);
    const clock = await request('/api/clockify');
    assert.equal(clock.status, 503);
    assert.equal(clock.data.code, 'token_missing');
    assert.equal((await request('/api/clockify/start', { description: '' })).status, 400);
  });

  await t.test('streaming chat reports the same human-readable limit', async () => {
    await plan(quota);
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1' },
      body: JSON.stringify({ cwd: home, prompt: 'quota fixture' }),
    });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    const errors = events.filter((event) => event.t === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'claude_usage_limit');
    assert.match(errors[0].message, /1:50pm/);
    assert.doesNotMatch(errors[0].message, /private-session|session_id/);
  });

  await t.test('default leaves model resolution to Claude Code and forwards its runtime model', async () => {
    await plan({ type: 'system', subtype: 'init', session_id: 'model-fixture', model: 'claude-runtime-model' });
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1' },
      body: JSON.stringify({ cwd: home, prompt: 'mock only', model: '' }),
    });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.find((event) => event.t === 'init').model, 'claude-runtime-model');
    const calls = (await fs.readFile(path.join(root, 'claude-called'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls[calls.length - 1].includes('--model'), false);
  });

  await t.test('explicit model selection is forwarded unchanged', async () => {
    await plan({ type: 'result', result: 'Mock response', is_error: false });
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1' },
      body: JSON.stringify({ cwd: home, prompt: 'mock only', model: 'sonnet' }),
    });
    await response.text();
    const calls = (await fs.readFile(path.join(root, 'claude-called'), 'utf8')).trim().split('\n').map(JSON.parse);
    const args = calls[calls.length - 1];
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  });

  await t.test('a successful retry clears the error and updates cache', async () => {
    for (const provider of ['slack', 'jira']) {
      const items = provider === 'slack' ? [{ id: 'new-item', text: 'Updated' }] : [{ key: 'TEST-2', summary: 'Updated' }];
      await plan({ result: JSON.stringify({ items }), is_error: false });
      await request(`/api/${provider}/refresh`, {});
      const result = await waitSource(provider);
      assert.equal(result.error, null); assert.equal(result.errorCode, null); assert.equal(result.resetAt, null);
      assert.equal(result.items.length, 1);
      assert.notEqual(result.fetchedAt, '2026-10-15T12:00:00Z');
    }
  });

  await t.test('list and cross-origin guards', async () => {
    assert.equal((await request('/api/threads')).data.threads.length, 4);
    assert.equal((await request('/api/threads/first-session/archive', {}, { 'x-cockpit': '' })).status, 403);
    assert.equal((await request('/api/threads/first-session/delete', { confirm: true }, { origin: 'https://evil.example' })).status, 403);
    await fs.access(path.join(project, 'first-session.jsonl'));
  });

  await t.test('archive affects lists and search, survives restart, keeps transcript readable', async () => {
    assert.equal((await request('/api/threads/first-session/archive', {})).status, 200);
    let list = (await request('/api/threads')).data;
    assert.equal(list.threads.some((item) => item.id === 'first-session'), false);
    assert.equal(list.archivedThreads[0].id, 'first-session');
    assert.equal((await request('/api/work-items')).data.items[0].threads[0].status, 'archived');
    assert.equal((await request('/api/search?q=first-session')).data.hits.length, 0);
    assert.equal((await request('/api/search?q=first-session&visibility=archived')).data.hits.length, 1);
    assert.equal((await request('/api/threads/first-session')).status, 200);
    assert.equal((await request('/api/run', { sessionId: 'first-session', cwd: home, prompt: 'do not run' })).status, 409);
    await stop(); await start();
    list = (await request('/api/threads')).data;
    assert.equal(list.archivedThreads[0].id, 'first-session');
    assert.equal((await request('/api/work-items')).data.items[0].threads[0].status, 'archived');
    assert.equal((await request('/api/threads/first-session/restore', {})).status, 200);
    assert.equal((await request('/api/search?q=first-session')).data.hits.length, 1);
  });

  await t.test('delete removes source, list, search, transcript and persisted index', async () => {
    assert.equal((await request('/api/threads/first-session/delete', {})).status, 400);
    await fs.access(path.join(project, 'first-session.jsonl'));
    assert.equal((await request('/api/threads/first-session/delete', { confirm: true })).status, 200);
    await assert.rejects(fs.access(path.join(project, 'first-session.jsonl')), { code: 'ENOENT' });
    const savedWork = (await request('/api/work-items')).data.items[0];
    assert.equal(savedWork.nextStep, 'Check tests');
    assert.equal(savedWork.threads[0].status, 'deleted');
    assert.equal((await request('/api/threads/first-session')).status, 404);
    assert.equal((await request('/api/search?q=first-session')).data.hits.length, 0);
    assert.equal((await request('/api/search?q=first-session&visibility=archived')).data.hits.length, 0);
    assert.equal((await request('/api/run', { sessionId: 'first-session', cwd: home, prompt: 'do not run' })).status, 404);
    assert.equal((await fs.readFile(path.join(app, 'data', 'index.json'), 'utf8')).includes('first-session'), false);
    await fs.access(path.join(project, 'second-session.jsonl'));
    await stop(); await start();
    assert.equal((await request('/api/threads')).data.threads.some((item) => item.id === 'first-session'), false);
  });

  await t.test('active and malformed sessions are protected', async () => {
    await fs.utimes(path.join(project, 'active-session.jsonl'), new Date(), new Date());
    assert.equal((await request('/api/threads/active-session/archive', {})).status, 409);
    assert.equal((await request('/api/threads/active-session/delete', { confirm: true })).status, 409);
    assert.equal((await request('/api/threads/bad%2Fid/delete', { confirm: true })).status, 400);
    assert.equal((await request('/api/threads/missing/delete', { confirm: true })).status, 404);
    await fs.access(path.join(project, 'active-session.jsonl'));
  });

  await t.test('concurrent requests preserve archive state for different sessions', async () => {
    const results = await Promise.all(['second-session', 'third-session'].map((id) => request(`/api/threads/${id}/archive`, {})));
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    assert.equal((await request('/api/threads')).data.archivedThreads.length, 2);
  });
});
