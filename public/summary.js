// Resumen: standup (último día hábil) y semanal, armados con PRs, Jira y Clockify. Texto copiable para Slack.
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, api, esc } = C;

const R = state.summary = { kind: 'standup', data: {}, loading: {}, err: '' };

const load = async (kind, force = false) => {
  R.loading[kind] = true;
  try {
    const res = await api(`/api/summary?kind=${kind}${force ? '&refresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    R.data[kind] = data; R.err = '';
  } catch (e) { R.err = e.message; }
  R.loading[kind] = false;
  C.render();
};
C.refreshSummary = () => load(R.kind, true);

const hrs = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 2.4) / 10} d`);
const kpi = (v, label) => `<div class="kpi static"><b>${v}</b><span>${label}</span></div>`;
const short = (d) => `${d.weekday.slice(0, 3)} ${Number(d.date.slice(8))}`;

// columns per day; `series` = [{ key, label, cls, fmt }]. Bars are scaled to the chart's own max.
const columns = (days, series, title) => {
  const max = Math.max(...days.flatMap((d) => series.map((x) => d[x.key])), 0);
  if (!max) return `<div class="sum-chart"><h4>${title}</h4><p class="note">Sin datos en este período.</p></div>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map((x) => `<span><i class="${x.cls}"></i>${x.label}</span>`).join('')}</div>` : '';
  return `<div class="sum-chart"><h4>${title}</h4>${legend}<div class="cols">${days.map((d) => `<div class="col" title="${esc(`${d.weekday} ${d.date}: ${series.map((x) => `${x.label} ${x.fmt(d[x.key])}`).join(' · ')}`)}">
      <div class="bars">${series.map((x) => `<div class="bar ${x.cls}" style="height:${d[x.key] ? Math.max(3, Math.round((d[x.key] / max) * 100)) : 0}%">${d[x.key] ? `<b>${x.fmt(d[x.key])}</b>` : ''}</div>`).join('')}</div>
      <span>${esc(short(d))}</span></div>`).join('')}</div></div>`;
};

const hbars = (items, title, fmt) => {
  const max = Math.max(...items.map((i) => i.value), 0);
  if (!max) return '';
  return `<div class="sum-chart"><h4>${title}</h4><div class="hbars">${items.map((i) => `<div class="hbar" title="${esc(`${i.label}: ${fmt(i.value)}`)}"><span class="clip">${esc(i.label)}</span>
    <div class="track"><i style="width:${Math.max(2, Math.round((i.value / max) * 100))}%"></i></div><b>${fmt(i.value)}</b></div>`).join('')}</div></div>`;
};

const TYPE = { merged: ['ok', 'mergeado'], reviewed: ['info', 'revisado'], closed: ['ok', 'cerrada'], moved: ['warn', 'movida'], time: ['', 'horas'] };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayTitle = (iso) => new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'short' });
const timeline = (events) => {
  const days = [];
  events.forEach((e) => {
    const key = new Date(e.at).toDateString();
    (days.find((d) => d.key === key) || days[days.push({ key, at: e.at, items: [] }) - 1]).items.push(e);
  });
  return days.map((d) => `<div class="tl-day"><h4>${esc(dayTitle(d.at))} <span class="note">${d.items.length}</span></h4>${d.items.map((e) => {
    const [cls, label] = TYPE[e.type];
    const ref = e.url ? `<a class="lnk" target="_blank" href="${esc(e.url)}">${esc(e.ref)}</a>` : `<span class="note">${esc(e.ref)}</span>`;
    return `<div class="tl-row"><time>${hhmm(e.at)}</time><span class="tag ${cls}">${label}</span>${ref}<span class="clip">${esc(e.title)}</span>${e.detail ? `<span class="note">${esc(e.detail)}</span>` : ''}</div>`;
  }).join('')}</div>`).join('');
};

const prLine = (p) => `<div class="tk-pr"><span class="tag ok">mergeado</span><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.repo.split('/').pop())}#${p.number}</a><span class="clip">${esc(p.title)}</span></div>`;
const ticketCard = (t) => `<article class="tk ${t.statusCategory === 'done' ? 'done' : ''}">
  <header><a class="lnk" target="_blank" href="${esc(t.url || '#')}">${esc(t.key)}</a><span class="clip">${esc(t.summary || 'Sin movimiento en Jira')}</span>
    ${t.status ? `<span class="tag ${t.statusCategory === 'done' ? 'ok' : t.statusCategory === 'indeterminate' ? 'info' : ''}">${esc(t.status)}</span>` : ''}
    ${t.hours ? `<b class="tk-h" title="Horas registradas en Clockify">${hrs(t.hours)}</b>` : ''}</header>
  ${t.prs.map(prLine).join('')}</article>`;

C.renderers.summary = () => {
  const s = R.data[R.kind];
  if (!s && !R.loading[R.kind]) load(R.kind);
  const seg = `<div class="viewbar"><div class="seg">${[['standup', 'Standup'], ['week', 'Semanal']].map(([k, l]) => `<button class="${R.kind === k ? 'on' : ''}" data-sumkind="${k}">${l}</button>`).join('')}</div>
    <span class="spacer"></span>${s ? '<button class="btn sm primary" data-act="summary-copy" title="Copia el resumen en formato Slack">Copiar para Slack</button>' : ''}</div>`;
  if (!s) return `${seg}<div class="empty">${R.err ? esc(R.err) : 'Armando el resumen…'}</div>`;
  const d = s.delivered;
  const hasHours = s.byDay.some((x) => x.hours);
  const charts = [
    s.byDay.some((x) => x.prs || x.reviews) ? columns(s.byDay, [{ key: 'prs', label: 'PRs mergeados', cls: 's1', fmt: String }, { key: 'reviews', label: 'Revisiones', cls: 's2', fmt: String }], 'PRs por día') : '',
    hasHours ? columns(s.byDay, [{ key: 'hours', label: 'Horas', cls: 's1', fmt: (h) => `${h}` }], 'Horas por día') : '',
    hbars(s.hours.byProject.map((p) => ({ label: p.project, value: p.hours })), 'Horas por proyecto', hrs),
  ].join('');
  const tickets = s.tickets.filter((t) => t.prs.length || t.statusCategory === 'done' || t.statusCategory === 'indeterminate' || t.hours);
  return `${seg}
    <p class="sum-head">${esc(s.headline)}</p>
    <p class="note">${esc(s.label)} · ${C.ago(s.from)} → ahora${R.loading[R.kind] ? ' · actualizando…' : ''}</p>
    ${s.warnings.length ? `<div class="banner warn">${s.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="kpis">
      ${kpi(d.prs.length, 'PRs mergeados')}
      ${kpi(s.reviewed.length, 'revisiones')}
      ${kpi(s.tasks.done.length, 'tareas cerradas')}
      ${kpi(hrs(s.hours.total), 'horas en Clockify')}
      ${s.kind === 'week' ? kpi(hrs(d.leadHours), 'mediana abrir → merge') : ''}
    </div>
    ${charts ? `<div class="sum-charts">${charts}</div>` : ''}
    ${s.timeline.length ? `<h3 class="sect-title">Cronología · ${s.timeline.length}</h3><div class="tl">${timeline(s.timeline)}</div>` : ''}
    ${tickets.length ? `<h3 class="sect-title">Por ticket · ${tickets.length}</h3><div class="tk-list">${tickets.map(ticketCard).join('')}</div>` : ''}
    ${s.loose.length ? `<h3 class="sect-title">Entregado sin ticket · ${s.loose.length}</h3><div class="tk-list"><article class="tk">${s.loose.map(prLine).join('')}</article></div>` : ''}
    ${s.reviewed.length ? `<h3 class="sect-title">Revisiones · ${s.reviewed.length}</h3><div class="tk-list"><article class="tk">${s.reviewed.map((p) => `<div class="tk-pr"><span class="tag info">revisado</span><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.repo.split('/').pop())}#${p.number}</a><span class="clip">${esc(p.title)}</span><span class="note">@${esc(p.author)}</span></div>`).join('')}</article></div>` : ''}
    ${s.hours.unticketed ? `<p class="note">${hrs(s.hours.unticketed)} registradas sin ticket en la descripción.</p>` : ''}
    <p class="note">No incluye lo que no deja rastro (reuniones sin entrada, ayuda a compañeros, investigación): sumalo a mano al pegar.</p>`;
};

document.addEventListener('click', async (e) => {
  const kind = e.target.closest?.('[data-sumkind]')?.dataset.sumkind;
  if (kind) { R.kind = kind; C.render(); return; }
  if (e.target.closest?.('[data-act="summary-copy"]')) {
    try { await navigator.clipboard.writeText(R.data[R.kind].markdown); C.toast('Resumen copiado'); } catch { C.toast('No se pudo copiar'); }
  }
});
