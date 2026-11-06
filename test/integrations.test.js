import assert from 'node:assert/strict';
import test from 'node:test';
import { adfText, createIntegrations, toAdf } from '../integrations.js';

const ME = 'UME0000001';
const reply = (body, status = 200, headers = {}) => ({
  ok: status < 400, status, headers: new Headers(headers), json: async () => body,
});
const secrets = { jira: { account: 'me@example.test', password: 'jira-secret' }, slack: { account: 'me', password: 'xoxp-secret' } };
const setup = (routes, { tokens = secrets } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const route = routes[u.pathname.split('/').pop()];
    if (!route) throw new Error(`unexpected ${u.pathname}`);
    return route(u, init);
  };
  return { calls, api: createIntegrations({ jiraSite: 'https://example.atlassian.net', fetchImpl, readSecret: async (s) => tokens[s] || null, now: () => Date.parse('2026-11-06T12:00:00Z') }) };
};
const ch = (id, extra = {}) => ({ id, name: extra.is_im ? 'UOTHER0001' : 'general', ...extra });

test('toAdf keeps paragraphs and line breaks', () => {
  assert.deepEqual(toAdf('Hola\nchau\n\nOtro'), { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hola' }, { type: 'hardBreak' }, { type: 'text', text: 'chau' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Otro' }] },
  ] });
});

test('toAdf puts mentions first so Jira notifies them; adfText reads it back', () => {
  const doc = toAdf('Ya está en prod.\n\nCambios', [{ accountId: '5b10ac8d82e05b22cc7d4ef5', name: 'Augusto' }]);
  assert.deepEqual(doc.content[0].content.slice(0, 2), [{ type: 'mention', attrs: { id: '5b10ac8d82e05b22cc7d4ef5', text: '@Augusto' } }, { type: 'text', text: ' ' }]);
  assert.equal(adfText(doc), '@Augusto Ya está en prod.\nCambios\n');
});

test('missing token reports a descriptive error without calling the network', async () => {
  const { api, calls } = setup({}, { tokens: {} });
  assert.equal(await api.has('jira'), false);
  await assert.rejects(api.jira.search(), { code: 'token_missing', message: /npm run setup/ });
  assert.equal(calls.length, 0);
});

test('Jira search maps fields and authenticates with basic auth', async () => {
  const sprints = [{ id: 1, name: 'Viejo', state: 'closed', boardId: 7 }, { id: 2, name: 'Sprint 2', state: 'active', boardId: 7, startDate: '2026-11-01', endDate: '2026-11-14' }];
  const { api, calls } = setup({
    field: () => reply([{ id: 'customfield_10007', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]),
    jql: (u, init) => reply({ issues: JSON.parse(init.body).jql.includes('openSprints') ? [] : [{ key: 'TEST-1', fields: {
      summary: 'Fixture', status: { id: '3', name: 'En curso', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'Alta' }, issuetype: { name: 'Tarea' }, updated: '2026-11-06', duedate: '2026-11-07', parent: { key: 'TEST-0' },
      customfield_10007: sprints,
    } }] }),
  });
  const [issue] = await api.jira.search();
  assert.deepEqual(issue, { key: 'TEST-1', summary: 'Fixture', status: 'En curso', statusId: '3', statusCategory: 'indeterminate', priority: 'Alta',
    type: 'Tarea', updated: '2026-11-06', due: '2026-11-07', parent: 'TEST-0', url: 'https://example.atlassian.net/browse/TEST-1',
    sprint: { id: 2, name: 'Sprint 2', state: 'active', boardId: 7, start: '2026-11-01', end: '2026-11-14' } });
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('me@example.test:jira-secret').toString('base64')}`);
});

test('Jira auth failure never echoes the token', async () => {
  const { api } = setup({ field: () => reply({}, 401), jql: () => reply({}, 401) });
  await assert.rejects(api.jira.search(), (e) => e.code === 'jira_auth' && !e.message.includes('jira-secret'));
});

test('next sprint picks the earliest future sprint of the active boards', async () => {
  const { api, calls } = setup({
    field: () => reply([]),
    sprint: () => reply({ values: [
      { id: 9, name: 'Lejano', state: 'future', startDate: '2026-12-01' },
      { id: 8, name: 'Siguiente', state: 'future', startDate: '2026-11-15', endDate: '2026-11-29' },
      { id: 5, name: 'Sin fecha', state: 'future' },
    ] }),
    jql: () => reply({ issues: [] }),
  });
  const next = await api.jira.nextSprint([77]);
  assert.equal(next.sprint.name, 'Siguiente');
  assert.match(JSON.parse(calls.at(-1).init.body).jql, /sprint = 8\b/);
  await assert.rejects(api.jira.nextSprint([]), { code: 'jira_no_sprint' });
});

test('swimlanes follow Jira: first matching lane wins, empty query catches the rest', async () => {
  const hits = { 'labels = x': ['A-1', 'A-2'], 'due = today': ['A-2', 'A-3'] };
  const { api } = setup({ jql: (u, init) => {
    const jql = JSON.parse(init.body).jql;
    const lane = Object.keys(hits).find((q) => jql.endsWith(`(${q})`));
    return reply({ issues: hits[lane].map((key) => ({ key })) });
  } });
  const lanes = await api.jira.assignLanes(['A-1', 'A-2', 'A-3', 'A-4'],
    [{ name: 'Tickets', query: 'labels = x' }, { name: 'Hoy', query: 'due = today' }, { name: 'Resto', query: '' }]);
  assert.deepEqual(Object.fromEntries(lanes), { 'A-1': 0, 'A-2': 0, 'A-3': 1, 'A-4': 2 });
});

test('Slack pending finds unanswered DMs, mentions and threads, skipping answered ones and bots', async () => {
  const search = {
    [`to:<@${ME}>`]: [
      { channel: ch('DPENDING01', { is_im: true, user: 'UOTHER0001' }), ts: '1762400000.000100', user: 'UOTHER0001', permalink: '' },
      { channel: ch('DANSWERED1', { is_im: true, user: 'UOTHER0001' }), ts: '1762400000.000200', user: 'UOTHER0001', permalink: '' },
      { channel: ch('DBOT000001', { is_im: true, user: 'UBOT000001' }), ts: '1762400000.000300', user: 'UBOT000001', permalink: '' },
    ],
    [`<@${ME}>`]: [
      { channel: ch('CMENTION01'), ts: '1762400100.000100', user: 'UOTHER0001', text: `hola <@${ME}> &amp; más`,
        permalink: 'https://x.slack.com/archives/CMENTION01/p1762400100000100' },
      { channel: ch('CANSWER001'), ts: '1762400100.000200', user: 'UOTHER0001', text: 'ya está',
        permalink: 'https://x.slack.com/archives/CANSWER001/p1762400100000200?thread_ts=1762400000.000000' },
    ],
    [`from:<@${ME}>`]: [
      { channel: ch('CTHREAD001'), ts: '1762400200.000100', user: ME,
        permalink: 'https://x.slack.com/archives/CTHREAD001/p1762400200000100?thread_ts=1762400150.000000' },
    ],
  };
  const history = {
    DPENDING01: { user: 'UOTHER0001', ts: '1762400000.000100', text: '¿me ayudás?' },
    DANSWERED1: { user: ME, ts: '1762400000.000900', text: 'listo' },
    DBOT000001: { user: 'UBOT000001', bot_id: 'B1', ts: '1762400000.000300', text: 'alerta' },
  };
  const threads = {
    CMENTION01: [{ user: 'UOTHER0001', ts: '1762400100.000100' }],
    CANSWER001: [{ user: 'UOTHER0001', ts: '1762400100.000200' }, { user: ME, ts: '1762400100.000900' }],
    CTHREAD001: [{ user: ME, ts: '1762400200.000100' }, { user: 'UOTHER0001', ts: '1762400300.000100', text: 'respuesta' }],
  };
  const { api, calls } = setup({
    'auth.test': () => reply({ ok: true, user_id: ME, url: 'https://example.slack.com/' }),
    'search.messages': (u) => reply({ ok: true, messages: { matches: search[u.searchParams.get('query').split(' after:')[0]] } }),
    'conversations.history': (u) => reply({ ok: true, messages: [history[u.searchParams.get('channel')]] }),
    'conversations.replies': (u) => reply({ ok: true, messages: threads[u.searchParams.get('channel')] }),
    'users.info': (u) => reply({ ok: true, user: { profile: { display_name: u.searchParams.get('user') === ME ? 'yo' : 'Otra' } } }),
  });
  const items = await api.slack.pending();
  assert.deepEqual(items.map((i) => [i.kind, i.channelId]).sort(), [['dm', 'DPENDING01'], ['mention', 'CMENTION01'], ['thread', 'CTHREAD001']]);
  const mention = items.find((i) => i.kind === 'mention');
  assert.equal(mention.text, 'hola @yo & más');
  assert.equal(mention.channel, '#general');
  assert.equal(items.find((i) => i.kind === 'dm').channel, 'DM · Otra');
  const thread = items.find((i) => i.kind === 'thread');
  assert.equal(thread.threadTs, '1762400150.000000');
  assert.equal(thread.threaded, true);
  assert.equal(calls[0].init.headers.authorization, 'Bearer xoxp-secret');
  assert.ok(calls.every((c) => !c.url.pathname.endsWith('chat.postMessage')));
});

test('Slack send posts in thread and surfaces rate limits', async () => {
  const { api, calls } = setup({
    'chat.postMessage': () => reply({ ok: true, ts: '1762400999.000100' }),
    'chat.getPermalink': () => reply({ ok: true, permalink: 'https://x.slack.com/p1' }),
  });
  assert.deepEqual(await api.slack.send({ channelId: 'C123456789', threadTs: '1762400000.000100', text: 'ok' }),
    { ts: '1762400999.000100', link: 'https://x.slack.com/p1' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { channel: 'C123456789', text: 'ok', thread_ts: '1762400000.000100' });

  const limited = setup({ 'chat.postMessage': () => reply({}, 429, { 'retry-after': '30' }) });
  await assert.rejects(limited.api.slack.send({ channelId: 'C123456789', text: 'ok' }), { code: 'slack_rate_limited', message: /30s/ });
});
