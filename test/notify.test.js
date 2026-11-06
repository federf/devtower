import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotifier } from '../notify.js';

const setup = (prefs = {}) => {
  const store = {};
  const sent = [];
  const n = createNotifier({
    readJson: async (name, fallback) => structuredClone(store[name] ?? fallback),
    writeJson: async (name, data) => { store[name] = structuredClone(data); },
    prefs: () => prefs, send: async (title, body) => { sent.push(`${title} | ${body}`); }, now: () => Date.parse('2026-11-06T15:00:00Z'),
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
  await n.threads([{ id: 't1', running: true, title: 'Refactor', mtimeMs: 1 }]);
  assert.equal(sent.length, 0);
  await n.prs({ mine: [pr({ reviewDecision: 'CHANGES_REQUESTED', ci: 'FAILURE', updatedAt: 'b' })], toReview: [pr({ key: 'o/r#2', number: 2, author: 'bea' })] });
  await n.master([{ repo: 'o/r', branch: 'main', broken: true, head: { sha: 'abc', title: 'boom', url: 'u' } }]);
  await n.threads([{ id: 't1', running: false, title: 'Refactor', mtimeMs: 2 }]);
  assert.equal(sent.length, 5);
  const labels = (await n.list()).events.map((e) => e.label);
  assert.deepEqual(labels.sort(), ['CI en rojo', 'Claude terminó', 'Te pidieron cambios', 'Te pidieron review', 'main en rojo'].sort());
});

test('disabled sources and native off are respected; mark read', async () => {
  const { n, sent } = setup({ slack: false, native: false });
  const t0 = Math.floor(Date.parse('2026-11-06T15:00:00Z') / 1000);
  await n.slack([]);
  await n.slack([msg(t0 + 5)]);
  await n.threads([{ id: 't1', running: true, title: 'x', mtimeMs: 1 }]);
  await n.threads([{ id: 't1', running: false, title: 'x', mtimeMs: 2 }]);
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

test('no native notification while a devtower tab shows browser notifications', async () => {
  const store = {};
  const sent = [];
  let browser = true;
  const n = createNotifier({ readJson: async (k, f) => structuredClone(store[k] ?? f), writeJson: async (k, d) => { store[k] = structuredClone(d); },
    send: async (t) => { sent.push(t); }, browserActive: () => browser, now: () => Date.parse('2026-11-06T15:00:00Z') });
  const t0 = Math.floor(Date.parse('2026-11-06T15:00:00Z') / 1000);
  await n.slack([]);
  await n.slack([msg(t0 + 1)]);
  assert.equal(sent.length, 0);
  assert.equal((await n.list()).unread, 1, 'still listed for the bell and the tab');
  browser = false;
  await n.slack([msg(t0 + 1), msg(t0 + 2)]);
  assert.equal(sent.length, 1);
});
