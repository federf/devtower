import { execFile } from 'node:child_process';

// Notifications: detects what changed since the last check (Slack messages, Jira comments,
// PR reviews/CI, master, Claude threads that finished) and delivers it to the in-app list and,
// optionally, as a native macOS notification. The first run of each source only records what
// already exists, so installing devtower never floods you.

const MAX_EVENTS = 100;
const REPEAT_WINDOW = 6 * 3_600_000; // the same notice (source + label + title) at most once per window
const CLAUDE_IDLE = 3 * 60_000;      // a thread must be quiet this long to count as "waiting for you"
const TRANSIENT = new Set(['UNKNOWN', 'PENDING', 'EXPECTED', null, undefined]); // GitHub still computing
const DEFAULT_PREFS = { native: true, slack: true, jira: true, github: true, master: true, claude: true };

// Native notifications only through terminal-notifier (clicking opens the link). osascript is never
// used: macOS attributes its notifications to Script Editor, which opens when clicked.
export const nativeAvailable = () => new Promise((resolve) => execFile('/usr/bin/which', ['terminal-notifier'], (err) => resolve(!err)));
const nativeNotify = (title, body, url) => new Promise((resolve) => {
  execFile('terminal-notifier', ['-title', title, '-message', body, '-group', 'devtower', ...(url ? ['-open', url] : [])],
    { timeout: 5_000 }, () => resolve());
});

export const createNotifier = ({ readJson, writeJson, prefs = () => ({}), send = process.platform === 'darwin' ? nativeNotify : async () => {}, browserActive = () => false, now = () => Date.now() }) => {
  let state = null; // { seen: {...}, events: [...] }
  let queue = Promise.resolve();
  const load = async () => (state ??= await readJson('notifications.json', { seen: {}, events: [] }));
  const save = () => writeJson('notifications.json', state);
  const on = (source) => ({ ...DEFAULT_PREFS, ...prefs() })[source] !== false;

  const emit = async (events) => {
    if (!events.length) return;
    const fresh = events.map((e) => ({ ...e, id: `${e.source}:${e.key}`, at: e.at || new Date(now()).toISOString(), read: false }));
    const known = new Set(state.events.map((e) => e.id));
    const recent = new Set(state.events.filter((e) => now() - Date.parse(e.at) < REPEAT_WINDOW).map((e) => `${e.source}|${e.label}|${e.title}`));
    const added = fresh.filter((e) => !known.has(e.id) && !recent.has(`${e.source}|${e.label}|${e.title}`));
    if (!added.length) return;
    state.events = [...added, ...state.events].slice(0, MAX_EVENTS);
    if (!on('native') || browserActive()) return;
    // a burst becomes one native notification
    if (added.length > 3) await send('devtower', `${added.length} novedades: ${[...new Set(added.map((e) => e.label))].join(', ')}`);
    else for (const e of added) await send(`devtower · ${e.label}`, `${e.title}${e.body ? ` — ${e.body}` : ''}`, e.url);
  };

  // serialize checks so two sources never write the state at the same time
  const run = (fn) => (queue = queue.then(async () => { await load(); await fn(); await save(); }).catch((error) => console.error('notify:', error.message)));

  const slack = (messages) => run(async () => {
    const seen = state.seen.slack;
    state.seen.slack = Math.max(seen || 0, ...messages.map((m) => Number(m.slackTs) || 0), Math.floor(now() / 1000) - 600);
    if (seen === undefined || !on('slack')) return;
    await emit(messages.filter((m) => Number(m.slackTs) > seen).map((m) => ({
      source: 'slack', key: m.id, label: 'Slack', title: `${m.author} · ${m.channel}`, body: m.text.slice(0, 160), url: m.permalink, view: 'slack', urgent: m.kind !== 'dm',
    })));
  });

  const jira = (comments) => run(async () => {
    const seen = new Set(state.seen.jira || []);
    const first = !state.seen.jira;
    state.seen.jira = [...new Set([...comments.map((c) => c.id), ...seen])].slice(0, 300);
    if (first || !on('jira')) return;
    await emit(comments.filter((c) => !seen.has(c.id)).map((c) => ({
      source: 'jira', key: c.id, label: c.mentionsMe ? 'Jira · te mencionaron' : 'Jira', title: `${c.key} · ${c.author}`, body: c.text.slice(0, 160), url: c.url, view: 'tasks', urgent: c.mentionsMe,
    })));
  });

  // PRs: compare with the previous snapshot of each PR
  const prs = (data) => run(async () => {
    if (!data) return;
    const prev = state.seen.prs;
    const snap = {};
    const events = [];
    for (const p of data.mine) {
      const was = prev?.[p.key];
      const keep = (now, before) => (TRANSIENT.has(now) && before !== undefined ? before : now);
      snap[p.key] = { d: p.reviewDecision, u: p.unresolved, ci: keep(p.ci, was?.ci), m: keep(p.mergeable, was?.m) };
      if (!was) continue;
      const base = { source: 'github', url: p.url, view: 'prs', title: `${p.repoName}#${p.number}`, body: p.title };
      if (p.reviewDecision === 'CHANGES_REQUESTED' && was.d !== 'CHANGES_REQUESTED') events.push({ ...base, key: `${p.key}:changes:${p.updatedAt}`, label: 'Te pidieron cambios', urgent: true });
      else if (p.unresolved > (was.u || 0)) events.push({ ...base, key: `${p.key}:comments:${p.unresolved}:${p.updatedAt}`, label: `${p.unresolved - (was.u || 0)} comentario(s) nuevo(s) en tu PR`, urgent: true });
      if (['FAILURE', 'ERROR'].includes(p.ci) && was.ci === 'SUCCESS') events.push({ ...base, key: `${p.key}:ci:${p.updatedAt}`, label: 'CI en rojo', body: `${p.title}${p.checks?.find((c) => c.state === 'fail') ? ` · ✗ ${p.checks.find((c) => c.state === 'fail').name}` : ''}`, urgent: true });
      if (p.mergeable === 'CONFLICTING' && was.m === 'MERGEABLE') events.push({ ...base, key: `${p.key}:conflict:${p.updatedAt}`, label: 'Conflicto con la base' });
      if (p.reviewDecision === 'APPROVED' && was.d && was.d !== 'APPROVED') events.push({ ...base, key: `${p.key}:approved`, label: 'PR aprobado' });
    }
    for (const p of data.toReview) {
      snap[`review:${p.key}`] = 1;
      if (prev && !prev[`review:${p.key}`]) events.push({ source: 'github', key: `${p.key}:review`, label: 'Te pidieron review', title: `${p.repoName}#${p.number} · @${p.author}`, body: p.title, url: p.url, view: 'prs' });
    }
    state.seen.prs = snap;
    if (prev && on('github')) await emit(events);
  });

  const master = (repos) => run(async () => {
    const prev = state.seen.master;
    state.seen.master = Object.fromEntries(repos.map((r) => [r.repo, r.broken]));
    if (!prev || !on('master')) return;
    await emit(repos.filter((r) => r.broken && prev[r.repo] === false).map((r) => ({
      source: 'master', key: `${r.repo}:${r.head?.sha}`, label: `${r.branch} en rojo`, title: r.repo, body: r.head?.title || '', url: r.head?.url, view: 'prs', urgent: true,
    })));
  });

  // a Claude thread is waiting for you once per turn: you sent a new message (prompt count grew)
  // and the thread has been quiet for a while. File activity flaps, so "running" is not used.
  const threads = (list) => run(async () => {
    const first = !state.seen.turns;
    const turns = state.seen.turns || {};
    const due = [];
    for (const t of list) {
      const notified = turns[t.id];
      if (first || notified === undefined) { turns[t.id] = t.prompts; continue; }
      const quiet = !t.running && now() - t.mtimeMs >= CLAUDE_IDLE;
      if (quiet && t.prompts > notified) { turns[t.id] = t.prompts; due.push(t); }
    }
    state.seen.turns = Object.fromEntries(Object.entries(turns).slice(-500));
    delete state.seen.running;
    if (first || !on('claude')) return;
    await emit(due.map((t) => ({
      source: 'claude', key: `${t.id}:${t.prompts}`, label: 'Claude terminó', title: t.title.slice(0, 80), body: t.project || '', view: 'threads', thread: t.id,
    })));
  });

  const list = async () => { await load(); return { events: state.events, unread: state.events.filter((e) => !e.read).length }; };
  const markRead = (ids) => run(async () => { state.events.forEach((e) => { if (ids === 'all' || ids.includes(e.id)) e.read = true; }); });
  const test = async () => {
    if (!(await nativeAvailable())) return { native: false };
    await send('devtower · prueba', 'Las notificaciones funcionan.');
    return { native: true };
  };

  return { slack, jira, prs, master, threads, list, markRead, test };
};
