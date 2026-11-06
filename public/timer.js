// Clockify timer: always visible in the top bar (what is running, elapsed, pause/resume,
// today's total) plus one-click recurring blocks and ▶ per task. Relies on window.cockpit.
const C = window.cockpit;
const { state, api, esc } = C;

state.clock = null; // { running, last, todayHours, blocks } | null when Clockify is not linked
let menuOpen = false;
let busy = false;

const el = document.createElement('div');
el.id = 'timer';
document.querySelector('#refresh')?.before(el); // topbar: between search and refresh

const postJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const elapsed = (start) => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const todayLabel = () => {
  const h = (state.clock?.todayHours || 0) + (state.clock?.running ? (Date.now() - Date.parse(state.clock.running.start)) / 3_600_000 : 0);
  return `hoy ${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
};

const draw = () => {
  const c = state.clock;
  if (!c) { el.hidden = true; return; }
  el.hidden = false;
  const r = c.running;
  const blocks = c.blocks.map((b, i) => `<button data-tm="block" data-i="${i}" title="${esc(b.project)}${b.tags.length ? ` · ${esc(b.tags.join(', '))}` : ''} · ${b.count} veces en 4 semanas">
    <span>${esc(b.description)}</span><small>${esc(b.project)}</small></button>`).join('');
  el.innerHTML = `${r
    ? `<span class="tdot"></span><span class="tdesc" title="${esc(r.description)}${r.project ? ` · ${esc(r.project)}` : ''}">${esc(r.description)}</span><b class="telapsed">${elapsed(r.start)}</b>
       <button class="tbtn" data-tm="stop" title="Pausar (detiene el timer en Clockify)" ${busy ? 'disabled' : ''}>⏸</button>`
    : `<button class="tbtn play" data-tm="menu" title="Iniciar un bloque o reanudar" ${busy ? 'disabled' : ''}>▶</button>
       <span class="tdesc muted">${c.last ? `Último: ${esc(c.last.description)}` : 'Sin timer'}</span>`}
    <span class="ttoday">${todayLabel()}</span>
    <div class="tmenu" ${menuOpen ? '' : 'hidden'}>
      ${c.last ? `<button data-tm="resume" class="resume"><span>▶ Reanudar: ${esc(c.last.description)}</span><small>${esc(c.last.project)}</small></button>` : ''}
      <div class="tmhead">Tus bloques frecuentes</div>${blocks || '<div class="tmhead">Todavía no hay bloques repetidos</div>'}
    </div>`;
};

const load = async () => {
  try {
    const res = await api('/api/clockify');
    state.clock = res.ok ? await res.json() : null;
  } catch { /* keep last */ }
  draw();
  C.render(); // task buttons reflect the running timer
};

const act = async (fn) => {
  busy = true; menuOpen = false; draw();
  try { await fn(); } catch (e) { C.toast(e.message); }
  busy = false;
  await load();
};
C.startTaskTimer = (key) => act(async () => { const r = await postJson('/api/clockify/start', { key }); C.toast(`▶ ${r.running.description}`); });
C.stopTimer = () => act(async () => { await postJson('/api/clockify/stop', {}); C.toast('Timer pausado'); });

// ▶ / ⏸ button for a task (task panel); the board card only shows the running mark
C.timerButton = (key) => {
  if (!state.clock) return '';
  const r = state.clock.running;
  return r?.ticket === key
    ? `<button class="btn sm primary" data-act="timer-stop" title="Pausar el timer de Clockify">⏸ ${elapsed(r.start)}</button>`
    : `<button class="btn sm" data-act="timer-task" data-key="${esc(key)}" title="Iniciar el timer de Clockify para esta tarea">▶ Timer</button>`;
};
C.timerMark = (key) => (state.clock?.running?.ticket === key ? '<span class="tag ok" title="Timer corriendo">● registrando</span>' : '');

el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tm]');
  if (!b || busy) return;
  const c = state.clock;
  if (b.dataset.tm === 'menu') { menuOpen = !menuOpen; draw(); return; }
  if (b.dataset.tm === 'stop') { C.stopTimer(); return; }
  const entry = b.dataset.tm === 'resume' ? c.last : c.blocks[Number(b.dataset.i)];
  act(async () => { const r = await postJson('/api/clockify/start', entry); C.toast(`▶ ${r.running.description}`); });
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="timer-task"], [data-act="timer-stop"]');
  if (b) { e.stopPropagation(); if (b.dataset.act === 'timer-stop') C.stopTimer(); else C.startTaskTimer(b.dataset.key); return; }
  if (menuOpen && !e.target.closest('#timer')) { menuOpen = false; draw(); }
}, true);

// tick without re-rendering the page: only the clock texts change
setInterval(() => {
  const r = state.clock?.running;
  if (!r) return;
  const t = el.querySelector('.telapsed');
  if (t) t.textContent = elapsed(r.start);
  const today = el.querySelector('.ttoday');
  if (today) today.textContent = todayLabel();
}, 1000);

load();
setInterval(load, 30_000);
