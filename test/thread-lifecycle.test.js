import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createThreadLifecycle } from '../thread-lifecycle.js';

const fixture = async (t, options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-lifecycle-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'projects');
  const project = path.join(projectsDir, 'example');
  const stateFile = path.join(root, 'data', 'thread-state.json');
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, 'session-1.jsonl');
  await fs.writeFile(file, 'original transcript\n');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(file, old, old);
  const args = { projectsDir, stateFile, ...options };
  return { root, project, file, stateFile, lifecycle: createThreadLifecycle(args), args };
};
const status = (expected) => (error) => error.status === expected;

test('archive persists across instances and restore preserves the original transcript', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.change('session-1', 'archive')).status, 'archived');
  const restarted = createThreadLifecycle(f.args);
  assert.equal((await restarted.snapshot())['session-1'].status, 'archived');
  await assert.rejects(restarted.assertRunnable('session-1'), status(409));
  assert.equal((await restarted.change('session-1', 'restore')).status, 'active');
  assert.deepEqual(await restarted.snapshot(), {});
  await restarted.assertRunnable('session-1');
  assert.equal(await fs.readFile(f.file, 'utf8'), 'original transcript\n');
});

test('delete requires literal confirmation and never deletes on validation failure', async (t) => {
  const f = await fixture(t);
  for (const confirmed of [undefined, false, 'true', 1]) {
    await assert.rejects(f.lifecycle.change('session-1', 'delete', confirmed), status(400));
  }
  assert.equal(await fs.readFile(f.file, 'utf8'), 'original transcript\n');
  assert.deepEqual(await f.lifecycle.snapshot(), {});
});

test('delete removes the original file, retains a tombstone and blocks resuming', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'untouched.jsonl'), 'other transcript');
  await f.lifecycle.change('session-1', 'archive');
  assert.equal((await f.lifecycle.change('session-1', 'delete', true)).status, 'deleted');
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  assert.equal((await f.lifecycle.snapshot())['session-1'].status, 'deleted');
  await assert.rejects(f.lifecycle.assertRunnable('session-1'), status(404));
  await assert.rejects(f.lifecycle.change('session-1', 'restore'), status(404));
  assert.equal(await fs.readFile(path.join(f.project, 'untouched.jsonl'), 'utf8'), 'other transcript');
});

test('running sessions cannot be archived or deleted', async (t) => {
  const f = await fixture(t, { isRunning: () => true });
  await assert.rejects(f.lifecycle.change('session-1', 'archive'), status(409));
  await assert.rejects(f.lifecycle.change('session-1', 'delete', true), status(409));
  assert.deepEqual(await f.lifecycle.snapshot(), {});
  await fs.access(f.file);
});

test('recent activity outside Cockpit also blocks archive and delete', async (t) => {
  const f = await fixture(t);
  await fs.utimes(f.file, new Date(), new Date());
  await assert.rejects(f.lifecycle.change('session-1', 'archive'), status(409));
  await assert.rejects(f.lifecycle.change('session-1', 'delete', true), status(409));
  await fs.access(f.file);
});

test('invalid IDs, actions, missing sessions and symlinks cannot delete arbitrary files', async (t) => {
  const f = await fixture(t);
  for (const id of ['../session-1', '/tmp/example', '', null, {}, 'a%2fb']) {
    await assert.rejects(f.lifecycle.change(id, 'delete', true), status(400));
  }
  await assert.rejects(f.lifecycle.change('session-1', 'invalid'), status(400));
  await assert.rejects(f.lifecycle.change('missing', 'delete', true), status(404));
  const outside = path.join(f.root, 'outside.jsonl');
  await fs.writeFile(outside, 'do not delete');
  await fs.symlink(outside, path.join(f.project, 'linked.jsonl'));
  await assert.rejects(f.lifecycle.change('linked', 'delete', true), status(400));
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not delete');
});

test('concurrent mutations on different threads preserve both updates', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.project, 'session-2.jsonl');
  await fs.copyFile(f.file, other);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(other, old, old);
  await Promise.all([f.lifecycle.change('session-1', 'archive'), f.lifecycle.change('session-2', 'archive')]);
  assert.deepEqual(Object.keys(await f.lifecycle.snapshot()).sort(), ['session-1', 'session-2']);
});

test('duplicate mutations and resuming during a mutation fail with conflict', async (t) => {
  const f = await fixture(t);
  const mutation = f.lifecycle.change('session-1', 'archive');
  await assert.rejects(f.lifecycle.change('session-1', 'delete', true), status(409));
  await assert.rejects(f.lifecycle.assertRunnable('session-1'), status(409));
  await mutation;
});

test('corrupt state fails closed without changing the transcript', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.stateFile), { recursive: true });
  for (const content of ['{broken', '{"version":1,"threads":[]}', '{"version":1,"threads":{"a":null}}']) {
    await fs.writeFile(f.stateFile, content);
    await assert.rejects(f.lifecycle.change('session-1', 'delete', true), status(500));
    assert.equal(await fs.readFile(f.file, 'utf8'), 'original transcript\n');
  }
});

test('state persistence failure never deletes the original', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(`${f.stateFile}.tmp`, { recursive: true });
  await assert.rejects(f.lifecycle.change('session-1', 'delete', true));
  await fs.access(f.file);
  assert.deepEqual(await f.lifecycle.snapshot(), {});
});
