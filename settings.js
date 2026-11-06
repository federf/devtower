import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { CONFIG_DIR, CONFIG_FILE, DEFAULTS } from './config.js';
import { readSecret, removeSecret, storeSecret } from './secrets.js';

// Settings view backend + shared validation used by scripts/setup.mjs.
// Tokens go in (to be validated and stored) but never come back out.

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15_000 }, (err, out) => resolve(err ? null : String(out).trim()));
});
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ------------------------------------------------------------------ validation against the real APIs

export const validateJira = async ({ site, email, token }, fetchImpl = fetch) => {
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const res = await fetchImpl(`${site}/rest/api/3/myself`, { headers: { authorization: auth, accept: 'application/json' } }).catch(() => null);
  if (!res?.ok) throw fail(res?.status === 401 || res?.status === 403 ? 'Jira rechazó el email o el token.' : `No pude conectar con ${site}.`, 502);
  const me = await res.json();
  const cloudId = (await fetchImpl(`${site}/_edge/tenant_info`).then((r) => r.json()).catch(() => ({}))).cloudId || '';
  return { name: me.displayName, accountId: me.accountId, cloudId };
};

// ticket pattern and support labels suggested from the user's own issues
export const jiraSuggestions = async ({ site, email, token }, fetchImpl = fetch) => {
  const res = await fetchImpl(`${site}/rest/api/3/search/jql`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jql: 'assignee = currentUser() ORDER BY updated DESC', maxResults: 100, fields: ['labels'] }),
  }).then((r) => r.json()).catch(() => ({}));
  const projects = [...new Set((res.issues || []).map((i) => i.key.split('-')[0]))];
  const labels = [...new Set((res.issues || []).flatMap((i) => i.fields?.labels || []))];
  return { projects, labels, ticketPattern: projects.length ? `(?:${projects.join('|')})-\\d{1,7}` : DEFAULTS.jira.ticketPattern };
};

export const validateSlack = async (token, fetchImpl = fetch) => {
  const me = await fetchImpl('https://slack.com/api/auth.test', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
  if (!me.ok) throw fail(`Slack rechazó el token (${me.error || 'sin respuesta'}).`, 502);
  return { name: me.user, team: me.team, userId: me.user_id, url: me.url };
};

export const validateClockify = async (key, fetchImpl = fetch) => {
  const res = await fetchImpl('https://api.clockify.me/api/v1/user', { headers: { 'x-api-key': key } }).catch(() => null);
  if (!res?.ok) throw fail(res?.status === 401 ? 'Clockify rechazó la API key.' : 'No pude conectar con Clockify.', 502);
  const me = await res.json();
  return { name: me.name, email: me.email, workspaceId: me.activeWorkspace || me.defaultWorkspace };
};

// ------------------------------------------------------------------ config editing

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const strList = (v, re, max = 30) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => String(x).trim()).filter((x) => x && (!re || re.test(x))).slice(0, max);

// only known keys, each validated; anything else in the body is ignored
const sanitize = (body, current) => {
  const next = structuredClone(current);
  if (body.user) next.user.name = str(body.user.name, 60);
  if ('reposDir' in body) next.reposDir = str(body.reposDir, 300) || DEFAULTS.reposDir;
  if (body.github) {
    if ('org' in body.github) {
      const org = str(body.github.org, 100);
      if (org && !/^[\w.-]+$/.test(org)) throw fail('Org de GitHub inválida');
      next.github.org = org;
    }
    if ('coreRepos' in body.github) next.github.coreRepos = strList(body.github.coreRepos, /^[\w.-]+$/, 20);
  }
  if (body.jira) {
    if ('site' in body.jira) {
      const site = str(body.jira.site, 200).replace(/\/+$/, '');
      if (site && !/^https:\/\/[\w.-]+$/.test(site)) throw fail('El sitio de Jira debe ser https://tu-empresa.atlassian.net');
      next.jira.site = site;
    }
    if ('email' in body.jira) next.jira.email = str(body.jira.email, 200);
    if ('ticketPattern' in body.jira) {
      const pattern = str(body.jira.ticketPattern, 200) || DEFAULTS.jira.ticketPattern;
      try { new RegExp(pattern); } catch { throw fail('El patrón de tickets no es una regex válida'); }
      next.jira.ticketPattern = pattern;
    }
    if ('supportLabels' in body.jira) next.jira.supportLabels = strList(body.jira.supportLabels, /^[\w.:-]+$/);
  }
  if (body.deployCheck) {
    if ('command' in body.deployCheck) next.deployCheck.command = str(body.deployCheck.command, 500);
    if ('repos' in body.deployCheck) next.deployCheck.repos = strList(body.deployCheck.repos, /^[\w.-]+\/[\w.-]+$/, 20);
  }
  if (Array.isArray(body.links)) {
    next.links = body.links.slice(0, 60).map((l) => ({ name: str(l?.name, 80), url: str(l?.url, 500), icon: str(l?.icon, 2) || '↗', group: str(l?.group, 30) }))
      .filter((l) => l.name && /^https?:\/\//.test(l.url));
  }
  if (body.logs) next.logs.hint = str(body.logs.hint, 500);
  return next;
};

const readRaw = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const writeRaw = (cfg) => {
  const { configured, ...clean } = cfg;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
};

export const createSettings = ({ loadConfig, forget, gh = 'gh', fetchImpl = fetch }) => {
  const editable = (c) => ({ user: c.user, reposDir: c.reposDir, github: c.github, jira: { site: c.jira.site, email: c.jira.email, ticketPattern: c.jira.ticketPattern, supportLabels: c.jira.supportLabels },
    deployCheck: c.deployCheck, links: c.links, logs: c.logs });

  const status = async () => {
    const c = loadConfig();
    const [ghVersion, ghUser, orgs, claude, jiraToken, slackToken, clockifyKey] = await Promise.all([
      run(gh, ['--version']), run(gh, ['api', 'user', '--jq', '.login']), run(gh, ['api', 'user/orgs', '--jq', '.[].login']),
      run('claude', ['--version']), readSecret('jira'), readSecret('slack'), readSecret('clockify'),
    ]);
    const clockify = { linked: false };
    if (clockifyKey) {
      try { Object.assign(clockify, { linked: true, user: (await validateClockify(clockifyKey.password, fetchImpl)).name }); }
      catch (e) { clockify.error = e.message; }
    }
    const jira = { linked: false };
    if (jiraToken && c.jira.site) {
      try { jira.user = (await validateJira({ site: c.jira.site, email: c.jira.email || jiraToken.account, token: jiraToken.password }, fetchImpl)).name; jira.linked = true; }
      catch (e) { jira.error = e.message; }
    }
    const slack = { linked: false };
    if (slackToken) {
      try { const s = await validateSlack(slackToken.password, fetchImpl); Object.assign(slack, { linked: true, user: s.name, team: s.team }); }
      catch (e) { slack.error = e.message; }
    }
    return {
      file: CONFIG_FILE, configured: c.configured, config: editable(c),
      github: { installed: Boolean(ghVersion), user: ghUser, orgs: orgs ? orgs.split('\n').filter(Boolean) : [] },
      jira, slack, clockify, claude: { installed: Boolean(claude), version: claude || '' },
    };
  };

  const save = async (body) => {
    const current = loadConfig();
    const next = sanitize(body || {}, current);
    if (next.jira.site !== current.jira.site) {
      next.jira.cloudId = next.jira.site ? (await fetchImpl(`${next.jira.site}/_edge/tenant_info`).then((r) => r.json()).catch(() => ({}))).cloudId || '' : '';
    }
    writeRaw(next);
    return editable(loadConfig());
  };

  const link = async ({ name, token, site, email }) => {
    const secret = str(token, 500);
    if (!secret) throw fail('Pegá el token');
    if (name === 'jira') {
      const c = loadConfig();
      const target = { site: str(site, 200).replace(/\/+$/, '') || c.jira.site, email: str(email, 200) || c.jira.email };
      if (!/^https:\/\/[\w.-]+$/.test(target.site) || !target.email) throw fail('Completá el sitio y el email de Jira');
      const me = await validateJira({ ...target, token: secret }, fetchImpl);
      const where = await storeSecret('jira', secret, target.email);
      writeRaw({ ...readRaw(), jira: { ...readRaw().jira, site: target.site, email: target.email, cloudId: me.cloudId || readRaw().jira?.cloudId || '' } });
      forget();
      return { user: me.name, where };
    }
    if (name === 'slack') {
      const me = await validateSlack(secret, fetchImpl);
      const where = await storeSecret('slack', secret);
      writeRaw({ ...readRaw(), slack: { ...readRaw().slack, userId: me.userId } });
      forget();
      return { user: me.name, team: me.team, where };
    }
    if (name === 'clockify') {
      const me = await validateClockify(secret, fetchImpl);
      const where = await storeSecret('clockify', secret, me.email || undefined);
      writeRaw({ ...readRaw(), clockify: { ...readRaw().clockify, workspaceId: me.workspaceId } });
      forget();
      return { user: me.name, where };
    }
    throw fail('Integración desconocida');
  };

  const unlink = async (name) => {
    if (!['jira', 'slack', 'clockify'].includes(name)) throw fail('Integración desconocida');
    await removeSecret(name);
    forget();
  };

  const suggestJira = async () => {
    const c = loadConfig();
    const token = await readSecret('jira');
    if (!token || !c.jira.site) throw fail('Vinculá Jira primero', 409);
    return jiraSuggestions({ site: c.jira.site, email: c.jira.email || token.account, token: token.password }, fetchImpl);
  };

  const repos = async (org) => {
    if (!/^[\w.-]+$/.test(String(org || ''))) return [];
    const out = await run(gh, ['repo', 'list', org, '--limit', '100', '--json', 'name,pushedAt', '--jq', 'sort_by(.pushedAt) | reverse | .[].name']);
    return out ? out.split('\n').filter(Boolean) : [];
  };

  return { status, save, link, unlink, suggestJira, repos };
};
