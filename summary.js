// Standup / weekly summary: pure aggregation of what the user shipped, reviewed, moved in Jira and logged
// in Clockify inside a time window. Sources are fetched elsewhere; nothing here touches the network.

const DAY_MS = 86_400_000;
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const round1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

// standup and daily look back to the last working day (Monday → Friday); week is the last 7 days
export const windowFor = (kind, now = Date.now()) => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (kind === 'week') return { kind, from: day.getTime() - 6 * DAY_MS, to: now, label: 'Últimos 7 días' };
  const back = [2, 3, 1, 1, 1, 1, 1][day.getDay()]; // Sun→Fri, Mon→Fri, otherwise yesterday
  const from = day.getTime() - back * DAY_MS;
  const when = new Date(from);
  return { kind: kind === 'daily' ? 'daily' : 'standup', from, to: now, label: back === 1 ? 'Ayer' : `Desde el ${DAYS[when.getDay()]}` };
};

const fmtH = (h) => (h >= 1 ? `${round1(h)} h` : `${Math.round(h * 60)} min`);

const entryHours = (e, to) => (Math.min(Date.parse(e.end || new Date(to)), to) - Math.max(Date.parse(e.start), 0)) / 3_600_000;

// only a status literally named "En curso" / "In progress" counts as started; "Seleccionado para desarrollo" is not
const IN_PROGRESS = /^(en curso|en progreso|in progress)$/i;
const DUE_WINDOW_DAYS = 14;

// open Jira tasks bucketed for the daily: started, waiting on someone, and those with a due date that matter now
// (created inside the window, or due between a week ago and DUE_WINDOW_DAYS ahead; years-old overdue ones are noise)
export const dailyTasks = (open, w) => {
  const day = new Date(w.to); day.setHours(0, 0, 0, 0);
  const iso = (ms) => `${new Date(ms).getFullYear()}-${String(new Date(ms).getMonth() + 1).padStart(2, '0')}-${String(new Date(ms).getDate()).padStart(2, '0')}`;
  const today = iso(day.getTime());
  const inProgress = open.filter((t) => IN_PROGRESS.test(t.status));
  const waiting = open.filter((t) => t.statusCategory === 'indeterminate' && !IN_PROGRESS.test(t.status));
  const due = open.filter((t) => t.due).map((t) => ({ ...t, fresh: Date.parse(t.created) >= w.from, dueToday: t.due === today, overdue: t.due < today }))
    .filter((t) => t.fresh || (t.due >= iso(day.getTime() - 7 * DAY_MS) && t.due <= iso(day.getTime() + DUE_WINDOW_DAYS * DAY_MS)))
    .sort((a, b) => a.due.localeCompare(b.due));
  return { inProgress, waiting, due };
};

export const buildSummary = ({ window: w, merged = [], reviewed = [], tasks = [], entries = [], open = [], openPrs = [], reviewRequests = [], ticketPattern = '' }) => {
  const TICKET = ticketPattern ? new RegExp(`\\b(?:${ticketPattern})\\b`) : null;
  const keyOf = (text) => (TICKET && TICKET.exec(text || '')?.[0]) || null;
  const inWindow = (ts) => Date.parse(ts) >= w.from && Date.parse(ts) <= w.to;

  const prs = merged.filter((p) => inWindow(p.mergedAt)).map((p) => ({ ...p, ticket: keyOf(p.title) }));
  // standup/daily are about the days before today, so today's Clockify entries must not inflate "Ayer"
  const hoursTo = w.kind === 'week' ? w.to : Math.min(w.to, new Date(w.to).setHours(0, 0, 0, 0));
  const logged = entries.filter((e) => e.start && Date.parse(e.start) >= w.from && Date.parse(e.start) < Math.max(hoursTo, w.from + 1))
    .map((e) => ({ ...e, hours: entryHours(e, hoursTo), ticket: e.ticket || keyOf(e.description) })).filter((e) => e.hours > 0);

  // the daily only covers what I'm actually on: tasks in the active sprint, with Clockify time in the window,
  // or flash tasks (due date, created inside the window) that were just handed to me
  const loggedKeys = new Set(logged.map((e) => e.ticket).filter(Boolean));

  const byProject = new Map();
  logged.forEach((e) => byProject.set(e.project || 'Sin proyecto', (byProject.get(e.project || 'Sin proyecto') || 0) + e.hours));
  const total = logged.reduce((s, e) => s + e.hours, 0);

  // one row per ticket joining PRs, Jira movement and logged hours
  const rows = new Map();
  const row = (key) => rows.get(key) || rows.set(key, { key, summary: '', status: '', statusCategory: '', url: '', prs: [], hours: 0 }).get(key);
  tasks.forEach((t) => Object.assign(row(t.key), { summary: t.summary, status: t.status, statusCategory: t.statusCategory, url: t.url }));
  prs.filter((p) => p.ticket).forEach((p) => row(p.ticket).prs.push(p));
  logged.filter((e) => e.ticket).forEach((e) => { row(e.ticket).hours += e.hours; });

  const tickets = [...rows.values()].map((r) => ({ ...r, hours: round1(r.hours) }))
    .sort((a, b) => (b.statusCategory === 'done') - (a.statusCategory === 'done') || b.prs.length - a.prs.length || b.hours - a.hours);

  // one bucket per local day in the window, for the activity chart
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const days = new Map();
  for (let t = new Date(w.from).setHours(0, 0, 0, 0); t <= w.to; t += DAY_MS) days.set(dayKey(t), { date: dayKey(t), weekday: DAYS[new Date(t).getDay()], prs: 0, reviews: 0, hours: 0 });
  prs.forEach((p) => { const d = days.get(dayKey(Date.parse(p.mergedAt))); if (d) d.prs += 1; });
  reviewed.forEach((p) => { const d = p.reviewedAt && days.get(dayKey(Date.parse(p.reviewedAt))); if (d) d.reviews += 1; });
  logged.forEach((e) => { const d = days.get(dayKey(Date.parse(e.start))); if (d) d.hours += e.hours; });
  const byDay = [...days.values()].map((d) => ({ ...d, hours: round1(d.hours) }));

  // everything the user did, newest first: PRs merged, reviews, Jira transitions and time entries
  const timeline = [
    ...prs.map((p) => ({ at: p.mergedAt, type: 'merged', title: p.title, url: p.url, ref: `${p.repo.split('/').pop()}#${p.number}`, ticket: p.ticket })),
    ...reviewed.filter((p) => p.reviewedAt).map((p) => ({ at: p.reviewedAt, type: 'reviewed', title: p.title, url: p.url, ref: `${p.repo.split('/').pop()}#${p.number}`, ticket: keyOf(p.title) })),
    ...tasks.filter((t) => t.movedAt).map((t) => ({ at: t.movedAt, type: t.statusCategory === 'done' ? 'closed' : 'moved', title: t.summary, url: t.url, ref: t.key, ticket: t.key,
      detail: t.fromStatus && t.toStatus ? `${t.fromStatus} → ${t.toStatus}` : t.status })),
    ...logged.map((e) => ({ at: e.end || e.start, type: 'time', title: e.description || '(sin descripción)', ref: e.project || '', ticket: e.ticket, detail: fmtH(e.hours), start: e.start })),
  ].filter((e) => e.at && Date.parse(e.at) >= w.from && Date.parse(e.at) <= w.to).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const done = tasks.filter((t) => t.statusCategory === 'done').length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (prs.length) parts.push(`mergeaste ${plural(prs.length, 'PR', 'PRs')} en ${plural(new Set(prs.map((p) => p.repo)).size, 'repo', 'repos')}`);
  if (reviewed.length) parts.push(`revisaste ${plural(reviewed.length, 'PR', 'PRs')}`);
  if (done) parts.push(`cerraste ${plural(done, 'tarea', 'tareas')}`);
  if (total) parts.push(`registraste ${fmtH(total)}`);
  const headline = parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : 'Sin actividad registrada en este período.';

  return {
    headline, byDay, timeline, loose: prs.filter((p) => !p.ticket),
    kind: w.kind, label: w.label, from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(),
    delivered: {
      prs, additions: prs.reduce((s, p) => s + (p.additions || 0), 0), deletions: prs.reduce((s, p) => s + (p.deletions || 0), 0),
      repos: [...new Set(prs.map((p) => p.repo))],
      leadHours: median(prs.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000)),
    },
    reviewed,
    tasks: {
      done: tasks.filter((t) => t.statusCategory === 'done'),
      other: tasks.filter((t) => !['done', 'indeterminate'].includes(t.statusCategory)),
      ...dailyTasks(open.filter((t) => t.sprint?.state === 'active' || loggedKeys.has(t.key) || (t.due && Date.parse(t.created) >= w.from)), w),
    },
    openPrs, reviewRequests,
    tickets,
    hours: { total: round1(total), byProject: [...byProject].map(([project, h]) => ({ project, hours: round1(h) })).sort((a, b) => b.hours - a.hours),
      unticketed: round1(logged.filter((e) => !e.ticket).reduce((s, e) => s + e.hours, 0)) },
  };
};


// Slack-flavoured markdown, ready to paste
export const toMarkdown = (s) => {
  const out = [`*${{ week: 'Resumen semanal', daily: 'Daily brief' }[s.kind] || 'Standup'}* · ${s.label}`, s.headline];
  const daily = s.kind === 'daily';
  const { prs } = s.delivered;
  if (prs.length) {
    out.push('', `*Entregado* (${prs.length} PR${prs.length === 1 ? '' : 's'} mergeado${prs.length === 1 ? '' : 's'})`);
    prs.forEach((p) => out.push(`• ${p.title} (<${p.url}|${p.repo.split('/').pop()}#${p.number}>)`));
  }
  if (s.tasks.done.length) {
    out.push('', '*Tareas cerradas*');
    s.tasks.done.forEach((t) => out.push(`• <${t.url}|${t.key}> ${t.summary}`));
  }
  if (s.tasks.inProgress.length) {
    out.push('', '*En curso*');
    s.tasks.inProgress.forEach((t) => out.push(`• <${t.url}|${t.key}> ${t.summary}`));
  }
  if (daily && s.tasks.waiting.length) {
    out.push('', '*Esperando*');
    s.tasks.waiting.forEach((t) => out.push(`• <${t.url}|${t.key}> ${t.summary} — ${t.status}`));
  }
  if (daily && s.tasks.due.length) {
    out.push('', '*Con vencimiento*');
    s.tasks.due.forEach((t) => out.push(`• <${t.url}|${t.key}> ${t.summary} — ${t.dueToday ? 'vence hoy' : t.overdue ? `venció ${t.due}` : `vence ${t.due}`}${t.fresh ? ' (nueva)' : ''}`));
  }
  if (daily && s.openPrs.length) {
    out.push('', '*PRs abiertos*');
    s.openPrs.forEach((p) => out.push(`• ${p.title} (<${p.url}|${p.repo.split('/').pop()}#${p.number}>)`));
  }
  if (daily && s.reviewRequests.length) {
    out.push('', '*Reviews pendientes*');
    s.reviewRequests.forEach((p) => out.push(`• ${p.title} (<${p.url}|${p.repo.split('/').pop()}#${p.number}>)`));
  }
  if (s.reviewed.length) {
    out.push('', `*Revisiones* (${s.reviewed.length})`);
    s.reviewed.forEach((p) => out.push(`• <${p.url}|${p.repo.split('/').pop()}#${p.number}> ${p.title}`));
  }
  if (s.hours.total) out.push('', `*Horas* ${fmtH(s.hours.total)}: ${s.hours.byProject.map((p) => `${p.project} ${fmtH(p.hours)}`).join(' · ')}`);
  if (s.kind === 'week' && s.delivered.leadHours != null) out.push(`Mediana abrir → merge: ${fmtH(s.delivered.leadHours)}`);
  return out.join('\n');
};

// first-person talking points to read out in the daily: sections → blocks (a lead line + bullets).
// Bullets carry the ticket key / url so the view can link them; toScript flattens the same data to plain text.
export const scriptSections = (s) => {
  const strip = (t) => t.replace(/^\s*\[[^\]]+\]\s*-?\s*/, '');
  const pr = (p) => ({ text: strip(p.title), ref: `${p.repo.split('/').pop()}#${p.number}`, url: p.url });
  const task = (t, note) => ({ text: t.summary, ref: t.key, url: t.url, ...(note ? { note } : {}) });
  const dueNote = (t) => (t.dueToday ? 'vence hoy' : t.overdue ? `venció ${t.due}` : `vence ${t.due}`);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const block = (lead, items = [], tone = '', pie = false) => ({ lead, items, tone, pie });

  const yesterday = [];
  const { prs } = s.delivered;
  if (prs.length) yesterday.push(block(`Mergeé ${plural(prs.length, 'PR', 'PRs')}`, prs.map(pr), 'ok'));
  if (s.tasks.done.length) yesterday.push(block('Cerré', s.tasks.done.map((t) => task(t)), 'ok'));
  if (s.reviewed.length) yesterday.push(block(`Hice ${plural(s.reviewed.length, 'review', 'reviews')}`));
  if (s.hours.total) yesterday.push(block(`Registré ${fmtH(s.hours.total)}`, s.hours.byProject.map((p) => ({ text: p.project, note: fmtH(p.hours), value: p.hours })), '', true));

  const today = [];
  if (s.tasks.inProgress.length) today.push(block('Estoy en', s.tasks.inProgress.map((t) => task(t)), 'info'));
  if (s.openPrs.length) today.push(block('Tengo abiertos', s.openPrs.map(pr)));
  if (s.tasks.waiting.length) today.push(block('Esperando', s.tasks.waiting.map((t) => task(t, t.status))));

  const pending = [];
  if (s.reviewRequests.length) pending.push(block('Reviews pendientes', s.reviewRequests.map(pr), 'warn'));
  if (s.tasks.due.length) pending.push(block('Con fecha', s.tasks.due.map((t) => task(t, dueNote(t))), 'warn'));

  return [
    { title: 'Ayer', blocks: yesterday.length ? yesterday : [block('Sin actividad registrada')] },
    { title: 'Hoy', blocks: today.length ? today : [block('Nada en curso explícito')] },
    ...(pending.length ? [{ title: 'Pendientes', blocks: pending }] : []),
  ];
};

export const toScript = (s) => {
  const line = (i) => `  • ${i.ref ? `${i.ref} ` : ''}${i.text}${i.note ? ` (${i.note})` : ''}`;
  const out = [`DAILY · ${s.label}`];
  scriptSections(s).forEach((sec) => {
    out.push('', sec.title.toUpperCase());
    sec.blocks.forEach((b) => out.push(b.items.length ? `${b.lead}:` : `${b.lead}.`, ...b.items.map(line)));
  });
  return out.join('\n');
};
