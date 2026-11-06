// ⌘K palette: jump to a view, open a quick-access link or a Jira ticket, or search.
// Relies on window.cockpit exposed by app.js. Never calls Claude.
const C = window.cockpit;
const { state, api, esc, $, setView } = C;

const JIRA_BROWSE = `${window.DEVTOWER?.jiraSite || ''}/browse`;
const TICKET_RE = /^\s*([a-z][a-z0-9]{1,9}-\d{1,7})\s*$/i;
const VIEWS = [['today', 'Hoy', '◎'], ['tasks', 'Tareas', '☰'], ['prs', 'Pull requests', '⑂'], ['slack', 'Slack', '#'], ['threads', 'Hilos', '✦'], ['work-items', 'Trabajos', '◇']];

let links = [];
const pal = { q: '', sel: 0, items: [] };
const el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'palette', hidden: true }));
el.innerHTML = `<div class="box" role="dialog" aria-label="Accesos rápidos">
  <input id="pal-input" placeholder="Ir a…  vista, acceso, ticket (ABC-123) o texto a buscar" autocomplete="off">
  <ul id="pal-list" role="listbox"></ul>
  <div class="hint">↑↓ elegir · Enter abrir · Esc cerrar · accesos: «links» en ~/.config/devtower/config.json</div></div>`;

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const build = () => {
  const q = fold(pal.q.trim());
  const hit = (...xs) => !q || xs.some((x) => fold(x || '').includes(q));
  const items = [];
  const ticket = TICKET_RE.exec(pal.q)?.[1]?.toUpperCase();
  if (ticket && window.DEVTOWER?.jiraSite) items.push({ icon: '↗', label: `Abrir ${ticket} en Jira`, meta: 'Jira', run: () => window.open(`${JIRA_BROWSE}/${ticket}`, '_blank') });
  VIEWS.filter(([, l]) => hit(l)).forEach(([v, l, i]) => items.push({ icon: i, label: l, meta: 'Vista', run: () => setView(v) }));
  links.filter((l) => hit(l.name, l.group)).forEach((l) => items.push({ icon: l.icon, label: l.name, meta: l.group, run: () => window.open(l.url, '_blank') }));
  (state.jira?.items || []).filter((j) => q.length >= 2 && hit(j.key, j.summary)).slice(0, 6)
    .forEach((j) => items.push({ icon: '☰', label: `${j.key} · ${j.summary}`, meta: j.status, run: () => window.open(j.url, '_blank') }));
  if (q.length >= 2) items.push({ icon: '⌕', label: `Buscar «${pal.q.trim()}»`, meta: 'Hilos, PRs, Slack', run: () => { const s = $('#search'); s.value = pal.q.trim(); s.dispatchEvent(new Event('input')); s.focus(); } });
  pal.items = items;
  pal.sel = Math.min(pal.sel, Math.max(0, items.length - 1));
};
const draw = () => {
  build();
  $('#pal-list').innerHTML = pal.items.map((it, i) => `<li class="${i === pal.sel ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === pal.sel}">
    <i class="i">${esc(it.icon)}</i><span>${esc(it.label)}</span><small>${esc(it.meta || '')}</small></li>`).join('') || '<li><span>Sin resultados</span></li>';
  $('#pal-list .on')?.scrollIntoView({ block: 'nearest' });
};
const close = () => { el.hidden = true; };
const run = (i) => { const it = pal.items[i]; if (!it) return; close(); it.run(); };

C.openPalette = async () => {
  Object.assign(pal, { q: '', sel: 0 });
  $('#pal-input').value = '';
  el.hidden = false;
  draw();
  $('#pal-input').focus();
  if (!links.length) {
    try { links = (await (await api('/api/links')).json()).links || []; } catch { links = []; }
    draw();
  }
};

$('#pal-input').addEventListener('input', (e) => { pal.q = e.target.value; pal.sel = 0; draw(); });
$('#pal-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); draw(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); draw(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(pal.sel); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
});
el.addEventListener('mousedown', (e) => {
  if (e.target === el) return close();
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); run(Number(li.dataset.i)); }
});
