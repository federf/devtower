import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotifier } from '../notify.js';

const setup = (prefs = {}) => {
  const store = {};
  const sent = [];
  const n = createNotifier({
    readJson: async (name, fallback) => structuredClone(store[name] ?? fallback),
    writeJson: async (name, data) => { store[name] = structuredClone(data); },
    prefs: () => prefs, native: async () => true, send: async (title, body) => { sent.push(`${title} | ${body}`); }, now: () => Date.parse('2026-11-06T15:00:00Z'),
  });
  return { n, sent };
};
const msg = (ts, extra = {}) => ({ id: `C1-${ts}`, slackTs: String(ts), author: 'Ana', channel: '#dev', text: 'hola', permalink: 'https://x', kind: 'mention', ...extra });
const pr = (extra = {}) => ({ key: 'o/r#1', repoName: 'r', number: 1, title: 'Fix', url: 'https://gh/1', reviewDecision: 'REVIEW_REQUIRED', unresolved: 0, ci: 'SUCCESS', mergeable: 'MERGEABLE', updatedAt: 'a', checks: [], ...extra });

test('first run records without notifying; later only new things notify', async () => {
  const { n, sent } = setup();
  const t0 = Math.floor(Date.parse('2026-11-06T15:00:00Z') / 1000);
  await n.slack([msg(t0 - 100)]);
  await n.jira([{ id: '1', key: 'AB-1', author: 'Ana', text: 'viejo', url: 'u', mentionsMe: true }]);
  assert.equal(sent.length, 0);
  await n.slack([msg(t0 - 100), msg(t0 + 5, { text: 'nuevo' })]);
  await n.jira([{ id: '1', key: 'AB-1', author: 'Ana', text: 'viejo', url: 'u' }, { id: '2', key: 'AB-1', author: 'Bea', text: 'te mencioné', url: 'u', mentionsMe: true }]);
  assert.deepEqual(sent, ['devtower · Slack | Ana · #dev — nuevo', 'devtower · Jira · te mencionaron | AB-1 · Bea — te mencioné']);
  const { events, unread } = await n.list();
  assert.equal(unread, 2);
  assert.equal(events[0].source, 'jira');
});

test('PR, master and Claude thread transitions', async () => {
  const { n, sent } = setup();
  await n.prs({ mine: [pr()], toReview: [] });
  await n.master([{ repo: 'o/r', branch: 'main', broken: false }]);
  const T = Date.parse('2026-11-06T15:00:00Z');
  await n.threads([{ id: 't1', running: true, title: 'Refactor', mtimeMs: T, prompts: 3 }]);
  assert.equal(sent.length, 0);
  await n.prs({ mine: [pr({ reviewDecision: 'CHANGES_REQUESTED', ci: 'FAILURE', updatedAt: 'b' })], toReview: [pr({ key: 'o/r#2', number: 2, author: 'bea' })] });
  await n.master([{ repo: 'o/r', branch: 'main', broken: true, head: { sha: 'abc', title: 'boom', url: 'u' } }]);
  await n.threads([{ id: 't1', running: false, title: 'Refactor', mtimeMs: T - 5 * 60_000, prompts: 4 }]);
  assert.equal(sent.length, 5);
  const labels = (await n.list()).events.map((e) => e.label);
  assert.deepEqual(labels.sort(), ['CI en rojo', 'Claude terminó', 'Te pidieron cambios', 'Te pidieron review', 'main en rojo'].sort());
});

test('disabled sources and native off are respected; mark read', async () => {
  const { n, sent } = setup({ slack: false, native: false });
  const t0 = Math.floor(Date.parse('2026-11-06T15:00:00Z') / 1000);
  await n.slack([]);
  await n.slack([msg(t0 + 5)]);
  await n.threads([{ id: 't1', running: true, title: 'x', mtimeMs: 1, prompts: 1 }]);
  await n.threads([{ id: 't1', running: false, title: 'x', mtimeMs: 2, prompts: 2 }]);
  assert.equal(sent.length, 0);
  const before = await n.list();
  assert.deepEqual(before.events.map((e) => e.source), ['claude']);
  await n.markRead('all');
  assert.equal((await n.list()).unread, 0);
});

test('a burst from one source becomes a single native notification', async () => {
  const { n, sent } = setup();
  const t0 = Math.floor(Date.parse('2026-11-06T15:00:00Z') / 1000);
  await n.slack([]);
  await n.slack([1, 2, 3, 4, 5].map((i) => msg(t0 + i)));
  assert.deepEqual(sent, ['devtower | 5 novedades: Slack']);
  assert.equal((await n.list()).unread, 5);
});

test('native notifications go out whenever allowed; when blocked the list tells the browser tab to show them', async () => {
  const store = {};
  const sent = [];
  let allowed = false;
  let clock = Date.parse('2026-11-06T15:00:00Z');
  const n = createNotifier({ readJson: async (k, f) => structuredClone(store[k] ?? f), writeJson: async (k, d) => { store[k] = structuredClone(d); },
    native: async () => allowed, send: async (t, b, url, group) => { sent.push({ t, url, group }); }, appUrl: 'http://localhost:4317', now: () => clock });
  const t0 = Math.floor(clock / 1000);
  await n.slack([]);
  await n.slack([msg(t0 + 1)]);
  assert.equal(sent.length, 0);
  assert.equal((await n.list()).native, false, 'browser tab falls back');
  allowed = true;
  clock += 2 * 60_000; // permission granted later is picked up without a restart
  assert.equal((await n.list()).native, true);
  await n.slack([msg(t0 + 1), msg(t0 + 2, { author: 'Bea' })]);
  await n.threads([{ id: 'th1', running: false, title: 'x', mtimeMs: clock, prompts: 1 }]);
  await n.threads([{ id: 'th1', running: false, title: 'x', mtimeMs: clock - 4 * 60_000, prompts: 2 }]);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].group, sent[1].group, 'each notice keeps its own group so they stack');
  assert.equal(sent[1].url, 'http://localhost:4317/#thread=th1', 'a finished thread opens in devtower');
});

test('no spam: flapping threads, transient GitHub states and repeats within 6 h stay silent', async () => {
  const { n, sent } = setup();
  const T = Date.parse('2026-11-06T15:00:00Z');
  // a thread that keeps flipping running/idle without a new message from you
  await n.threads([{ id: 't', running: true, title: 'x', mtimeMs: T, prompts: 5 }]);
  for (const running of [false, true, false, true, false]) await n.threads([{ id: 't', running, title: 'x', mtimeMs: T - 10 * 60_000, prompts: 5 }]);
  // your new message and the answer: exactly one notice, never again for that turn
  await n.threads([{ id: 't', running: false, title: 'x', mtimeMs: T - 60_000, prompts: 6 }]);
  assert.equal(sent.length, 0, 'not quiet long enough yet');
  await n.threads([{ id: 't', running: false, title: 'x', mtimeMs: T - 4 * 60_000, prompts: 6 }]);
  await n.threads([{ id: 't', running: false, title: 'x', mtimeMs: T - 8 * 60_000, prompts: 6 }]);
  assert.equal(sent.length, 1);
  // a PR that was already conflicting flaps through UNKNOWN: no notice
  await n.prs({ mine: [pr({ mergeable: 'CONFLICTING' })], toReview: [] });
  for (const m of ['UNKNOWN', 'CONFLICTING', 'UNKNOWN', 'CONFLICTING']) await n.prs({ mine: [pr({ mergeable: m, updatedAt: m + Math.random() })], toReview: [] });
  // CI re-run: green → running → red notifies once; red → running → red does not
  await n.prs({ mine: [pr({ ci: 'SUCCESS' })], toReview: [] });
  for (const ci of ['PENDING', 'FAILURE', 'PENDING', 'FAILURE']) await n.prs({ mine: [pr({ ci, updatedAt: ci + Math.random() })], toReview: [] });
  assert.deepEqual((await n.list()).events.map((e) => e.label).sort(), ['CI en rojo', 'Claude terminó']);
});
