import assert from 'node:assert/strict';
import test from 'node:test';
import { createClockify } from '../clockify.js';

const NOW = Date.parse('2026-11-06T15:00:00Z');
const entry = (description, start, hours, extra = {}) => ({
  id: `e${Math.random()}`, description, projectId: extra.projectId || 'p1', project: { name: extra.project || 'Tarea' },
  tagIds: extra.tagIds || [], tags: (extra.tags || []).map((name) => ({ name })),
  timeInterval: { start, end: hours === null ? null : new Date(Date.parse(start) + hours * 3_600_000).toISOString() },
});
const setup = ({ entries = [], running = [], tags = [] } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, search: u.search, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (u.pathname.endsWith('/user')) return json({ id: 'u1', activeWorkspace: 'w1' });
    if (u.pathname.endsWith('/tags')) return json(tags);
    if (u.pathname.endsWith('/user/u1/time-entries') && init.method === 'PATCH') return json({});
    if (u.pathname.endsWith('/user/u1/time-entries')) return json(u.searchParams.get('in-progress') ? running : entries);
    if (u.pathname.endsWith('/w1/time-entries') && init.method === 'POST') return json({ id: 'new', ...JSON.parse(init.body), timeInterval: { start: JSON.parse(init.body).start } }, 201);
    throw new Error(`unexpected ${u.pathname}`);
  };
  const api = createClockify({ readSecret: async () => ({ password: 'key' }), ticketPattern: 'AB-\\d+', fetchImpl, now: () => NOW });
  return { api, calls };
};

test('recurring blocks: repeated non-ticket entries, most frequent first; today total', async () => {
  const { api } = setup({ entries: [
    entry('daily', '2026-11-06T12:00:00Z', 0.25, { project: 'Meeting' }), entry('daily', '2026-11-05T12:00:00Z', 0.25, { project: 'Meeting' }),
    entry('pull reviews', '2026-11-06T13:00:00Z', 1), entry('pull reviews', '2026-11-04T13:00:00Z', 1), entry('pull reviews', '2026-11-03T13:00:00Z', 1),
    entry('[AB-1]: ticket', '2026-11-06T10:00:00Z', 2), entry('[AB-1]: ticket', '2026-11-05T10:00:00Z', 2), entry('once', '2026-11-01T10:00:00Z', 1),
  ] });
  const s = await api.status();
  assert.deepEqual(s.blocks.map((b) => [b.description, b.count]), [['pull reviews', 3], ['daily', 2]]);
  assert.equal(s.running, null);
  assert.equal(s.todayHours, 3.25);
});

test('task timer reuses the last entry of that ticket, otherwise the usual project and matching tags', async () => {
  const { api } = setup({
    entries: [entry('[AB-7]: Old summary', '2026-11-05T10:00:00Z', 1, { projectId: 'pX', tagIds: ['t9'] }), entry('[AB-2]: x', '2026-11-04T10:00:00Z', 1, { projectId: 'pY' })],
    tags: [{ id: 't1', name: 'Error' }, { id: 't2', name: 'jira_escalated' }, { id: 't3', name: 'Otra' }],
  });
  assert.deepEqual(await api.taskEntry({ key: 'AB-7', summary: 'New', type: 'Tarea' }), { description: '[AB-7]: Old summary', projectId: 'pX', tagIds: ['t9'], billable: false });
  const fresh = await api.taskEntry({ key: 'AB-8', summary: 'Nueva', type: 'Error', labels: ['jira_escalated'] });
  assert.equal(fresh.description, '[AB-8]: Nueva');
  assert.deepEqual(fresh.tagIds, ['t1', 't2']);
});

test('starting a timer stops the running one first', async () => {
  const { api, calls } = setup({ running: [entry('daily', '2026-11-06T14:00:00Z', null)] });
  const started = await api.start({ description: 'pull reviews', projectId: 'p1' });
  const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.method);
  assert.deepEqual(writes, ['PATCH', 'POST']);
  assert.equal(started.description, 'pull reviews');
});
