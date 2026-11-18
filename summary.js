// Standup / weekly summary: pure aggregation of what the user shipped, reviewed, moved in Jira and logged
// in Clockify inside a time window. Sources are fetched elsewhere; nothing here touches the network.

const DAY_MS = 86_400_000;
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const round1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

// standup looks back to the last working day (Monday → Friday); week is the last 7 days
export const windowFor = (kind, now = Date.now()) => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (kind === 'week') return { kind, from: day.getTime() - 6 * DAY_MS, to: now, label: 'Últimos 7 días' };
  const back = [2, 3, 1, 1, 1, 1, 1][day.getDay()]; // Sun→Fri, Mon→Fri, otherwise yesterday
  const from = day.getTime() - back * DAY_MS;
  const when = new Date(from);
  return { kind: 'standup', from, to: now, label: back === 1 ? 'Ayer' : `Desde el ${DAYS[when.getDay()]}` };
};

const fmtH = (h) => (h >= 1 ? `${round1(h)} h` : `${Math.round(h * 60)} min`);

const entryHours = (e, to) => (Math.min(Date.parse(e.end || new Date(to)), to) - Math.max(Date.parse(e.start), 0)) / 3_600_000;

export const buildSummary = ({ window: w, merged = [], reviewed = [], tasks = [], entries = [], ticketPattern = '' }) => {
  const TICKET = ticketPattern ? new RegExp(`\\b(?:${ticketPattern})\\b`) : null;
  const keyOf = (text) => (TICKET && TICKET.exec(text || '')?.[0]) || null;
  const inWindow = (ts) => Date.parse(ts) >= w.from && Date.parse(ts) <= w.to;

  const prs = merged.filter((p) => inWindow(p.mergedAt)).map((p) => ({ ...p, ticket: keyOf(p.title) }));
  const logged = entries.filter((e) => e.start && Date.parse(e.start) >= w.from && Date.parse(e.start) <= w.to)
    .map((e) => ({ ...e, hours: entryHours(e, w.to), ticket: e.ticket || keyOf(e.description) })).filter((e) => e.hours > 0);

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
      inProgress: tasks.filter((t) => t.statusCategory === 'indeterminate'),
      other: tasks.filter((t) => !['done', 'indeterminate'].includes(t.statusCategory)),
    },
    tickets,
    hours: { total: round1(total), byProject: [...byProject].map(([project, h]) => ({ project, hours: round1(h) })).sort((a, b) => b.hours - a.hours),
      unticketed: round1(logged.filter((e) => !e.ticket).reduce((s, e) => s + e.hours, 0)) },
  };
};


// Slack-flavoured markdown, ready to paste
export const toMarkdown = (s) => {
  const out = [`*${s.kind === 'week' ? 'Resumen semanal' : 'Standup'}* · ${s.label}`, s.headline];
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
    s.tasks.inProgress.forEach((t) => out.push(`• <${t.url}|${t.key}> ${t.summary} — ${t.status}`));
  }
  if (s.reviewed.length) {
    out.push('', `*Revisiones* (${s.reviewed.length})`);
    s.reviewed.forEach((p) => out.push(`• <${p.url}|${p.repo.split('/').pop()}#${p.number}> ${p.title}`));
  }
  if (s.hours.total) out.push('', `*Horas* ${fmtH(s.hours.total)}: ${s.hours.byProject.map((p) => `${p.project} ${fmtH(p.hours)}`).join(' · ')}`);
  if (s.kind === 'week' && s.delivered.leadHours != null) out.push(`Mediana abrir → merge: ${fmtH(s.delivered.leadHours)}`);
  return out.join('\n');
};
