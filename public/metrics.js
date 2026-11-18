// Métricas: en qué se invierte el tiempo (Clockify) y señales para mejorar el proceso.
// Relies on window.cockpit exposed by app.js and the chart helpers summary.js adds to it.
const C = window.cockpit;
const { state, api, esc } = C;

const M = state.metrics = { days: 7, data: {}, loading: {}, err: '' };

const load = async (days, force = false) => {
  if (M.loading[days] || (!force && M.data[days])) return;
  M.loading[days] = true;
  try {
    const res = await api(`/api/metrics?days=${days}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    M.data[days] = data; M.err = '';
  } catch (e) { M.err = e.message; }
  M.loading[days] = false;
  C.render();
};
M.weeks = 12; M.trends = {}; M.trendLoading = {}; M.trendErr = '';
const loadTrends = async (weeks, force = false) => {
  if (M.trendLoading[weeks] || (!force && M.trends[weeks])) return;
  M.trendLoading[weeks] = true;
  try {
    const res = await api(`/api/metrics/trends?weeks=${weeks}${force ? '&refresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    M.trends[weeks] = data; M.trendErr = '';
  } catch (e) { M.trendErr = e.message; }
  M.trendLoading[weeks] = false;
  C.render();
};
C.refreshMetrics = () => { delete M.data[M.days]; delete M.trends[M.weeks]; loadTrends(M.weeks, true); return load(M.days, true); };

// line chart over the weekly buckets; null points break the line. `delta` = % change, last 4 weeks vs the 4 before
const lineChart = (title, weeks, key, fmt, { delta, goodWhen = 'up', unit = '' } = {}) => {
  const vals = weeks.map((w) => w[key]);
  const nums = vals.filter((v) => v != null);
  if (!nums.length) return `<div class="sum-chart"><h4>${title}</h4><p class="note">Sin datos en este período.</p></div>`;
  const W = 520, H = 150, PX = 14, PT = 14, PB = 24;
  const max = Math.max(...nums) || 1;
  const x = (i) => PX + (weeks.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (weeks.length - 1));
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);
  const segs = []; let cur = [];
  vals.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) segs.push(cur);
  const line = segs.map((s) => `<polyline class="tl" points="${s.map((p) => p.join(',')).join(' ')}"/>`).join('');
  const area = segs.filter((s) => s.length > 1).map((s) => `<polygon class="ta" points="${s[0][0]},${H - PB} ${s.map((p) => p.join(',')).join(' ')} ${s[s.length - 1][0]},${H - PB}"/>`).join('');
  const dots = vals.map((v, i) => (v == null ? '' : `<circle class="td${weeks[i].current ? ' cur' : ''}" cx="${x(i)}" cy="${y(v)}" r="3.5"><title>${esc(`${weeks[i].label}: ${fmt(v)}${weeks[i].current ? ' (en curso)' : ''}`)}</title></circle>`)).join('');
  const step = Math.ceil(weeks.length / 8);
  const ticks = weeks.map((w, i) => (i % step === 0 || i === weeks.length - 1 ? `<text class="tt" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(w.label)}</text>` : '')).join('');
  const last = [...vals].reverse().find((v) => v != null);
  let chip = '';
  if (delta != null) {
    const up = delta > 0; const good = delta === 0 ? null : (goodWhen === 'up') === up;
    chip = `<span class="tdelta ${good == null ? '' : good ? 'ok' : 'bad'}" title="Últimas 4 semanas contra las 4 anteriores">${up ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(delta)}%</span>`;
  }
  return `<div class="sum-chart trend"><h4>${title}<span class="tnow">${fmt(last)}${unit}</span>${chip}</h4>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" preserveAspectRatio="none"><line class="tg" x1="${PX}" x2="${W - PX}" y1="${H - PB}" y2="${H - PB}"/>${area}${line}${dots}${ticks}</svg></div>`;
};

const trendsBlock = () => {
  const t = M.trends[M.weeks];
  if (!t && !M.trendLoading[M.weeks]) loadTrends(M.weeks);
  const seg = `<div class="seg mini">${[[8, '8 sem'], [12, '12 sem'], [26, '26 sem']].map(([w, l]) => `<button class="${M.weeks === w ? 'on' : ''}" data-trendweeks="${w}">${l}</button>`).join('')}</div>`;
  const head = `<div class="sect-head"><h3>Tendencias · por semana</h3>${seg}<em>${t ? 'Semanas de lunes a domingo; la última está en curso.' : ''}</em></div>`;
  if (!t) return `${head}<p class="note">${M.trendErr ? esc(M.trendErr) : 'Armando el historial…'}</p>`;
  const w = t.weeks; const d = t.deltas; const { hrs } = C;
  const h = (v) => (v == null ? '—' : hrs(v));
  return `${head}${t.warnings?.length ? `<div class="banner warn">${t.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="sum-charts trends">
      ${lineChart('Horas registradas', w, 'hours', (v) => `${v} h`, { delta: d.hours })}
      ${lineChart('% en reuniones', w, 'meetingsPct', (v) => `${v}%`, { delta: d.meetingsPct, goodWhen: 'down' })}
      ${lineChart('PRs mergeados', w, 'prs', String, { delta: d.prs })}
      ${lineChart('Abrir → merge (mediana)', w, 'prLeadHours', h, { delta: d.prLeadHours, goodWhen: 'down' })}
      ${lineChart('Tareas cerradas', w, 'tasks', String, { delta: d.tasks })}
      ${lineChart('Cycle time de tareas (mediana)', w, 'cycleHours', h, { delta: d.cycleHours, goodWhen: 'down' })}
    </div>`;
};

const kpi = (v, label) => `<div class="kpi static"><b>${v}</b><span>${label}</span></div>`;

C.renderers.metrics = () => {
  const m = M.data[M.days];
  if (!m && !M.loading[M.days]) load(M.days);
  const seg = `<div class="viewbar"><div class="seg">${[[7, '7 días'], [14, '14 días'], [28, '28 días'], [90, '90 días']].map(([d, l]) => `<button class="${M.days === d ? 'on' : ''}" data-metdays="${d}">${l}</button>`).join('')}</div></div>`;
  if (!m) return `${seg}<div class="empty">${M.err ? esc(M.err) : 'Calculando métricas…'}</div>`;
  const { hrs } = C;
  const f = m.flow;
  const pieItems = m.byProject.map((p) => ({ text: p.project, note: hrs(p.hours), value: p.hours }));
  const insights = [...f.insights, ...m.insights];
  const lead = (h) => (h == null ? '—' : hrs(h));
  const slow = (items, line) => (items.length ? `<div class="tk-list"><article class="tk">${items.map(line).join('')}</article></div>` : '');
  const time = m.total ? `
    <h3 class="sect-title">En qué invierto el tiempo · Clockify</h3>
    <div class="kpis">
      ${kpi(hrs(m.total), 'registradas')}
      ${kpi(hrs(m.avgPerDay), `por día trabajado (${m.workedDays} días)`)}
      ${kpi(`${m.meetings.pct}%`, 'en reuniones')}
      ${kpi(`${m.reviews.pct}%`, 'en code review')}
      ${kpi(`${m.unticketed.pct}%`, 'sin ticket')}
      ${kpi(m.ticketsPerDay || '—', 'tickets por día')}
      ${kpi(m.streak, 'días seguidos con horas')}
    </div>
    <div class="sum-charts">
      <div class="sum-chart script"><h4>Por proyecto</h4>${C.pie(m.byProject.map((p) => ({ text: p.project, note: hrs(p.hours), value: p.hours })))}</div>
      ${C.columns(m.byDay, [{ key: 'hours', label: 'Horas', cls: 's1', fmt: (h) => `${h}` }], 'Horas por día')}
      ${C.hbars(m.topTickets.map((t) => ({ label: `${t.key} ${t.description.replace(/^\[[^\]]+\]:?\s*/, '')}`.trim(), value: t.hours })), 'Tickets con más horas', hrs)}
      ${C.hbars(m.recurring.map((u) => ({ label: `${u.label}${u.count > 1 ? ` ×${u.count}` : ''}`, value: u.hours })), 'Tiempo sin ticket, por actividad', hrs)}
    </div>` : '<p class="note">Sin horas de Clockify en este período.</p>';
  return `${seg}
    ${m.warnings?.length ? `<div class="banner warn">${m.warnings.map(esc).join('<br>')}</div>` : ''}
    ${insights.length ? `<div class="met-insights">${insights.map((i) => `<div class="banner ${i.tone === 'ok' ? '' : i.tone}">${esc(i.text)}</div>`).join('')}</div>` : ''}
    ${trendsBlock()}
    <h3 class="sect-title">Ciclo de PRs · ${f.prs.count} mergeados${f.prsTruncated ? ' (se muestran los últimos 100)' : ''}</h3>
    <div class="kpis">
      ${kpi(lead(f.prs.leadHours), 'mediana abrir → merge')}
      ${kpi(lead(f.prs.firstReviewHours), 'mediana a la 1ª review')}
      ${kpi(f.prs.reviewShare == null ? '—' : `${f.prs.reviewShare}%`, 'del ciclo es esperar review')}
      ${kpi(f.prs.medianSize == null ? '—' : Math.round(f.prs.medianSize), 'líneas por PR (mediana)')}
    </div>
    <div class="sum-charts">
      ${C.columns(f.prs.byWeek, [{ key: 'count', label: 'PRs mergeados', cls: 's1', fmt: String }], 'PRs mergeados por semana')}
      ${C.hbars(f.prs.bySize.map((b) => ({ label: `${b.label} · ${b.count}`, value: b.leadHours || 0 })), 'Abrir → merge según tamaño', lead)}
    </div>
    ${slow(f.prs.slowest, (p) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.ref)}</a><span class="clip">${esc(p.title)}</span><b class="tk-h">${lead(p.leadHours)}</b></div>`)}
    <h3 class="sect-title">Calidad de review</h3>
    <div class="kpis">
      ${kpi(f.prs.rounds.avg == null ? '—' : f.prs.rounds.avg, 'rondas de cambios por PR')}
      ${kpi(`${f.prs.rounds.withChanges}%`, 'PRs con cambios pedidos')}
      ${kpi(f.reviews.given, `reviews que hiciste (${f.reviews.givenPrs} PRs)`)}
      ${kpi(f.reviews.received, 'reviews que recibiste')}
    </div>
    <div class="sum-charts">
      ${C.hbars(f.prs.rounds.buckets.map((b) => ({ label: `${b.label} · ${b.count}`, value: b.leadHours || 0 })), 'Abrir → merge según rondas', lead)}
      ${C.columns(f.reviews.byWeek, [{ key: 'given', label: 'Hechas', cls: 's1', fmt: String }, { key: 'received', label: 'Recibidas', cls: 's2', fmt: String }], 'Reviews por semana')}
    </div>
    <h3 class="sect-title">Trabajo en curso ahora</h3>
    <div class="kpis">
      ${kpi(f.wip.tasks, f.wip.sprint ? `tareas en curso · ${esc(f.wip.sprint)}` : 'tareas en curso')}
      ${kpi(`${f.wip.openPrs}${f.wip.drafts ? ` (${f.wip.drafts} draft)` : ''}`, 'PRs abiertos')}
      ${kpi(f.wip.ageP50 == null ? '—' : `${f.wip.ageP50} d`, 'edad mediana de PRs abiertos')}
      ${kpi(f.wip.ageP90 == null ? '—' : `${f.wip.ageP90} d`, 'edad p90 de PRs abiertos')}
    </div>
    ${slow(f.wip.taskList, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">${esc(t.status)}</b></div>`)}
    ${slow(f.wip.oldest, (p) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.ref)}</a><span class="clip">${esc(p.title)}${p.draft ? ' · draft' : ''}</span><b class="tk-h">${p.days} d</b></div>`)}
    <h3 class="sect-title">Ciclo de tareas · ${f.tasks.count} cerradas</h3>
    <div class="kpis">
      ${kpi(lead(f.tasks.cycleHours), 'mediana en curso → cerrada')}
      ${kpi(lead(f.tasks.leadHours), 'mediana creación → cierre')}
      ${kpi(`${f.tasks.withStart}/${f.tasks.count}`, 'con inicio registrado')}
    </div>
    <div class="kpis">
      ${kpi(`${f.tasks.reopened.pct}%`, `reabiertas (${f.tasks.reopened.count})`)}
    </div>
    <div class="sum-charts">
      ${C.hbars(f.tasks.stages.map((x) => ({ label: `${x.status} · ${x.count}`, value: x.hours })), 'Mediana de tiempo por estado', lead)}
      ${C.hbars(f.tasks.effort.map((x) => ({ label: `${x.key} · ${x.focusPct ?? '—'}% con horas`, value: x.cycleHours })), 'Cycle time y % con horas en Clockify', lead)}
    </div>
    ${slow(f.tasks.reopened.list, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">×${t.times}</b></div>`)}
    ${slow(f.tasks.slowest, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">${lead(t.cycleHours)}</b></div>`)}
    ${time}
    <p class="note">PRs y tareas son los que cerraste en el período; el tiempo de Clockify cubre hasta 28 días. Las señales son heurísticas: tomalas como preguntas, no como veredictos.${M.data[M.days]?.days > 28 ? ' Con 90 días el bloque de Clockify solo muestra lo que alcanza la historia.' : ''}</p>`;
};

document.addEventListener('click', (e) => {
  const d = Number(e.target.closest?.('[data-metdays]')?.dataset.metdays);
  if (d) { M.days = d; C.render(); }
  const w = Number(e.target.closest?.('[data-trendweeks]')?.dataset.trendweeks);
  if (w) { M.weeks = w; C.render(); }
});
