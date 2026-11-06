export const threadProject = (thread) => {
  const cwd = typeof thread.cwd === 'string' ? thread.cwd.trim() : '';
  const directory = cwd ? cwd.replace(/\/+$/, '') || '/' : '';
  const name = thread.project || directory.split('/').filter(Boolean).at(-1) || 'Sin proyecto';
  return { key: directory ? `cwd:${directory}` : `project:${name}`, name, directory };
};

export const groupThreadProjects = (threads) => {
  const projects = new Map();
  for (const thread of threads) {
    const project = threadProject(thread);
    if (!projects.has(project.key)) projects.set(project.key, { ...project, count: 0, running: 0, updatedAt: 0 });
    const group = projects.get(project.key);
    group.count += 1;
    group.running += Number(Boolean(thread.running));
    const updatedAt = Number.isFinite(thread.mtimeMs) ? thread.mtimeMs : Date.parse(thread.updatedAt) || 0;
    group.updatedAt = Math.max(group.updatedAt, updatedAt);
  }
  return [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
};

// Claude Code worktrees live in <repo>/.claude/worktrees/<name>: they belong to <repo>
const WORKTREE = /\/\.claude\/worktrees\/[^/]+$/;
export const isWorktree = (dir) => WORKTREE.test(dir || '');
export const workspaceOf = (dir) => (dir || '').replace(/\/+$/, '').replace(WORKTREE, '');

// Workspaces to start a thread in: your repos (from reposDir) and the folders you used,
// most recent first, without the pile of worktrees. Only the latest few worktrees are offered.
export const startWorkspaces = (threads, repos = [], { worktrees: maxWorktrees = 5, now = Date.now(), recentMs = 7 * 86_400_000 } = {}) => {
  const main = new Map(repos.map((dir) => [dir, { dir, name: dir.split('/').pop(), count: 0, updatedAt: 0 }]));
  const trees = new Map();
  for (const t of threads) {
    if (!t.cwd) continue;
    const dir = t.cwd.replace(/\/+$/, '');
    const at = Number.isFinite(t.mtimeMs) ? t.mtimeMs : Date.parse(t.updatedAt) || 0;
    const root = workspaceOf(dir);
    if (!main.has(root)) main.set(root, { dir: root, name: root.split('/').pop() || root, count: 0, updatedAt: 0 });
    const ws = main.get(root);
    ws.count += 1;
    ws.updatedAt = Math.max(ws.updatedAt, at);
    if (dir !== root) {
      const tree = trees.get(dir) || { dir, name: dir.split('/').pop(), parent: ws.name, updatedAt: 0 };
      tree.updatedAt = Math.max(tree.updatedAt, at);
      trees.set(dir, tree);
    }
  }
  const byRecent = (a, b) => b.updatedAt - a.updatedAt || b.count - a.count || a.name.localeCompare(b.name);
  return {
    main: [...main.values()].sort(byRecent),
    worktrees: [...trees.values()].filter((t) => now - t.updatedAt < recentMs).sort(byRecent).slice(0, maxWorktrees),
  };
};
