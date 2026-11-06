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
