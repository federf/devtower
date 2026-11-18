// Time-investment metrics: pure aggregation of Clockify entries over a range, plus heuristics that point
// at process improvements (meetings load, untracked time, context switching). Nothing here touches the network.

const DAY_MS = 86_400_000;
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const fmtH = (h) => (h >= 1 ? `${round1(h)} h` : `${Math.round(h * 60)} min`);
const MEETING = /meeting|reuni/i;
const REVIEW = /review/i;

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const hoursBetween = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : NaN);
const r1 = (n) => (n == null ? null : round1(n));

export const rangeFor = (days, now = Date.now()) => {
  const n = [7, 14, 28, 90].includes(days) ? days : 7;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return { days: n, from: start.getTime() - (n - 1) * DAY_MS, to: now };
};

// PR and task cycle times: opening → first review → merge, and started → closed in Jira
const buildFlow = ({ range, prs, tasks, reviewsGiven, openPrs, wipTasks, wipSprint, ticketHours, now }) => {
  const lead = prs.map((p) => hoursBetween(p.createdAt, p.mergedAt));
  const size = (p) => (p.additions || 0) + (p.deletions || 0);
  const bucket = (label, test) => { const l = prs.filter((p) => test(size(p))); return { label, count: l.length, leadHours: r1(median(l.map((p) => hoursBetween(p.createdAt, p.mergedAt)))) }; };
  const withReview = prs.filter((p) => p.firstReviewAt);
  const weeks = Math.ceil(range.days / 7);
  const byWeek = Array.from({ length: weeks }, (_, i) => weeks - 1 - i).map((ago) => ({
    label: ago === 0 ? 'esta semana' : `hace ${ago} sem`,
    count: prs.filter((p) => Math.floor((range.to - Date.parse(p.mergedAt)) / (7 * DAY_MS)) === ago).length,
  }));
  const cycle = tasks.map((t) => hoursBetween(t.started, t.resolved));
  const taskLead = tasks.map((t) => hoursBetween(t.created, t.resolved));
  const prFlow = {
    count: prs.length, leadHours: r1(median(lead)), firstReviewHours: r1(median(prs.map((p) => hoursBetween(p.createdAt, p.firstReviewAt)))),
    reviewShare: withReview.length ? Math.round(median(withReview.map((p) => hoursBetween(p.createdAt, p.firstReviewAt) / hoursBetween(p.createdAt, p.mergedAt) * 100)) || 0) : null,
    medianSize: median(prs.map(size)), byWeek,
    bySize: [bucket('Chico (<100 líneas)', (n) => n < 100), bucket('Mediano (100-400)', (n) => n >= 100 && n <= 400), bucket('Grande (>400)', (n) => n > 400)].filter((b) => b.count),
    slowest: [...prs].sort((a, b) => hoursBetween(b.createdAt, b.mergedAt) - hoursBetween(a.createdAt, a.mergedAt)).slice(0, 5)
      .map((p) => ({ ref: `${p.repo.split('/').pop()}#${p.number}`, title: p.title, url: p.url, leadHours: r1(hoursBetween(p.createdAt, p.mergedAt)) })),
  };
  const taskFlow = {
    count: tasks.length, withStart: tasks.filter((t) => t.started).length, cycleHours: r1(median(cycle)), leadHours: r1(median(taskLead)),
    slowest: tasks.filter((t) => t.started).sort((a, b) => hoursBetween(b.started, b.resolved) - hoursBetween(a.started, a.resolved)).slice(0, 5)
      .map((t) => ({ key: t.key, summary: t.summary, url: t.url, cycleHours: r1(hoursBetween(t.started, t.resolved)) })),
  };
  // review rounds: how many times a reviewer asked for changes before merge
  const roundBucket = (label, test) => { const l = prs.filter((p) => test(p.changeRequests || 0)); return { label, count: l.length, leadHours: r1(median(l.map((p) => hoursBetween(p.createdAt, p.mergedAt)))) }; };
  prFlow.rounds = {
    avg: prs.length ? round1(prs.reduce((s, p) => s + (p.changeRequests || 0), 0) / prs.length) : null,
    withChanges: pct(prs.filter((p) => p.changeRequests).length, prs.length),
    buckets: [roundBucket('Sin cambios pedidos', (n) => n === 0), roundBucket('1 ronda', (n) => n === 1), roundBucket('2+ rondas', (n) => n >= 2)].filter((b) => b.count),
  };
  const received = prs.reduce((s, p) => s + (p.reviewCount || 0), 0);
  const givenPrs = new Set(reviewsGiven.map((r) => `${r.repo}#${r.number}`));
  const weeks2 = Math.ceil(range.days / 7);
  const reviewFlow = {
    given: reviewsGiven.length, givenPrs: givenPrs.size, received,
    byWeek: Array.from({ length: weeks2 }, (_, i) => weeks2 - 1 - i).map((ago) => ({
      label: ago === 0 ? 'esta semana' : `hace ${ago} sem`,
      given: reviewsGiven.filter((r) => Math.floor((range.to - Date.parse(r.submittedAt)) / (7 * DAY_MS)) === ago).length,
      received: prs.filter((p) => Math.floor((range.to - Date.parse(p.mergedAt)) / (7 * DAY_MS)) === ago).reduce((s, p) => s + (p.reviewCount || 0), 0),
    })),
  };
  // time spent in each Jira status, median over the tasks that went through it
  const perStatus = new Map();
  tasks.forEach((t) => Object.entries(t.stages || {}).forEach(([status, h]) => { if (h > 0.05) (perStatus.get(status) || perStatus.set(status, []).get(status)).push(h); }));
  taskFlow.stages = [...perStatus].map(([status, hs]) => ({ status, hours: r1(median(hs)), count: hs.length })).sort((a, b) => b.hours - a.hours).slice(0, 8);
  const reopened = tasks.filter((t) => t.reopened);
  taskFlow.reopened = { count: reopened.length, pct: pct(reopened.length, tasks.length), list: reopened.slice(0, 5).map((t) => ({ key: t.key, summary: t.summary, url: t.url, times: t.reopened })) };
  // logged Clockify hours against wall-clock cycle time
  taskFlow.effort = tasks.filter((t) => t.started && ticketHours.has(t.key)).map((t) => {
    const cycle = hoursBetween(t.started, t.resolved); const logged = round1(ticketHours.get(t.key));
    return { key: t.key, summary: t.summary, url: t.url, loggedHours: logged, cycleHours: r1(cycle), focusPct: cycle > 0 ? Math.min(100, pct(logged, cycle)) : null };
  }).sort((a, b) => b.cycleHours - a.cycleHours).slice(0, 6);
  // work in progress now: open PRs (age) plus tasks in progress
  const ages = openPrs.map((p) => (now - Date.parse(p.createdAt)) / 86_400_000).sort((a, b) => a - b);
  const q = (frac) => (ages.length ? round1(ages[Math.min(ages.length - 1, Math.floor(frac * ages.length))]) : null);
  // subtasks roll up into their parent: one unit of work, not several
  const wipRoots = [...new Map(wipTasks.map((t) => [t.parent || t.key, t])).keys()];
  const wip = {
    sprint: wipSprint,
    openPrs: openPrs.length, drafts: openPrs.filter((p) => p.draft).length, tasks: wipRoots.length, total: openPrs.length + wipRoots.length,
    ageP50: q(0.5), ageP90: q(0.9),
    oldest: [...openPrs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 5)
      .map((p) => ({ ref: `${p.repo.split('/').pop()}#${p.number}`, title: p.title, url: p.url, days: round1((now - Date.parse(p.createdAt)) / 86_400_000), draft: p.draft })),
    taskList: wipTasks.slice(0, 12).map((t) => ({ key: t.key, summary: t.summary, url: t.url, status: t.status || '', parent: t.parent || '' })),
  };
  const insights = [];
  if (prFlow.rounds.withChanges >= 50 && prs.length >= 4) insights.push({ tone: 'info', text: `${prFlow.rounds.withChanges}% de tus PRs necesitó cambios tras la review: un checklist previo o PRs más chicos pueden ahorrar rondas.` });
  if (reviewFlow.given && received && reviewFlow.given > 3 * received) insights.push({ tone: 'info', text: `Hacés ${reviewFlow.given} reviews y recibís ${received}: revisar tanto puede estar quitándote foco.` });
  if (wip.tasks > 3 || wip.total > 7) insights.push({ tone: 'warn', text: `Tenés ${wip.tasks} tareas en curso${wipSprint ? ` en ${wipSprint}` : ''} y ${wip.openPrs} PRs abiertos a la vez: limitar el trabajo en paralelo acorta los ciclos.` });
  if (wip.ageP90 >= 7) insights.push({ tone: 'warn', text: `El 10% de tus PRs abiertos lleva más de ${wip.ageP90} días: revisá si siguen vigentes.` });
  if (taskFlow.reopened.pct >= 15 && tasks.length >= 4) insights.push({ tone: 'warn', text: `${taskFlow.reopened.pct}% de las tareas cerradas se reabrieron: mirá qué se escapa antes de QA.` });
  const topStage = taskFlow.stages[0];
  if (topStage && topStage.hours >= 48 && tasks.length >= 3) insights.push({ tone: 'info', text: `El mayor tiempo de una tarea está en "${topStage.status}": mediana ${fmtH(topStage.hours)}.` });
  if (prFlow.leadHours >= 48) insights.push({ tone: 'warn', text: `Tus PRs tardan una mediana de ${fmtH(prFlow.leadHours)} en llegar a merge.` });
  if (prFlow.reviewShare >= 50 && prFlow.leadHours >= 8) insights.push({ tone: 'warn', text: `Esperar la primera review es ~${prFlow.reviewShare}% del tiempo hasta el merge: pedí review más temprano o a más gente.` });
  const small = prFlow.bySize.find((b) => b.label.startsWith('Chico')); const big = prFlow.bySize.find((b) => b.label.startsWith('Grande'));
  if (small && big && big.count >= 2 && big.leadHours >= 8 && big.leadHours > 2 * small.leadHours) insights.push({ tone: 'info', text: `Los PRs grandes tardan ${fmtH(big.leadHours)} contra ${fmtH(small.leadHours)} los chicos: partir el trabajo acelera el merge.` });
  if (taskFlow.cycleHours >= 120) insights.push({ tone: 'warn', text: `Una tarea tarda una mediana de ${fmtH(taskFlow.cycleHours)} desde que la empezás hasta que se cierra.` });
  if (taskFlow.cycleHours && taskFlow.leadHours > 3 * taskFlow.cycleHours) insights.push({ tone: 'info', text: `Las tareas esperan ${fmtH(taskFlow.leadHours)} (creación → cierre) pero se trabajan en ${fmtH(taskFlow.cycleHours)}: la demora está antes de empezar.` });
  return { prs: prFlow, tasks: taskFlow, reviews: reviewFlow, wip, insights };
};

export const buildMetrics = ({ range, entries = [], prs = [], tasks = [], prsTotal = prs.length, ticketPattern = '', reviewsGiven = [], openPrs = [], wipTasks = [], wipSprint = '', now = Date.now() }) => {
  const TICKET = ticketPattern ? new RegExp(`\\b(?:${ticketPattern})\\b`) : null;
  const keyOf = (text) => (TICKET && TICKET.exec(text || '')?.[0]) || null;
  const logged = entries.filter((e) => e.start && Date.parse(e.start) >= range.from && Date.parse(e.start) <= range.to)
    .map((e) => ({ ...e, ticket: e.ticket || keyOf(e.description),
      hours: (Math.min(Date.parse(e.end || new Date(range.to)), range.to) - Date.parse(e.start)) / 3_600_000 }))
    .filter((e) => e.hours > 0);
  const total = logged.reduce((s, e) => s + e.hours, 0);
  const sum = (list) => list.reduce((s, e) => s + e.hours, 0);

  const days = new Map();
  for (let t = range.from; t <= range.to; t += DAY_MS) days.set(dayKey(t), { date: dayKey(t), weekday: DAYS[new Date(t).getDay()], hours: 0, tickets: new Set() });
  logged.forEach((e) => { const d = days.get(dayKey(Date.parse(e.start))); if (d) { d.hours += e.hours; if (e.ticket) d.tickets.add(e.ticket); } });
  const worked = [...days.values()].filter((d) => d.hours > 0);
  const ticketDays = worked.filter((d) => d.tickets.size);

  const group = (keyFn) => { const m = new Map(); logged.forEach((e) => { const k = keyFn(e); m.set(k, (m.get(k) || 0) + e.hours); }); return m; };
  const byProject = [...group((e) => e.project || 'Sin proyecto')].map(([project, h]) => ({ project, hours: round1(h), pct: pct(h, total) })).sort((a, b) => b.hours - a.hours);

  const tickets = new Map();
  logged.filter((e) => e.ticket).forEach((e) => {
    const t = tickets.get(e.ticket) || tickets.set(e.ticket, { key: e.ticket, hours: 0, description: e.description || '' }).get(e.ticket);
    t.hours += e.hours;
  });
  const topTickets = [...tickets.values()].map((t) => ({ ...t, hours: round1(t.hours) })).sort((a, b) => b.hours - a.hours).slice(0, 8);

  // time with no ticket in the description, grouped by what it says: recurring blocks are process candidates
  const untracked = new Map();
  logged.filter((e) => !e.ticket).forEach((e) => {
    const k = (e.description || '(sin descripción)').trim().toLowerCase();
    const u = untracked.get(k) || untracked.set(k, { label: (e.description || '(sin descripción)').trim(), project: e.project || '', hours: 0, count: 0 }).get(k);
    u.hours += e.hours; u.count += 1;
  });
  const recurring = [...untracked.values()].map((u) => ({ ...u, hours: round1(u.hours) })).sort((a, b) => b.hours - a.hours).slice(0, 6);
  const unticketed = sum(logged.filter((e) => !e.ticket));
  const meetings = sum(logged.filter((e) => MEETING.test(e.project || '')));
  const reviews = sum(logged.filter((e) => REVIEW.test(e.project || '')));
  const avgPerDay = worked.length ? total / worked.length : 0;
  const ticketsPerDay = ticketDays.length ? ticketDays.reduce((s, d) => s + d.tickets.size, 0) / ticketDays.length : 0;

  // consecutive worked days ending today (or yesterday, if today is still empty)
  const seq = [...days.values()]; let streak = 0;
  for (let i = seq.length - 1; i >= 0; i--) { if (seq[i].hours > 0) streak++; else if (i !== seq.length - 1) break; }
  const insights = [];
  if (pct(meetings, total) >= 25) insights.push({ tone: 'warn', text: `${pct(meetings, total)}% del tiempo (${fmtH(meetings)}) se va en reuniones: ¿alguna recurrente se puede acortar o pasar a asíncrono?` });
  if (pct(unticketed, total) >= 35) insights.push({ tone: 'warn', text: `${pct(unticketed, total)}% de las horas (${fmtH(unticketed)}) no tienen ticket en la descripción: se pierde trazabilidad de en qué se invirtió.` });
  if (ticketsPerDay >= 4) insights.push({ tone: 'warn', text: `Tocás ${round1(ticketsPerDay)} tickets distintos por día en promedio: el cambio de contexto cuesta; probá agrupar tareas por bloque.` });
  if (pct(reviews, total) >= 20) insights.push({ tone: 'info', text: `Code review ocupa ${pct(reviews, total)}% del tiempo (${fmtH(reviews)}): ¿conviene un bloque fijo para revisar?` });
  if (avgPerDay > 9) insights.push({ tone: 'warn', text: `Registrás ${fmtH(avgPerDay)} por día trabajado en promedio: jornada larga sostenida.` });
  const repeat = recurring.find((u) => u.count >= 3 && !MEETING.test(u.project));
  if (repeat) insights.push({ tone: 'info', text: `"${repeat.label}" se repitió ${repeat.count} veces (${fmtH(repeat.hours)}): si es rutina, es candidata a automatizar o a acotar.` });
  if (!insights.length && total) insights.push({ tone: 'ok', text: 'Nada fuera de lo común en este período.' });

  return {
    days: range.days, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(),
    total: round1(total), workedDays: worked.length, avgPerDay: round1(avgPerDay), ticketsPerDay: round1(ticketsPerDay),
    meetings: { hours: round1(meetings), pct: pct(meetings, total) }, reviews: { hours: round1(reviews), pct: pct(reviews, total) },
    unticketed: { hours: round1(unticketed), pct: pct(unticketed, total) },
    byProject, byDay: [...days.values()].map((d) => ({ date: d.date, weekday: d.weekday, hours: round1(d.hours) })),
    topTickets, recurring, insights, streak, flow: { ...buildFlow({ range, prs, tasks, reviewsGiven, openPrs, wipTasks, wipSprint, now, ticketHours: new Map([...tickets].map(([k, t]) => [k, t.hours])) }), prsTruncated: prsTotal > prs.length },
  };
};
