// Sidebar: collapse toggle, ⌘K button and the first quick-access links from config.
// Relies on window.cockpit exposed by app.js. Never calls Claude.
const C = window.cockpit;
const { api, esc, $, store } = C;

const app = $('#app');
const toggle = $('#side-toggle');
const apply = (min) => {
  app.classList.toggle('side-min', min);
  toggle.querySelector('span').textContent = min ? '»' : '«';
  toggle.title = min ? 'Expandir la barra lateral' : 'Colapsar la barra lateral';
};
apply(store.get('sideMin', false));
toggle.addEventListener('click', () => { const min = !app.classList.contains('side-min'); store.set('sideMin', min); apply(min); });
$('#side-palette').addEventListener('click', () => C.openPalette());

// Sections (Trabajo, Análisis, Accesos rápidos) collapse on header click; state persists. Secondary ones start closed.
const secs = store.get('sideSecs', { analysis: true, links: true });
const applySec = (sec) => {
  const closed = Boolean(secs[sec.dataset.sec]);
  sec.classList.toggle('closed', closed);
  sec.querySelector('.nav-group').setAttribute('aria-expanded', String(!closed));
};
document.querySelectorAll('.nav-sec').forEach((sec) => {
  applySec(sec);
  sec.querySelector('.nav-group').addEventListener('click', () => { secs[sec.dataset.sec] = !sec.classList.contains('closed'); store.set('sideSecs', secs); applySec(sec); });
});

const MAX = 5;
(async () => {
  let links = [];
  try { links = (await (await api('/api/links')).json()).links || []; } catch { return; }
  if (!links.length) return;
  const box = $('#side-links .nav-items');
  box.insertAdjacentHTML('beforeend', links.slice(0, MAX).map((l) => `<a class="nav link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.name)}${l.group ? ` · ${esc(l.group)}` : ''}"><span>${esc(l.icon)}</span><b>${esc(l.name)}</b></a>`).join('')
    + (links.length > MAX ? `<button class="nav" id="side-more" title="Ver todos los accesos (⌘K)"><span>⋯</span><b>Más (${links.length - MAX})</b></button>` : ''));
  $('#side-links').hidden = false;
  $('#side-more')?.addEventListener('click', () => C.openPalette());
})();
