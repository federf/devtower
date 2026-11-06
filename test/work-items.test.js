import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkItems } from '../work-items.js';

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trama-works-'));
  const file = path.join(root, 'data', 'work-items.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const threads = new Map(['first', 'second'].map((id) => [id,
    { id, title: `Thread ${id}`, cwd: `/projects/${id}`, project: id }]));
  const options = { file, resolveThread: async (id) => threads.get(id), now: () => Date.UTC(2026, 9, 16) };
  return { file, threads, store: createWorkItems(options), options };
};
const body = (changes = {}) => ({ title: 'Fix callbacks', projects: ['/projects/first'],
  links: ['https://example.test/ticket/1'], notes: 'Validation done', nextStep: 'Run local checks',
  threadIds: ['first'], ...changes });

test('creates and persists work independently from original threads', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.snapshot(), []);
  const item = await f.store.save(body());
  assert.equal(item.revision, 1);
  assert.equal(item.nextStep, 'Run local checks');
  assert.deepEqual(item.threads, [f.threads.get('first')]);
  f.threads.clear();
  assert.deepEqual(await createWorkItems(f.options).snapshot(), [item]);
  const updated = await f.store.save(body({ revision: 1, notes: 'Still available' }), item.id);
  assert.equal(updated.notes, 'Still available');
  assert.equal(updated.threads[0].title, 'Thread first');
});

test('links multiple projects and threads, deduplicates values, unlinks without deleting', async (t) => {
  const f = await fixture(t);
  const item = await f.store.save(body({ threadIds: ['first', 'second', 'first'], projects: ['a', 'a', 'b'] }));
  assert.equal(item.threads.length, 2);
  assert.deepEqual(item.projects, ['a', 'b']);
  const updated = await f.store.save(body({ threadIds: [], revision: 1 }), item.id);
  assert.equal(updated.threads.length, 0);
  assert.equal(f.threads.size, 2);
  assert.equal(updated.createdAt, item.createdAt);
});

test('optimistic revisions prevent silent overwrites between clients', async (t) => {
  const f = await fixture(t);
  const item = await f.store.save(body());
  const results = await Promise.allSettled([
    f.store.save(body({ revision: 1, notes: 'Tab A' }), item.id),
    f.store.save(body({ revision: 1, notes: 'Tab B' }), item.id),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.status, 409);
  assert.equal((await f.store.snapshot())[0].notes, 'Tab A');
  await assert.rejects(f.store.save(body(), item.id), { status: 409 });
});

test('validates fields, bounds, unsafe links and missing threads before writing', async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { title: ' ' }, { title: 'a'.repeat(201) }, { notes: null }, { notes: 'a'.repeat(20001) },
    { projects: 'not a list' }, { projects: Array(21).fill('a') }, { nextStep: 3 },
    { threadIds: ['../escape'] }, { threadIds: Array(31).fill('first') },
    { links: ['javascript:alert(1)'] }, { links: ['data:text/html,hi'] },
    { links: ['https://name:secret@example.test'] }, { links: ['not a URL'] },
  ]) await assert.rejects(f.store.save(body(changes)), { status: 400 });
  await assert.rejects(f.store.save(body({ threadIds: ['missing'] })), { status: 404 });
  await assert.rejects(f.store.save(body(), 'missing'), { status: 404 });
  assert.deepEqual(await f.store.snapshot(), []);
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
});

test('concurrent creates persist all work and failed writes leave previous file intact', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.store.save(body()), f.store.save(body({ title: 'Second' }))]);
  assert.equal((await f.store.snapshot()).length, 2);
  const before = await fs.readFile(f.file, 'utf8');
  await fs.mkdir(`${f.file}.tmp`);
  await assert.rejects(f.store.save(body()), { status: 500 });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  await fs.rmdir(`${f.file}.tmp`);
  await f.store.save(body());
  assert.equal((await f.store.snapshot()).length, 3);
});

test('corrupt local state fails closed instead of overwriting existing work', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  for (const raw of ['{bad', '{"version":2,"items":[]}', '{"version":1,"items":[{}]}']) {
    await fs.writeFile(f.file, raw);
    await assert.rejects(f.store.snapshot(), { status: 500 });
    await assert.rejects(f.store.save(body()), { status: 500 });
    assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
});
