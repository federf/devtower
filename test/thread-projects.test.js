import assert from 'node:assert/strict';
import test from 'node:test';
import { groupThreadProjects, isWorktree, startWorkspaces, threadProject, workspaceOf } from '../public/thread-projects.js';

test('groups threads by project directory with counts and activity', () => {
  const groups = groupThreadProjects([
    { cwd: '/projects/app', project: 'app', mtimeMs: 10, running: true },
    { cwd: '/projects/app', project: 'app', mtimeMs: 20 },
    { cwd: '/projects/manage', project: 'manage', mtimeMs: 5 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { key: 'cwd:/projects/app', name: 'app', directory: '/projects/app',
    count: 2, running: 1, updatedAt: 20 });
});

test('same basename in different directories remains in separate tabs', () => {
  const groups = groupThreadProjects([
    { cwd: '/work/client/app', project: 'app' }, { cwd: '/work/personal/app', project: 'app' },
  ]);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
});

test('normalizes trailing slashes while preserving the root directory', () => {
  assert.equal(threadProject({ cwd: '/projects/app/' }).key, threadProject({ cwd: '/projects/app' }).key);
  assert.equal(threadProject({ cwd: '/' }).key, 'cwd:/');
  assert.equal(threadProject({ cwd: '   ' }).key, 'project:Sin proyecto');
});

test('falls back to directory basename, known project name or Sin proyecto', () => {
  assert.equal(threadProject({ cwd: '/projects/example' }).name, 'example');
  assert.equal(threadProject({ project: 'example' }).key, 'project:example');
  assert.equal(threadProject({}).name, 'Sin proyecto');
});

test('orders projects by most recent activity with safe invalid timestamps', () => {
  const groups = groupThreadProjects([
    { project: 'old', updatedAt: '2026-01-01T00:00:00Z' },
    { project: 'invalid', updatedAt: 'not a date' },
    { project: 'new', updatedAt: '2026-10-16T00:00:00Z' },
  ]);
  assert.deepEqual(groups.map((group) => group.name), ['new', 'old', 'invalid']);
});

test('does not mutate source records or input order', () => {
  const threads = Object.freeze([Object.freeze({ project: 'b', mtimeMs: 1 }), Object.freeze({ project: 'a', mtimeMs: 2 })]);
  groupThreadProjects(threads);
  assert.equal(threads[0].project, 'b');
});

test('empty input produces no project tabs', () => assert.deepEqual(groupThreadProjects([]), []));

test('start workspaces: repos and used folders first, worktrees folded into their repo', () => {
  const now = 100 * 86_400_000;
  const repo = '/p/picallex';
  const wt = (name, at) => ({ cwd: `${repo}/.claude/worktrees/${name}`, mtimeMs: at });
  const { main, worktrees } = startWorkspaces([
    { cwd: repo, mtimeMs: now - 50 }, wt('a-1', now - 10), wt('b-2', now - 20), wt('old-3', now - 30 * 86_400_000),
    { cwd: '/p/cumulus/', mtimeMs: now - 5 },
  ], ['/p/picallex', '/p/temporal'], { worktrees: 1, now });
  assert.deepEqual(main.map((w) => [w.name, w.count]), [['cumulus', 1], ['picallex', 4], ['temporal', 0]]);
  assert.deepEqual(worktrees.map((w) => [w.name, w.parent]), [['a-1', 'picallex']]);
  assert.equal(workspaceOf(`${repo}/.claude/worktrees/x`), repo);
  assert.ok(isWorktree(`${repo}/.claude/worktrees/x`) && !isWorktree(repo));
});
