import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Notifications: detects what changed since the last check (Slack messages, Jira comments,
// PR reviews/CI, master, Claude threads that finished) and delivers it to the in-app list and,
// as a native macOS notification (the browser tab only shows them when native ones can't). The first run of each source only records what
// already exists, so installing devtower never floods you.

const MAX_EVENTS = 100;
const REPEAT_WINDOW = 6 * 3_600_000; // the same notice (source + label + title) at most once per window
const CLAUDE_IDLE = 3 * 60_000;      // a thread must be quiet this long to count as "waiting for you"
const TRANSIENT = new Set(['UNKNOWN', 'PENDING', 'EXPECTED', null, undefined]); // GitHub still computing
const DEFAULT_PREFS = { native: true, slack: true, jira: true, github: true, master: true, claude: true, slackNative: false };

// Native notifications through devtower-notifier, a tiny Swift app built from native/notifier with
// `npm run notifier` (no packages). It shows up as "devtower" and clicking opens the link.
// osascript is never used: macOS attributes its notifications to Script Editor, which opens when clicked.
const NOTIFIER_APP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build', 'devtower-notifier.app');
const NOTIFIER_BIN = path.join(NOTIFIER_APP, 'Contents', 'MacOS', 'devtower-notifier');
const run = (bin, args, timeout = 5_000) => new Promise((resolve) => execFile(bin, args, { timeout }, (err, stdout = '') => resolve({ err, stdout })));
// built and not blocked in System Settings > Notifications (notDetermined: the first notice asks)
export const nativeAvailable = async () => {
  if (!fs.existsSync(NOTIFIER_BIN)) return false;
  const { err, stdout } = await run(NOTIFIER_BIN, ['status']);
  return !err && stdout.trim() !== 'denied';
};
// launched through LaunchServices (open), otherwise macOS never shows the permission prompt;
// -g keeps focus where you are. One group per notice so they stack instead of replacing each other.
const nativeNotify = async (title, body, url, group = 'devtower', sound = false) => {
  if (!fs.existsSync(NOTIFIER_BIN)) return false;
  const { err } = await run('/usr/bin/open', ['-g', '-n', '-W', NOTIFIER_APP, '--args', 'notify', '--title', title, '--message', body, '--group', group,
    ...(url ? ['--url', url] : []), ...(sound ? ['--sound'] : [])], 60_000);
  return !err && (await nativeAvailable());
};

export const createNotifier = ({ readJson, writeJson, prefs = () => ({}), send = process.platform === 'darwin' ? nativeNotify : async () => false, native = process.platform === 'darwin' ? nativeAvailable : async () => false, appUrl = '', now = () => Date.now() }) => {
  let state = null; // { seen: {...}, events: [...] }
  let queue = Promise.resolve();
  let nativeOk = null; // null until checked; the browser tab only shows notices when this is false
  let checkedAt = 0;
  const checkNative = async () => { checkedAt = now(); return (nativeOk = await native()); };
  const NATIVE_RECHECK = 60_000; // picks up a permission granted in System Settings
  // events without their own link (Claude threads) open devtower on the right thread or view
  const link = (e) => e.url || (appUrl ? `${appUrl}/#${e.thread ? `thread=${encodeURIComponent(e.thread)}` : `view=${e.view || ''}`}` : undefined);
  const load = async () => (state ??= await readJson('notifications.json', { seen: {}, events: [] }));
  const save = () => writeJson('notifications.json', state);
  const on = (source) => ({ ...DEFAULT_PREFS, ...prefs() })[source] !== false;

  const emit = async (events) => {
    if (!events.length) return;
    // quiet: solo en 🔔, sin aviso de escritorio (Slack ya avisa por su cuenta)
    const fresh = events.map((e) => ({ ...e, id: `${e.source}:${e.key}`, at: e.at || new Date(now()).toISOString(), read: false, ...(e.source === 'slack' && !on('slackNative') ? { quiet: true } : {}) }));
    const known = new Set(state.events.map((e) => e.id));
    const recent = new Set(state.events.filter((e) => now() - Date.parse(e.at) < REPEAT_WINDOW).map((e) => `${e.source}|${e.label}|${e.title}`));
    const added = fresh.filter((e) => !known.has(e.id) && !recent.has(`${e.source}|${e.label}|${e.title}`));
    if (!added.length) return;
    state.events = [...added, ...state.events].slice(0, MAX_EVENTS);
    const loud = added.filter((e) => !e.quiet);
    if (!loud.length || !on('native')) return;
    if (nativeOk === null || (!nativeOk && now() - checkedAt > NATIVE_RECHECK)) await checkNative();
    if (!nativeOk) return;
    // a burst becomes one native notification
    const results = loud.length > 3
      ? [await send('devtower', `${loud.length} novedades: ${[...new Set(loud.map((e) => e.label))].join(', ')}`, appUrl || undefined, 'devtower-burst', loud.some((e) => e.urgent))]
      : await Promise.all(loud.map((e) => send(`devtower · ${e.label}`, `${e.title}${e.body ? ` — ${e.body}` : ''}`, link(e), e.id, Boolean(e.urgent))));
    if (results.includes(false)) await checkNative(); // permission revoked or binary removed
  };

  // serialize checks so two sources never write the state at the same time
  const run = (fn) => (queue = queue.then(async () => { await load(); await fn(); await save(); }).catch((error) => console.error('notify:', error.message)));

  const slack = (messages) => run(async () => {
    const seen = state.seen.slack;
    state.seen.slack = Math.max(seen || 0, ...messages.map((m) => Number(m.slackTs) || 0), Math.floor(now() / 1000) - 600);
    if (seen === undefined || !on('slack')) return;
    // una notificación por persona: mientras siga sin leer, los mensajes nuevos se suman a la misma
    const fresh = [];
    for (const m of messages.filter((x) => Number(x.slackTs) > seen).sort((x, y) => Number(x.slackTs) - Number(y.slackTs))) {
      const group = m.author || m.channel;
      const open = state.events.find((e) => e.source === 'slack' && !e.read && e.group === group) || fresh.find((e) => e.group === group);
      const body = `${m.author ? `${m.channel}: ` : ''}${m.text.slice(0, 160)}`;
      if (open) {
        open.count = (open.count || 1) + 1;
        Object.assign(open, { label: `Slack · ${open.count} mensajes`, body, url: m.permalink, urgent: open.urgent || m.kind !== 'dm' });
        if (!fresh.includes(open)) { open.at = new Date(now()).toISOString(); state.events = [open, ...state.events.filter((e) => e !== open)]; }
        continue;
      }
      fresh.push({ source: 'slack', key: m.id, group, count: 1, label: 'Slack', title: m.author || m.channel, body, url: m.permalink, view: 'slack', urgent: m.kind !== 'dm' });
    }
    await emit(fresh);
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

  const list = async () => {
    await load();
    if (nativeOk === null || now() - checkedAt > NATIVE_RECHECK) await checkNative();
    return { events: state.events, unread: state.events.filter((e) => !e.read).length, native: on('native') && nativeOk };
  };
  const markRead = (ids) => run(async () => { state.events.forEach((e) => { if (ids === 'all' || ids.includes(e.id)) e.read = true; }); });
  const test = async () => {
    if (!(await checkNative())) return { native: false };
    return { native: (await send('devtower · prueba', 'Las notificaciones funcionan.', appUrl || undefined, 'devtower-test', true)) !== false };
  };

  return { slack, jira, prs, master, threads, list, markRead, test };
};
