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
const short = (d) => d.label ?? `${d.weekday.slice(0, 3)} ${Number(d.date.slice(8))}`;

// columns per day; `series` = [{ key, label, cls, fmt }]. Bars are scaled to the chart's own max.
const columns = (days, series, title) => {
  const max = Math.max(...days.flatMap((d) => series.map((x) => d[x.key])), 0);
  if (!max) return `<div class="sum-chart"><h4>${title}</h4><p class="note">Sin datos en este período.</p></div>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map((x) => `<span><i class="${x.cls}"></i>${x.label}</span>`).join('')}</div>` : '';
  return `<div class="sum-chart"><h4>${title}</h4>${legend}<div class="cols">${days.map((d) => `<div class="col" title="${esc(`${d.label ?? `${d.weekday} ${d.date}`}: ${series.map((x) => `${x.label} ${x.fmt(d[x.key])}`).join(' · ')}`)}">
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

const taskLine = (t, note = '') => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url || '#')}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span>${note}</div>`;
const dueTag = (t) => `<span class="tag ${t.dueToday || t.overdue ? 'warn' : ''}">${t.dueToday ? 'vence hoy' : t.overdue ? `venció ${esc(t.due)}` : `vence ${esc(t.due)}`}</span>${t.fresh ? '<span class="tag info">nueva</span>' : ''}`;
const prOpen = (p) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.repo.split('/').pop())}#${p.number}</a><span class="clip">${esc(p.title)}</span>${p.draft ? '<span class="tag">draft</span>' : ''}${p.author ? `<span class="note">@${esc(p.author)}</span>` : ''}</div>`;
const block = (title, items, line) => (items.length ? `<h3 class="sect-title">${title} · ${items.length}</h3><div class="tk-list"><article class="tk">${items.map(line).join('')}</article></div>` : '');

const scriptItem = (i) => `<li>${i.ref ? (i.url ? `<a class="lnk" target="_blank" href="${esc(i.url)}">${esc(i.ref)}</a>` : `<b>${esc(i.ref)}</b>`) : ''} <span>${esc(i.text)}</span>${i.note ? ` <span class="note">${esc(i.note)}</span>` : ''}</li>`;
const PIE = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--info)', 'var(--accent2)', 'var(--bad)'];
// donut: one stroked circle arc per slice, starting at 12 o'clock; legend carries label, time and share
const pie = (items) => {
  const total = items.reduce((n, i) => n + i.value, 0);
  if (!total) return '';
  const R = 15.915; // circumference 100, so dash lengths are percentages
  let acc = 0;
  const arcs = items.map((i, n) => { const pct = (i.value / total) * 100; const a = `<circle r="${R}" cx="21" cy="21" fill="none" stroke="${PIE[n % PIE.length]}" stroke-width="7" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${25 - acc}"><title>${esc(i.text)}: ${esc(i.note)}</title></circle>`; acc += pct; return a; }).join('');
  return `<div class="pie"><svg viewBox="0 0 42 42" role="img" aria-label="Horas por proyecto">${arcs}</svg>
    <ul>${items.map((i, n) => `<li><i style="background:${PIE[n % PIE.length]}"></i><span>${esc(i.text)}</span><b>${esc(i.note)}</b><span class="note">${Math.round((i.value / total) * 100)}%</span></li>`).join('')}</ul></div>`;
};
const script = (sections) => `<div class="script">${sections.map((sec) => `<section><h3>${esc(sec.title)}</h3>${sec.blocks.map((b) => `<div class="blk ${b.tone}"><p>${esc(b.lead)}${b.items.length ? ':' : '.'}</p>${b.pie ? pie(b.items) : b.items.length ? `<ul>${b.items.map(scriptItem).join('')}</ul>` : ''}</div>`).join('')}</section>`).join('')}</div>`;

C.renderers.summary = () => {
  const s = R.data[R.kind];
  if (!s && !R.loading[R.kind]) load(R.kind);
  const seg = `<div class="viewbar"><div class="seg">${[['standup', 'Standup'], ['daily', 'Daily brief'], ['week', 'Semanal']].map(([k, l]) => `<button class="${R.kind === k ? 'on' : ''}" data-sumkind="${k}">${l}</button>`).join('')}</div>
    <span class="spacer"></span>${s && R.kind === 'daily' ? '<button class="btn sm" data-act="summary-copy-script" title="Copia el guion para leer en la daily">Copiar guion</button>' : ''}${s ? '<button class="btn sm primary" data-act="summary-copy" title="Copia el resumen en formato Slack">Copiar para Slack</button>' : ''}</div>`;
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
    ${s.kind === 'daily' ? script(s.scriptSections) : ''}
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
    ${block('En curso', s.tasks.inProgress, (t) => taskLine(t))}
    ${s.kind === 'daily' ? `${block('Con vencimiento', s.tasks.due, (t) => taskLine(t, `${dueTag(t)}<span class="note">${esc(t.status)}</span>`))}
    ${block('Esperando', s.tasks.waiting, (t) => taskLine(t, `<span class="tag">${esc(t.status)}</span>`))}
    ${block('Reviews pendientes', s.reviewRequests, prOpen)}
    ${block('PRs abiertos', s.openPrs, prOpen)}` : ''}
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
  if (e.target.closest?.('[data-act="summary-copy-script"]')) {
    try { await navigator.clipboard.writeText(R.data[R.kind].script); C.toast('Guion copiado'); } catch { C.toast('No se pudo copiar'); }
    return;
  }
  if (e.target.closest?.('[data-act="summary-copy"]')) {
    try { await navigator.clipboard.writeText(R.data[R.kind].markdown); C.toast('Resumen copiado'); } catch { C.toast('No se pudo copiar'); }
  }
});

Object.assign(C, { pie, columns, hbars, hrs });
