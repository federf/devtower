import { readSecret as storedSecret } from './secrets.js';

// Direct Jira/Slack access with personal tokens (see secrets.js for where they are stored).
// No Claude, no quota: used for background refresh and explicit writes.

const JIRA_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'updated', 'parent', 'duedate'];
const LOOKBACK_DAYS = 7;
const MAX_CHECKS = 25;

const fail = (message, code, status = 502, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

const mapPool = async (items, size, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
};

// Plain text → Atlassian Document Format: blank lines split paragraphs, newlines become hard breaks.
// Mentions (Jira notifies them) open the first paragraph.
export const toAdf = (text, mentions = []) => {
  const content = String(text).trim().split(/\n{2,}/).map((para) => ({
    type: 'paragraph',
    content: para.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  }));
  if (mentions.length) {
    const tags = mentions.flatMap((m) => [{ type: 'mention', attrs: { id: m.accountId, text: `@${m.name}` } }, { type: 'text', text: ' ' }]);
    content[0] = { type: 'paragraph', content: [...tags, ...(content[0]?.content || [])] };
  }
  return { type: 'doc', version: 1, content };
};

// ADF → plain text (descriptions and comments shown for review)
export const adfText = (node) => {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return node.attrs?.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type) ? `${inner}\n` : inner;
};

const tsToIso = (ts) => new Date(Number(String(ts).split('.')[0]) * 1000).toISOString();
const threadOf = (match) => /[?&]thread_ts=(\d+\.\d+)/.exec(match.permalink || '')?.[1] || null;
const isBot = (m) => Boolean(m.bot_id || m.subtype === 'bot_message' || m.app_id);

export const createIntegrations = ({ jiraSite = '', jiraEmail = '', fetchImpl = fetch, readSecret = storedSecret, now = () => Date.now() } = {}) => {
  const JIRA_SITE = jiraSite;
  const secrets = new Map();
  const secret = async (name) => {
    const cached = secrets.get(name);
    if (cached && now() - cached.at < 60_000) return cached.value;
    const value = name === 'jira' && !JIRA_SITE ? null : await readSecret(name);
    secrets.set(name, { at: now(), value });
    return value;
  };
  const has = async (name) => Boolean(await secret(name));
  const need = async (name) => {
    const value = await secret(name);
    if (!value) throw fail(`Falta configurar ${name === 'jira' ? 'Jira' : 'Slack'}: corré npm run setup.`, 'token_missing', 503);
    return value;
  };

  // ------------------------------------------------------------------ Jira
  const jira = async (pathname, { method = 'GET', body } = {}) => {
    const { account: stored, password } = await need('jira');
    const account = jiraEmail || stored;
    const res = await fetchImpl(`${JIRA_SITE}${pathname}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${account}:${password}`).toString('base64')}`,
        accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) throw fail('Jira rechazó el token. Regeneralo y guardalo de nuevo en el Keychain.', 'jira_auth', 502);
    if (res.status === 429) throw fail('Jira limitó las consultas. Reintentá en unos minutos.', 'jira_rate_limited', 429);
    if (!res.ok) throw fail(`Jira respondió ${res.status}.`, 'jira_failed');
    return res.status === 204 ? null : res.json();
  };

  let sprintFieldId;
  const sprintField = async () => (sprintFieldId ??= ((await jira('/rest/api/3/field'))
    .find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id || null));
  const sprintInfo = (s) => ({ id: s.id, name: s.name, state: s.state, boardId: s.boardId ?? s.originBoardId ?? null,
    start: s.startDate || '', end: s.endDate || '' });
  // an issue carried over keeps its closed sprints: the relevant one is active, else the nearest future
  const currentSprint = (list) => {
    const open = (list || []).filter((s) => s.state === 'active' || s.state === 'future');
    const pick = open.find((s) => s.state === 'active')
      || open.sort((a, b) => Date.parse(a.startDate || 8.64e15) - Date.parse(b.startDate || 8.64e15))[0];
    return pick ? sprintInfo(pick) : null;
  };
  const issues = async (jql) => {
    const field = await sprintField();
    const data = await jira('/rest/api/3/search/jql', { method: 'POST', body: {
      jql, maxResults: 100, fields: [...JIRA_FIELDS, ...(field ? [field] : [])],
    } });
    return (data.issues || []).map(({ key, fields: f }) => ({
      key, summary: f.summary || '', status: f.status?.name || '', statusId: f.status?.id || '', statusCategory: f.status?.statusCategory?.key || '',
      priority: f.priority?.name || '', type: f.issuetype?.name || '', updated: f.updated || '',
      due: f.duedate || '', parent: f.parent?.key || '', url: `${JIRA_SITE}/browse/${key}`,
      sprint: field ? currentSprint(f[field]) : null,
    }));
  };

  // open issues plus everything in the active sprint (done included, for progress)
  const searchJira = async () => {
    const [open, sprint] = await Promise.all([
      issues('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'),
      issues('assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC'),
    ]);
    return [...new Map([...open, ...sprint].map((i) => [i.key, i])).values()];
  };

  // next sprint = earliest future sprint of the boards running an active sprint
  const nextSprint = async (boardIds) => {
    if (!boardIds.length) throw fail('No hay un sprint activo con tareas tuyas para calcular el próximo.', 'jira_no_sprint', 404);
    const future = (await Promise.all(boardIds.map((b) => jira(`/rest/agile/1.0/board/${Number(b)}/sprint?state=future&maxResults=50`))))
      .flatMap((d) => d.values || []).filter((s) => s.startDate);
    const sprint = future.sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))[0];
    if (!sprint) return { sprint: null, items: [] };
    return { sprint: sprintInfo(sprint), items: await issues(`assignee = currentUser() AND sprint = ${Number(sprint.id)} ORDER BY updated DESC`) };
  };
  // Board layout as Jira shows it: columns by status and custom JQL swimlanes.
  // Swimlanes come from the (private) greenhopper config; if it fails the board has one lane.
  const boardLayout = async (boardId) => {
    const id = Number(boardId);
    const config = await jira(`/rest/agile/1.0/board/${id}/configuration`);
    const columns = (config.columnConfig?.columns || []).map((c) => ({ name: c.name, statuses: (c.statuses || []).map((st) => String(st.id)) }));
    let swimlanes = [];
    try {
      const edit = await jira(`/rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=${id}`);
      if (edit.swimlanesConfig?.swimlaneStrategy === 'custom') {
        swimlanes = (edit.swimlanesConfig.swimlanes || []).map((l) => ({ name: l.name, query: String(l.query || '').replace(/\s+ORDER\s+BY\s+.*$/is, '').trim() }));
      }
    } catch { swimlanes = []; }
    return { id, name: config.name || '', columns, swimlanes };
  };

  // Jira evaluates each lane's JQL; an issue lands in the first lane that matches.
  const assignLanes = async (keys, swimlanes) => {
    const lanes = new Map();
    if (!keys.length || !swimlanes.length) return lanes;
    const keyList = keys.join(',');
    const matches = await Promise.all(swimlanes.map((l) => (l.query
      ? jira('/rest/api/3/search/jql', { method: 'POST', body: { jql: `key in (${keyList}) AND (${l.query})`, maxResults: 100, fields: ['summary'] } })
        .then((d) => new Set((d.issues || []).map((i) => i.key))).catch(() => new Set())
      : Promise.resolve(null))));
    for (const key of keys) {
      const lane = matches.findIndex((set) => set === null || set.has(key));
      lanes.set(key, lane === -1 ? swimlanes.length - 1 : lane);
    }
    return lanes;
  };

  const commentJira = (key, text, mentions = []) => jira(`/rest/api/3/issue/${key}/comment`, { method: 'POST', body: { body: toAdf(text, mentions) } });
  const jiraTransitions = async (key) => ((await jira(`/rest/api/3/issue/${key}/transitions`)).transitions || [])
    .map((t) => ({ id: String(t.id), name: t.name, to: t.to?.name || '', toId: String(t.to?.id || ''), toCategory: t.to?.statusCategory?.key || '' }));

  let myself;
  const jiraMe = async () => (myself ??= await jira('/rest/api/3/myself').then((m) => ({ accountId: m.accountId, name: m.displayName })));
  const person = (u) => (u ? { accountId: u.accountId, name: u.displayName } : null);
  // comments by others on my issues (assigned, reported or watched) updated in the last minutes
  const recentComments = async (minutes = 10) => {
    const me = await jiraMe();
    const data = await jira('/rest/api/3/search/jql', { method: 'POST', body: {
      jql: `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${Number(minutes)}m ORDER BY updated DESC`,
      maxResults: 15, fields: ['summary'] } });
    const out = [];
    for (const issue of data.issues || []) {
      const { comments = [] } = await jira(`/rest/api/3/issue/${issue.key}/comment?orderBy=-created&maxResults=5`);
      for (const c of comments) {
        if (c.author?.accountId === me.accountId) continue;
        const mentionsMe = JSON.stringify(c.body || {}).includes(`"id":"${me.accountId}"`);
        out.push({ id: c.id, key: issue.key, summary: issue.fields?.summary || '', author: c.author?.displayName || '', created: c.created,
          text: adfText(c.body).trim().slice(0, 300), mentionsMe, url: `${JIRA_SITE}/browse/${issue.key}?focusedCommentId=${c.id}` });
      }
    }
    return out;
  };

  const getIssue = async (key, { comments = 5 } = {}) => {
    const { fields: f } = await jira(`/rest/api/3/issue/${key}?fields=summary,description,labels,reporter,assignee,status,issuetype,priority,parent,comment`);
    return {
      key, url: `${JIRA_SITE}/browse/${key}`, summary: f.summary || '', status: f.status?.name || '', type: f.issuetype?.name || '',
      priority: f.priority?.name || '', labels: f.labels || [], parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
      reporter: person(f.reporter), assignee: person(f.assignee), description: adfText(f.description).trim().slice(0, 4000),
      comments: (f.comment?.comments || []).slice(-comments).map((c) => ({ author: c.author?.displayName || '', at: c.created, text: adfText(c.body).trim().slice(0, 1200) })),
    };
  };
  const transitionJira = (key, id) => jira(`/rest/api/3/issue/${key}/transitions`, { method: 'POST', body: { transition: { id: String(id) } } });

  // ----------------------------------------------------------------- Slack
  const slack = async (method, params = {}, { post = false } = {}) => {
    const { password } = await need('slack');
    const headers = { authorization: `Bearer ${password}` };
    const url = new URL(`https://slack.com/api/${method}`);
    let body;
    if (post) { headers['content-type'] = 'application/json; charset=utf-8'; body = JSON.stringify(params); }
    else for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, { method: post ? 'POST' : 'GET', headers, body });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      throw fail(`Slack limitó las consultas. Reintentá en ${wait}s.`, 'slack_rate_limited', 429);
    }
    const data = await res.json();
    if (!data.ok) {
      if (['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive'].includes(data.error)) {
        throw fail('Slack rechazó el token. Reinstalá la app y guardalo de nuevo en el Keychain.', 'slack_auth', 502);
      }
      throw fail(`Slack respondió ${data.error}.`, 'slack_failed', 502, { slackError: data.error });
    }
    return data;
  };

  let me = null;
  let workspace = '';
  const whoami = async () => {
    if (!me) { const a = await slack('auth.test'); me = a.user_id; workspace = String(a.url || '').replace(/\/+$/, ''); }
    return me;
  };
  const names = new Map();
  const userName = async (id) => {
    if (!id) return '';
    if (!names.has(id)) {
      names.set(id, slack('users.info', { user: id })
        .then((d) => d.user?.profile?.display_name || d.user?.real_name || d.user?.name || id).catch(() => id));
    }
    return names.get(id);
  };
  const readable = async (text) => {
    let out = String(text || '');
    for (const id of new Set([...out.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]))) {
      out = out.replaceAll(`<@${id}>`, `@${await userName(id)}`);
    }
    return out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:[^>]+)>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 400);
  };
  const search = async (query) => (await slack('search.messages', { query, sort: 'timestamp', sort_dir: 'desc', count: 100 })).messages?.matches || [];
  const replies = async (channel, ts, oldest) => (await slack('conversations.replies', { channel, ts, oldest, limit: 200 })).messages || [];

  const item = async (kind, match, msg, reason, threadTs) => {
    const channel = match.channel || {};
    const label = channel.is_im ? `DM · ${await userName(channel.user || msg.user)}` : channel.is_mpim ? 'Grupo' : `#${channel.name}`;
    return {
      id: `${channel.id}-${msg.ts}`, kind, channel: label, channelId: channel.id,
      author: await userName(msg.user), text: await readable(msg.text), ts: tsToIso(msg.ts),
      slackTs: msg.ts, threadTs: threadTs || msg.ts, threaded: Boolean(threadTs),
      permalink: threadTs && msg.ts !== threadTs
        ? `${workspace}/archives/${channel.id}/p${msg.ts.replace('.', '')}?thread_ts=${threadTs}&cid=${channel.id}`
        : `${workspace}/archives/${channel.id}/p${msg.ts.replace('.', '')}`,
      reason,
    };
  };

  // cheap check for notifications: messages to me / mentioning me newer than `since` (unix seconds)
  const recentSlack = async (since) => {
    const uid = await whoami();
    const day = new Date((since - 86_400) * 1000).toISOString().slice(0, 10);
    const [toMe, mentions] = await Promise.all([search(`to:<@${uid}> after:${day}`), search(`<@${uid}> after:${day}`)]);
    const fresh = [...new Map([...toMe, ...mentions].map((m) => [`${m.channel?.id}-${m.ts}`, m])).values()]
      .filter((m) => Number(m.ts) > since && m.user !== uid && !isBot(m));
    return Promise.all(fresh.slice(0, 10).map((m) => item(m.channel?.is_im ? 'dm' : 'mention', m, m,
      m.channel?.is_im ? 'Te escribió por DM' : 'Te mencionó', threadOf(m))));
  };

  const pendingSlack = async () => {
    const uid = await whoami();
    const after = new Date(now() - (LOOKBACK_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const [toMe, mentions, mine] = await Promise.all([
      search(`to:<@${uid}> after:${after}`), search(`<@${uid}> after:${after}`), search(`from:<@${uid}> after:${after}`),
    ]);
    const found = new Map();
    const add = (entry) => { if (entry && !found.has(entry.id)) found.set(entry.id, entry); };

    // DMs: pending when the latest message in the conversation is someone else's
    const dms = [...new Map(toMe.filter((m) => m.channel?.is_im || m.channel?.is_mpim).map((m) => [m.channel.id, m])).values()].slice(0, MAX_CHECKS);
    await mapPool(dms, 4, async (match) => {
      const last = (await slack('conversations.history', { channel: match.channel.id, limit: 1 })).messages?.[0];
      if (!last || last.user === uid || isBot(last)) return;
      add(await item('dm', match, last, 'Último mensaje del DM sin respuesta tuya', last.thread_ts && last.thread_ts !== last.ts ? last.thread_ts : null));
    });

    // Mentions in channels: pending without a later message of mine in the same thread
    const channelMentions = mentions.filter((m) => !m.channel?.is_im && m.user !== uid).slice(0, MAX_CHECKS);
    await mapPool(channelMentions, 4, async (match) => {
      const root = threadOf(match) || match.ts;
      const later = await replies(match.channel.id, root, match.ts).catch(() => []);
      if (later.some((m) => m.user === uid && Number(m.ts) > Number(match.ts))) return;
      add(await item('mention', match, match, 'Te mencionaron y no respondiste', threadOf(match)));
    });

    // Threads where I wrote: pending when someone else replied after me
    const threads = [...new Map(mine.filter((m) => threadOf(m) && !m.channel?.is_im)
      .map((m) => [`${m.channel.id}:${threadOf(m)}`, m])).values()].slice(0, MAX_CHECKS);
    await mapPool(threads, 4, async (match) => {
      const msgs = await replies(match.channel.id, threadOf(match)).catch(() => []);
      const last = msgs[msgs.length - 1];
      if (!last || last.user === uid || isBot(last)) return;
      add(await item('thread', match, last, 'Respondieron en un hilo donde participaste', threadOf(match)));
    });

    return [...found.values()].sort((a, b) => Number(b.slackTs) - Number(a.slackTs));
  };

  const sendSlack = async ({ channelId, threadTs, text }) => {
    const data = await slack('chat.postMessage', { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, { post: true });
    const link = await slack('chat.getPermalink', { channel: channelId, message_ts: data.ts }).then((d) => d.permalink).catch(() => '');
    return { ts: data.ts, link };
  };

  // after (un)linking a token: drop cached secrets and identities
  const forget = () => { secrets.clear(); me = null; workspace = ''; myself = undefined; };

  return {
    has,
    forget,
    jira: { search: searchJira, nextSprint, boardLayout, assignLanes, issue: getIssue, me: jiraMe, recentComments, comment: commentJira, transitions: jiraTransitions, transition: transitionJira },
    slack: { pending: pendingSlack, send: sendSlack, recent: recentSlack },
  };
};
