// Deploy check: are a task's PRs (and its subtasks') already in prod?
// The server runs the configured deployCheck.command. Relies on window.cockpit.
const C = window.cockpit;
const { state, api, esc, ago } = C;

state.deploy = {};
const btn = (act, label, primary, tip) => `<button class="btn sm ${primary ? 'primary' : ''}" data-act="${act}" title="${esc(tip)}">${label}</button>`;
const postJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

const DEPLOY_LABEL = {
  prod: ['ok', '✓ en prod'], pending: ['warn', '⏳ falta deploy'], no_tag: ['warn', '⏳ mergeado, sin tag aún'],
  merged_untracked: ['info', 'mergeado · repo sin tags'], open: ['info', 'PR abierto'], closed: ['', 'cerrado sin merge'],
  not_merged: ['info', 'sin mergear'], error: ['bad', 'error'],
};
const OVERALL = { prod: ['ok', '🚀 En prod'], prod_partial: ['ok', '🚀 En prod (CRM) · revisar otros repos'], pending: ['warn', '⏳ Falta deploy'], open: ['info', 'PRs abiertos'], no_prs: ['', 'Sin PRs encontrados'] };
C.deployBadge = (key) => {
  const d = state.deploy[key];
  if (!d) return '';
  if (d.loading) return '<span class="tag info">⟳ verificando…</span>';
  if (d.error) return '<span class="tag bad">error</span>';
  const [cls, label] = OVERALL[d.overall] || ['', d.overall];
  return `<span class="tag ${cls}">${label}</span>`;
};
C.deployPanel = (key) => {
  const d = state.deploy[key];
  if (!d) return '';
  if (d.loading) return '<div class="deploy note">Buscando los PRs de la tarea y sus subtareas, y ejecutando tu script de verificación…</div>';
  if (d.error) return `<div class="deploy banner err">${esc(d.error)}</div>`;
  const rows = d.results.map((r) => {
    const [cls, label] = DEPLOY_LABEL[r.status] || ['', r.status];
    const tags = r.firstTag ? `tag ${esc(r.firstTag)} · prod ${esc(r.prodTag || '?')}` : r.mergedAt ? `mergeado ${ago(r.mergedAt)}` : '';
    return `<div class="drow"><span class="tag ${cls}">${label}</span><a class="lnk" target="_blank" href="${esc(r.url)}">${esc(r.repo.split('/')[1])}#${r.number}</a>
      <span class="clip">${esc(r.ticket)} · ${esc(r.title)}</span><em>${tags || esc(r.message || '')}</em></div>`;
  }).join('') || '<div class="drow"><span>No encontré PRs con la clave en el título o el número en la rama.</span></div>';
  return `<div class="deploy"><div class="dhead">${C.deployBadge(key)}<span>verificado ${ago(d.checkedAt)}</span>${['prod', 'prod_partial'].includes(d.overall) ? `<button class="btn sm primary" data-act="close-task" data-key="${esc(key)}" title="Revisar, comentar lo implementado (y notificar) y mover el estado. Nada se escribe sin tu confirmación">Cerrar tarea…</button>` : ''}</div>${rows}</div>`;
};
const checkDeploy = async (key) => {
  state.deploy[key] = { loading: true };
  C.render();
  try { state.deploy[key] = await postJson('/api/deploy-check', { key }); } catch (e) { state.deploy[key] = { error: e.message }; }
  C.render();
};


document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act="task-deploy"], [data-act="deploy-column"]');
  if (!el) return;
  if (el.dataset.act === 'task-deploy') { const key = el.closest('[data-task]')?.dataset.task; if (key) checkDeploy(key); return; }
  for (const key of el.dataset.keys.split(',')) await checkDeploy(key);
});
