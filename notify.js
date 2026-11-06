import { execFile } from 'node:child_process';

// Notifications: detects what changed since the last check (Slack messages, Jira comments,
// PR reviews/CI, master, Claude threads that finished) and delivers it to the in-app list and,
// optionally, as a native macOS notification. The first run of each source only records what
// already exists, so installing devtower never floods you.

const MAX_EVENTS = 100;
const DEFAULT_PREFS = { native: true, slack: true, jira: true, github: true, master: true, claude: true };

const nativeNotify = (title, body, url) => new Promise((resolve) => {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
  // terminal-notifier (if installed) opens the link when clicked; osascript always works
  execFile('terminal-notifier', ['-title', title, '-message', body, '-group', 'devtower', ...(url ? ['-open', url] : [])], { timeout: 5_000 }, (err) => {
    if (!err) return resolve();
    execFile('/usr/bin/osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], { timeout: 5_000 }, () => resolve());
  });
});

export const createNotifier = ({ readJson, writeJson, prefs = () => ({}), send = process.platform === 'darwin' ? nativeNotify : async () => {}, now = () => Date.now() }) => {
  let state = null; // { seen: {...}, events: [...] }
  let queue = Promise.resolve();
  const load = async () => (state ??= await readJson('notifications.json', { seen: {}, events: [] }));
  const save = () => writeJson('notifications.json', state);
  const on = (source) => ({ ...DEFAULT_PREFS, ...prefs() })[source] !== false;

  const emit = async (events) => {
    if (!events.length) return;
    const fresh = events.map((e) => ({ ...e, id: `${e.source}:${e.key}`, at: e.at || new Date(now()).toISOString(), read: false }));
    const known = new Set(state.events.map((e) => e.id));
    const added = fresh.filter((e) => !known.has(e.id));
    state.events = [...added, ...state.events].slice(0, MAX_EVENTS);
    if (!on('native')) return;
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
      snap[p.key] = { d: p.reviewDecision, u: p.unresolved, ci: p.ci, m: p.mergeable };
      const was = prev?.[p.key];
      if (!was) continue;
      const base = { source: 'github', url: p.url, view: 'prs', title: `${p.repoName}#${p.number}`, body: p.title };
      if (p.reviewDecision === 'CHANGES_REQUESTED' && was.d !== 'CHANGES_REQUESTED') events.push({ ...base, key: `${p.key}:changes:${p.updatedAt}`, label: 'Te pidieron cambios', urgent: true });
      else if (p.unresolved > (was.u || 0)) events.push({ ...base, key: `${p.key}:comments:${p.unresolved}:${p.updatedAt}`, label: `${p.unresolved - (was.u || 0)} comentario(s) nuevo(s) en tu PR`, urgent: true });
      if (['FAILURE', 'ERROR'].includes(p.ci) && !['FAILURE', 'ERROR'].includes(was.ci)) events.push({ ...base, key: `${p.key}:ci:${p.updatedAt}`, label: 'CI en rojo', body: `${p.title}${p.checks?.find((c) => c.state === 'fail') ? ` · ✗ ${p.checks.find((c) => c.state === 'fail').name}` : ''}`, urgent: true });
      if (p.mergeable === 'CONFLICTING' && was.m !== 'CONFLICTING') events.push({ ...base, key: `${p.key}:conflict:${p.updatedAt}`, label: 'Conflicto con la base' });
      if (p.reviewDecision === 'APPROVED' && was.d !== 'APPROVED') events.push({ ...base, key: `${p.key}:approved`, label: 'PR aprobado' });
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

  // a Claude thread that was running and stopped is waiting for you
  const threads = (list) => run(async () => {
    const prev = new Set(state.seen.running || []);
    const nowRunning = list.filter((t) => t.running).map((t) => t.id);
    const first = !state.seen.running;
    state.seen.running = nowRunning;
    if (first || !on('claude')) return;
    await emit(list.filter((t) => prev.has(t.id) && !t.running).map((t) => ({
      source: 'claude', key: `${t.id}:${t.mtimeMs}`, label: 'Claude terminó', title: t.title.slice(0, 80), body: t.project || '', view: 'threads', thread: t.id,
    })));
  });

  const list = async () => { await load(); return { events: state.events, unread: state.events.filter((e) => !e.read).length }; };
  const markRead = (ids) => run(async () => { state.events.forEach((e) => { if (ids === 'all' || ids.includes(e.id)) e.read = true; }); });
  const test = () => send('devtower · prueba', 'Las notificaciones funcionan.');

  return { slack, jira, prs, master, threads, list, markRead, test };
};
