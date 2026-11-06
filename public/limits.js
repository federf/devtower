// Claude plan limits in the top bar: % of the 5-hour and weekly windows and when they reset
// (from the statusline JSON), plus a panel with active sessions and cost estimates (ccusage).
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, esc, ago } = C;

state.usage = null;
let open = false;
const widget = document.getElementById('usage-widget');
widget.setAttribute('role', 'button');
widget.tabIndex = 0;
const panel = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'limits-panel', hidden: true }));

const tone = (pct) => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '');
const clock = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' });
const left = (iso) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

const metric = (label, w, when) => `<div class="uw-metric ${w ? tone(w.usedPct) : ''}" title="${w ? `${label}: ${w.usedPct}% usado · se reinicia en ${left(w.resetsAt)}` : `${label}: sin datos todavía`}">
  <span class="uw-label">${label}</span><b class="uw-value">${w ? `${Math.round(w.usedPct)}%` : '—'}</b>
  <div class="uw-bar"><div class="uw-fill" style="width:${w ? Math.min(100, w.usedPct) : 0}%"></div></div>
  <span class="uw-reset">${w ? when(w.resetsAt) : ''}</span></div>`;

const drawWidget = () => {
  const l = state.usage?.limits;
  widget.classList.toggle('stale', !l || l.stale);
  widget.innerHTML = `${metric('5 h', l?.fiveHour, clock)}${metric('Semana', l?.sevenDay, day)}`;
};

const bar = (title, w, when) => `<section class="lp-win ${w ? tone(w.usedPct) : ''}">
  <div class="lp-head"><b>${title}</b><span>${w ? `${w.usedPct}% usado` : 'sin datos'}</span></div>
  <div class="lp-bar"><i style="width:${w ? Math.min(100, w.usedPct) : 0}%"></i></div>
  <p>${w ? `Se reinicia ${when(w.resetsAt)} · en ${left(w.resetsAt)}` : 'Aparece cuando una sesión de Claude Code recibe su primera respuesta.'}</p></section>`;

const drawPanel = () => {
  if (!open) { panel.hidden = true; return; }
  const u = state.usage || {};
  const l = u.limits || {};
  const sessions = (l.sessions || []).map((s) => `<div class="lp-sess"><span><b>${esc(s.project || '—')}</b> · ${esc(s.model)}</span>
    <em>${s.contextPct != null ? `contexto ${s.contextPct}%` : ''}</em><em>${money(s.costUsd)}</em></div>`).join('') || '<p class="note">Ninguna sesión activa en los últimos 15 min.</p>';
  panel.innerHTML = `<header><b>Uso de Claude</b><span class="note">${l.reportedAt ? `actualizado ${ago(l.reportedAt)}` : ''}</span></header>
    ${l.stale ? '<div class="banner">Sin sesiones activas recientes: los porcentajes pueden estar desactualizados hasta que uses Claude Code.</div>' : ''}
    ${bar('Sesión (5 h)', l.fiveHour, (iso) => `a las ${clock(iso)}`)}
    ${bar('Semana', l.sevenDay, (iso) => `el ${day(iso)} a las ${clock(iso)}`)}
    <h4>Sesiones activas</h4>${sessions}
    <h4>Costo estimado (a precio de lista)</h4>
    <div class="lp-grid"><span>Bloque actual</span><b>${money(u.block?.cost)}</b>
      <span>Ritmo</span><b>${u.block ? `${money(u.block.burnRate)}/h` : '—'}</b>
      <span>Proyección del bloque</span><b>${money(u.block?.projectedCost)}</b>
      <span>Esta semana</span><b>${money(u.week?.cost)}</b></div>
    <p class="note">Los % son los límites reales de tu plan (los informa Claude Code). Los montos son estimaciones de ccusage: con suscripción no se cobran aparte.</p>`;
  panel.hidden = false;
};

const load = async () => {
  try { state.usage = await (await fetch('/api/usage')).json(); } catch { /* keep last */ }
  drawWidget(); drawPanel();
};
// limits change often and are cheap to read; the ccusage cost part comes along every minute
const loadLimits = async () => {
  try { state.usage = { ...(state.usage || {}), limits: await (await fetch('/api/claude-limits')).json() }; } catch { /* keep last */ }
  drawWidget(); drawPanel();
};

const toggle = (e) => { e?.stopPropagation(); open = !open; drawPanel(); };
widget.addEventListener('click', toggle);
widget.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
document.addEventListener('click', (e) => { if (open && !e.target.closest('#limits-panel')) { open = false; drawPanel(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; drawPanel(); } });

load();
setInterval(loadLimits, 20_000);
setInterval(load, 90_000);
