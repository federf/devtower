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
  if (!nums.length) return `<div class="sum-chart"><h4>${title}${q(CHART[title])}</h4><p class="note">Sin datos en este período.</p></div>`;
  const W = 520, H = 150, PX = 14, PT = 14, PB = 24;
  const max = Math.max(...nums) || 1;
  const x = (i) => PX + (weeks.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (weeks.length - 1));
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);
  const segs = []; let cur = [];
  vals.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) segs.push(cur);
  const line = segs.map((s) => `<polyline class="tl" points="${s.map((p) => p.join(',')).join(' ')}"/>`).join('');
  const area = segs.filter((s) => s.length > 1).map((s) => `<polygon class="ta" points="${s[0][0]},${H - PB} ${s.map((p) => p.join(',')).join(' ')} ${s[s.length - 1][0]},${H - PB}"/>`).join('');
  const dots = vals.map((v, i) => (v == null ? '' : `<circle class="td${weeks[i].current ? ' cur' : ''}" cx="${x(i)}" cy="${y(v)}" r="3.5"/>`)).join('');
  // hover data: one entry per week, read by the delegated mousemove below
  const pts = weeks.map((w, i) => {
    const v = vals[i]; const prev = i > 0 ? vals[i - 1] : null;
    const change = v != null && prev != null && prev !== 0 ? `${v > prev ? '▲' : v < prev ? '▼' : '='} ${Math.abs(Math.round(((v - prev) / prev) * 100))}% vs semana anterior` : '';
    return { x: x(i), y: v == null ? H - PB : y(v), t: [`Semana del ${w.label}${w.current ? ' (en curso)' : ''}`, v == null ? 'Sin datos' : fmt(v), change].filter(Boolean) };
  });
  const step = Math.ceil(weeks.length / 8);
  const ticks = weeks.map((w, i) => (i % step === 0 || i === weeks.length - 1 ? `<text class="tt" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(w.label)}</text>` : '')).join('');
  const last = [...vals].reverse().find((v) => v != null);
  let chip = '';
  if (delta != null) {
    const up = delta > 0; const good = delta === 0 ? null : (goodWhen === 'up') === up;
    const verdict = good == null ? '' : good ? ' · mejor' : ' · peor';
    chip = `<span class="tdelta ${good == null ? '' : good ? 'ok' : 'bad'}" title="Promedio de las últimas 4 semanas completas contra las 4 anteriores. La flecha es la dirección del valor; el color y la palabra dicen si es bueno o malo para esta métrica.">${up ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(delta)}%${verdict}</span>`;
  }
  return `<div class="sum-chart trend"><h4>${title}${q(CHART[title])}<span class="tnow">${fmt(last)}${unit}</span>${chip}</h4>
    <svg viewBox="0 0 ${W} ${H}" data-w="${W}" data-h="${H}" data-pts="${esc(JSON.stringify(pts))}" role="img" aria-label="${esc(title)}" preserveAspectRatio="none"><line class="tg" x1="${PX}" x2="${W - PX}" y1="${H - PB}" y2="${H - PB}"/>${area}${line}${dots}${ticks}<line class="guide" y1="${PT}" y2="${H - PB}" hidden/><circle class="hov" r="6" hidden/></svg><div class="ttip" hidden></div></div>`;
};

const trendsBlock = () => {
  const t = M.trends[M.weeks];
  if (!t && !M.trendLoading[M.weeks]) loadTrends(M.weeks);
  const seg = `<div class="seg mini">${[[8, '8 sem'], [12, '12 sem'], [26, '26 sem']].map(([w, l]) => `<button class="${M.weeks === w ? 'on' : ''}" data-trendweeks="${w}">${l}</button>`).join('')}</div>`;
  const head = `<div class="sect-head"><h3>Tendencias · por semana${q(SECT.trends)}</h3>${seg}<em>${t ? 'Semanas de lunes a domingo; la última está en curso.' : ''}</em></div>`;
  if (!t) return `${head}<p class="note">${M.trendErr ? esc(M.trendErr) : 'Armando el historial…'}</p>`;
  const w = t.weeks; const d = t.deltas; const { hrs } = C;
  const h = (v) => (v == null ? '—' : hrs(v));
  return `${head}${t.warnings?.length ? `<div class="banner warn">${t.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="sum-charts trends">
      ${lineChart('Horas registradas', w, 'hours', (v) => `${v} h`, { delta: d.hours })}
      ${lineChart('Horas fuera de horario', w, 'extraHours', (v) => `${v} h`, { delta: d.extraHours, goodWhen: 'down' })}
      ${lineChart('Horas por día trabajado', w, 'avgPerDay', (v) => `${v} h`, { delta: d.avgPerDay, goodWhen: 'down' })}
      ${lineChart('% en reuniones', w, 'meetingsPct', (v) => `${v}%`, { delta: d.meetingsPct, goodWhen: 'down' })}
      ${lineChart('PRs mergeados', w, 'prs', String, { delta: d.prs })}
      ${lineChart('Abrir → merge (mediana)', w, 'prLeadHours', h, { delta: d.prLeadHours, goodWhen: 'down' })}
      ${lineChart('Tareas cerradas', w, 'tasks', String, { delta: d.tasks })}
      ${lineChart('Cycle time de tareas (mediana)', w, 'cycleHours', h, { delta: d.cycleHours, goodWhen: 'down' })}
    </div>`;
};

const HELP = {"total": "Suma de las horas registradas en Clockify dentro del período elegido (incluye el timer en curso).", "avgDay": "Horas registradas divididas por los días en que registraste algo. Mide la jornada real de los días que trabajaste, no el promedio del calendario.", "meetings": "Porcentaje de las horas registradas en proyectos de Clockify cuyo nombre incluye \"meeting\" o \"reunión\". Si es alto, revisá qué reuniones se pueden acortar.", "reviews": "Porcentaje de las horas registradas en proyectos de Clockify cuyo nombre incluye \"review\". Indica cuánto tiempo va a revisar código.", "normal": "Horas registradas dentro de tu horario laboral (días y franja definidos en Config → Semana laboral).", "extra": "Horas registradas fuera de tu horario laboral: antes o después de la jornada, o en días no laborables. El porcentaje es sobre el total registrado.", "unticketed": "Porcentaje de las horas cuya descripción no contiene una clave de ticket. Las horas sin ticket no se pueden asociar a una tarea.", "ticketsDay": "Cantidad promedio de tickets distintos que tocás en un día trabajado. Más de 4 suele indicar mucho cambio de contexto.", "streak": "Días laborables seguidos con horas registradas, contando hasta hoy. Los días no laborables no cortan la racha.", "prLead": "Mediana del tiempo entre abrir el PR y mergearlo. Si en Config → Semana laboral descontás los días no laborables, no cuentan fines de semana. Solo PRs tuyos mergeados en el período.", "prFirst": "Mediana del tiempo entre abrir el PR y la primera review de una persona (no cuentan bots, Claude ni vos). Mide cuánto espera tu código a que alguien lo mire.", "prShare": "Qué parte del tiempo hasta el merge se va esperando la primera review (mediana por PR). Si es alta, el cuello de botella es conseguir revisores, no el código.", "prSize": "Mediana de líneas cambiadas (agregadas + borradas) por PR. PRs más chicos se revisan y mergean más rápido.", "rounds": "Promedio de reviews con \"cambios pedidos\" por PR antes del merge. Cada ronda es una vuelta de ida y vuelta con quien revisa.", "withChanges": "Porcentaje de tus PRs mergeados que recibieron al menos una review con \"cambios pedidos\".", "given": "Reviews que hiciste a PRs de otras personas en el período, y en cuántos PRs distintos.", "received": "Reviews de personas (no bots) que recibieron tus PRs mergeados en el período.", "wipTasks": "Tareas tuyas en estado \"En curso\" del sprint activo, o con vencimiento dentro de sus fechas. Las subtareas cuentan en su tarea padre. Mucho trabajo en paralelo alarga los ciclos.", "wipPrs": "PRs tuyos abiertos ahora (entre paréntesis, los que están en draft).", "ageP50": "Mediana de los días que llevan abiertos tus PRs actuales (sin contar días no laborables si así lo configuraste).", "ageP90": "Los días que lleva abierto el 10% más viejo de tus PRs actuales. Detecta PRs olvidados.", "taskCycle": "Mediana del tiempo entre que moviste la tarea a \"En curso\" y se cerró. Solo tareas tuyas cerradas en el período con inicio registrado.", "taskLead": "Mediana del tiempo desde que se creó la tarea hasta que se cerró. Si es mucho mayor que el cycle time, la demora está antes de empezar.", "taskStart": "Cuántas de las tareas cerradas tienen registrado el paso a \"En curso\" en Jira. Las demás no entran en el cycle time.", "reopened": "Tareas cerradas que en algún momento volvieron de Listo a un estado anterior. Mide calidad: lo que se escapa antes de QA. Solo cuenta tareas que hoy están cerradas."};
const CHART = {"Horas por día": "Horas registradas cada día, separadas en las que caen dentro y fuera de tu horario laboral. Los días no laborables solo aparecen si registraste horas.", "Por proyecto": "Reparto de las horas registradas por proyecto de Clockify.", "Tickets con más horas": "Los tickets en los que más horas registraste en el período.", "Tiempo sin ticket, por actividad": "Horas sin clave de ticket agrupadas por descripción. Las actividades repetidas son candidatas a automatizar o a acotar.", "PRs mergeados por semana": "Cantidad de PRs tuyos mergeados en cada semana del período.", "Abrir → merge según tamaño": "Mediana de abrir → merge agrupada por tamaño del PR (chico <100 líneas, mediano 100-400, grande >400).", "Abrir → merge según rondas": "Mediana de abrir → merge según cuántas rondas de cambios pidió quien revisó.", "Reviews por semana": "Reviews que hiciste a otras personas y reviews que recibieron tus PRs, por semana.", "Mediana de tiempo por estado": "Cuánto tiempo pasó cada tarea cerrada en cada estado de Jira (mediana entre las que pasaron por él). Muestra dónde se frena el trabajo. En horas corridas, sin descontar días no laborables.", "Cycle time y % con horas en Clockify": "Las tareas con mayor cycle time y qué porcentaje de ese tiempo tiene horas registradas en Clockify. Un % bajo indica que la tarea estuvo parada mucho más de lo que se trabajó.", "Horas registradas": "Horas registradas en Clockify en cada semana (lunes a domingo).", "Horas fuera de horario": "Horas registradas fuera de tu horario laboral por semana. Para esta métrica, que baje es mejor.", "Horas por día trabajado": "Horas registradas divididas por los días con registro de cada semana. Que baje es mejor.", "% en reuniones": "Porcentaje de las horas de cada semana que fue a proyectos de reuniones. Que baje es mejor.", "PRs mergeados": "PRs tuyos mergeados por semana.", "Abrir → merge (mediana)": "Mediana semanal del tiempo entre abrir y mergear los PRs mergeados esa semana. Que baje es mejor.", "Tareas cerradas": "Tareas tuyas cerradas por semana.", "Cycle time de tareas (mediana)": "Mediana semanal del tiempo entre pasar a \"En curso\" y cerrar, de las tareas cerradas esa semana. Que baje es mejor."};
const SECT = {"time": "Cómo se reparten tus horas registradas en Clockify. Cubre hasta 28 días.", "review": "Cuántas rondas de cambios necesitan tus PRs y cuánto revisás vs. cuánto te revisan.", "wip": "Lo que tenés abierto en este momento (no depende del período elegido): tareas del sprint activo y PRs abiertos.", "prs": "PRs tuyos mergeados en el período: cuánto tardan y qué los frena. Los tiempos no cuentan días no laborables si así lo configuraste en Config → Semana laboral.", "tasks": "Tareas tuyas cerradas en el período: cuánto tardan desde que las empezás y qué estados las frenan.", "trends": "Evolución semana a semana (lunes a domingo). Los chips comparan las últimas 4 semanas completas con las 4 anteriores; la semana en curso se dibuja pero no entra en la comparación."};
const q = (text) => (text ? `<i class="q" tabindex="0" title="${esc(text)}">?</i>` : '');
const kpi = (v, label, help) => `<div class="kpi static"><b>${v}</b><span>${label}${q(HELP[help])}</span></div>`;

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
    <h3 class="sect-title">En qué invierto el tiempo · Clockify${q(SECT.time)}</h3>
    <div class="kpis">
      ${kpi(hrs(m.total), 'registradas', 'total')}
      ${kpi(hrs(m.avgPerDay), `por día trabajado (${m.workedDays} días)`, 'avgDay')}
      ${kpi(`${m.meetings.pct}%`, 'en reuniones', 'meetings')}
      ${kpi(`${m.reviews.pct}%`, 'en code review', 'reviews')}
      ${kpi(hrs(m.schedule.normal), 'en horario laboral', 'normal')}
      ${kpi(hrs(m.schedule.extra), `fuera de horario (${m.schedule.extraPct}%)`, 'extra')}
      ${kpi(`${m.unticketed.pct}%`, 'sin ticket', 'unticketed')}
      ${kpi(m.ticketsPerDay || '—', 'tickets por día', 'ticketsDay')}
      ${kpi(m.streak, 'días seguidos con horas', 'streak')}
    </div>
    <div class="sum-charts">
      <div class="sum-chart script"><h4>Por proyecto${q(CHART['Por proyecto'])}</h4>${C.pie(m.byProject.map((p) => ({ text: p.project, note: hrs(p.hours), value: p.hours })))}</div>
      ${C.columns(m.byDay, [{ key: 'normal', label: 'En horario', cls: 's1', fmt: (h) => `${h}` }, { key: 'extra', label: 'Fuera de horario', cls: 's2', fmt: (h) => `${h}` }], `Horas por día · ${m.schedule.window}${q(CHART['Horas por día'])}`)}
      ${C.hbars(m.topTickets.map((t) => ({ label: `${t.key} ${t.description.replace(/^\[[^\]]+\]:?\s*/, '')}`.trim(), value: t.hours })), `Tickets con más horas${q(CHART['Tickets con más horas'])}`, hrs)}
      ${C.hbars(m.recurring.map((u) => ({ label: `${u.label}${u.count > 1 ? ` ×${u.count}` : ''}`, value: u.hours })), `Tiempo sin ticket, por actividad${q(CHART['Tiempo sin ticket, por actividad'])}`, hrs)}
    </div>` : '<p class="note">Sin horas de Clockify en este período.</p>';
  return `${seg}
    ${m.warnings?.length ? `<div class="banner warn">${m.warnings.map(esc).join('<br>')}</div>` : ''}
    ${insights.length ? `<div class="met-insights">${insights.map((i) => `<div class="banner ${i.tone === 'ok' ? '' : i.tone}">${esc(i.text)}</div>`).join('')}</div>` : ''}
    ${trendsBlock()}
    <h3 class="sect-title">Ciclo de PRs · ${f.prs.count} mergeados${f.prsTruncated ? ' (se muestran los últimos 100)' : ''}${q(SECT.prs)}</h3>
    <div class="kpis">
      ${kpi(lead(f.prs.leadHours), 'mediana abrir → merge', 'prLead')}
      ${kpi(lead(f.prs.firstReviewHours), 'mediana a la 1ª review', 'prFirst')}
      ${kpi(f.prs.reviewShare == null ? '—' : `${f.prs.reviewShare}%`, 'del ciclo es esperar review', 'prShare')}
      ${kpi(f.prs.medianSize == null ? '—' : Math.round(f.prs.medianSize), 'líneas por PR (mediana)', 'prSize')}
    </div>
    <div class="sum-charts">
      ${C.columns(f.prs.byWeek, [{ key: 'count', label: 'PRs mergeados', cls: 's1', fmt: String }], `PRs mergeados por semana${q(CHART['PRs mergeados por semana'])}`)}
      ${C.hbars(f.prs.bySize.map((b) => ({ label: `${b.label} · ${b.count}`, value: b.leadHours || 0 })), `Abrir → merge según tamaño${q(CHART['Abrir → merge según tamaño'])}`, lead)}
    </div>
    ${slow(f.prs.slowest, (p) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.ref)}</a><span class="clip">${esc(p.title)}</span><b class="tk-h">${lead(p.leadHours)}</b></div>`)}
    <h3 class="sect-title">Calidad de review${q(SECT.review)}</h3>
    <div class="kpis">
      ${kpi(f.prs.rounds.avg == null ? '—' : f.prs.rounds.avg, 'rondas de cambios por PR', 'rounds')}
      ${kpi(`${f.prs.rounds.withChanges}%`, 'PRs con cambios pedidos', 'withChanges')}
      ${kpi(f.reviews.given, `reviews que hiciste (${f.reviews.givenPrs} PRs)`, 'given')}
      ${kpi(f.reviews.received, 'reviews que recibiste', 'received')}
    </div>
    <div class="sum-charts">
      ${C.hbars(f.prs.rounds.buckets.map((b) => ({ label: `${b.label} · ${b.count}`, value: b.leadHours || 0 })), `Abrir → merge según rondas${q(CHART['Abrir → merge según rondas'])}`, lead)}
      ${C.columns(f.reviews.byWeek, [{ key: 'given', label: 'Hechas', cls: 's1', fmt: String }, { key: 'received', label: 'Recibidas', cls: 's2', fmt: String }], `Reviews por semana${q(CHART['Reviews por semana'])}`)}
    </div>
    <h3 class="sect-title">Trabajo en curso ahora${q(SECT.wip)}</h3>
    <div class="kpis">
      ${kpi(f.wip.tasks, f.wip.sprint ? `tareas en curso · ${esc(f.wip.sprint)}` : 'tareas en curso', 'wipTasks')}
      ${kpi(`${f.wip.openPrs}${f.wip.drafts ? ` (${f.wip.drafts} draft)` : ''}`, 'PRs abiertos', 'wipPrs')}
      ${kpi(f.wip.ageP50 == null ? '—' : `${f.wip.ageP50} d`, 'edad mediana de PRs abiertos', 'ageP50')}
      ${kpi(f.wip.ageP90 == null ? '—' : `${f.wip.ageP90} d`, 'edad p90 de PRs abiertos', 'ageP90')}
    </div>
    ${slow(f.wip.taskList, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">${esc(t.status)}</b></div>`)}
    ${slow(f.wip.oldest, (p) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.ref)}</a><span class="clip">${esc(p.title)}${p.draft ? ' · draft' : ''}</span><b class="tk-h">${p.days} d</b></div>`)}
    <h3 class="sect-title">Ciclo de tareas · ${f.tasks.count} cerradas${q(SECT.tasks)}</h3>
    <div class="kpis">
      ${kpi(lead(f.tasks.cycleHours), 'mediana en curso → cerrada', 'taskCycle')}
      ${kpi(lead(f.tasks.leadHours), 'mediana creación → cierre', 'taskLead')}
      ${kpi(`${f.tasks.withStart}/${f.tasks.count}`, 'con inicio registrado', 'taskStart')}
    </div>
    <div class="kpis">
      ${kpi(`${f.tasks.reopened.pct}%`, `reabiertas (${f.tasks.reopened.count})`, 'reopened')}
    </div>
    <div class="sum-charts">
      ${C.hbars(f.tasks.stages.map((x) => ({ label: `${x.status} · ${x.count}`, value: x.hours })), `Mediana de tiempo por estado${q(CHART['Mediana de tiempo por estado'])}`, lead)}
      ${C.hbars(f.tasks.effort.map((x) => ({ label: `${x.key} · ${x.focusPct ?? '—'}% con horas`, value: x.cycleHours })), `Cycle time y % con horas en Clockify${q(CHART['Cycle time y % con horas en Clockify'])}`, lead)}
    </div>
    ${slow(f.tasks.reopened.list, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">×${t.times}</b></div>`)}
    ${slow(f.tasks.slowest, (t) => `<div class="tk-pr"><a class="lnk" target="_blank" href="${esc(t.url)}">${esc(t.key)}</a><span class="clip">${esc(t.summary)}</span><b class="tk-h">${lead(t.cycleHours)}</b></div>`)}
    ${time}
    <p class="note">PRs y tareas son los que cerraste en el período; el tiempo de Clockify cubre hasta 28 días. Las señales son heurísticas: tomalas como preguntas, no como veredictos.${M.data[M.days]?.days > 28 ? ' Con 90 días el bloque de Clockify solo muestra lo que alcanza la historia.' : ''}</p>`;
};

// weekly line charts: snap to the nearest week, show guide line, highlighted point and a tooltip with the data
const moveTrend = (e) => {
  const svg = e.target.closest?.('.sum-chart.trend svg');
  if (!svg) return;
  const box = svg.closest('.trend'); const tip = box.querySelector('.ttip');
  const pts = JSON.parse(svg.dataset.pts); const W = Number(svg.dataset.w); const H = Number(svg.dataset.h);
  const r = svg.getBoundingClientRect();
  const relX = ((e.clientX - r.left) / r.width) * W;
  const i = pts.reduce((best, p, k) => (Math.abs(p.x - relX) < Math.abs(pts[best].x - relX) ? k : best), 0);
  const p = pts[i];
  const guide = svg.querySelector('.guide'); const dot = svg.querySelector('.hov');
  guide.setAttribute('x1', p.x); guide.setAttribute('x2', p.x); dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
  guide.hidden = false; dot.hidden = p.t[1] === 'Sin datos';
  tip.innerHTML = p.t.map((line, k) => (k === 1 ? `<b>${esc(line)}</b>` : `<span>${esc(line)}</span>`)).join('');
  tip.hidden = false;
  const px = (p.x / W) * r.width + (svg.getBoundingClientRect().left - box.getBoundingClientRect().left);
  const py = (p.y / H) * r.height + (r.top - box.getBoundingClientRect().top);
  tip.style.left = `${Math.max(4, Math.min(px - tip.offsetWidth / 2, box.clientWidth - tip.offsetWidth - 4))}px`;
  tip.style.top = `${Math.max(4, py - tip.offsetHeight - 12)}px`;
};
document.addEventListener('mousemove', moveTrend);
document.addEventListener('mouseout', (e) => {
  const svg = e.target.closest?.('.sum-chart.trend svg');
  if (!svg || svg.contains(e.relatedTarget)) return;
  svg.closest('.trend').querySelector('.ttip').hidden = true;
  svg.querySelector('.guide').hidden = true; svg.querySelector('.hov').hidden = true;
});

document.addEventListener('click', (e) => {
  const d = Number(e.target.closest?.('[data-metdays]')?.dataset.metdays);
  if (d) { M.days = d; C.render(); }
  const w = Number(e.target.closest?.('[data-trendweeks]')?.dataset.trendweeks);
  if (w) { M.weeks = w; C.render(); }
});
