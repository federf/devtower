// Weekly trend series for the Métricas view: hours, meetings share, merged PRs and lead time, tasks closed and cycle time.
// Pure aggregation (like metrics.js): the server feeds it Clockify entries, merged PRs and resolved Jira tasks.

import { elapsedHours, normalizeWorkweek, splitHours } from './workweek.js';

const DAY_MS = 86_400_000;
const round1 = (n) => Math.round(n * 10) / 10;
const MEETING = /meeting|reuni/i;
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const dayLabel = (ms) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const dayStr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Monday-start local weeks, oldest first; the last one runs until `now`
export const weeksFor = (count, now = Date.now()) => {
  const n = Math.min(Math.max(Math.round(count) || 12, 4), 26);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const monday = today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS;
  return Array.from({ length: n }, (_, i) => {
    const from = monday - (n - 1 - i) * 7 * DAY_MS;
    return { from, to: Math.min(from + 7 * DAY_MS - 1, now), label: dayLabel(from), current: i === n - 1 };
  });
};

export const buildTrends = ({ weeks, entries = [], prs = [], tasks = [], workweek }) => {
  const ww = normalizeWorkweek(workweek);
  const hoursBetween = (a, b) => elapsedHours(a, b, ww);
  const inWeek = (w, iso) => { const t = Date.parse(iso); return t >= w.from && t <= w.to; };
  const rows = weeks.map((w) => {
    const logged = entries.filter((e) => e.start && inWeek(w, e.start))
      .map((e) => { const end = Math.min(Date.parse(e.end || new Date(w.to)), w.to); return { project: e.project || '', day: new Date(e.start).toDateString(), hours: (end - Date.parse(e.start)) / 3_600_000, split: splitHours(Date.parse(e.start), end, ww) }; })
      .filter((e) => e.hours > 0);
    const total = logged.reduce((s, e) => s + e.hours, 0);
    const extra = logged.reduce((s, e) => s + e.split.outside + e.split.offDay, 0);
    const workedDays = new Set(logged.map((e) => e.day)).size;
    const meetings = logged.filter((e) => MEETING.test(e.project)).reduce((s, e) => s + e.hours, 0);
    const wp = prs.filter((p) => p.mergedAt && inWeek(w, p.mergedAt));
    const wt = tasks.filter((t) => t.resolved && inWeek(w, t.resolved));
    return {
      label: w.label, current: w.current,
      hours: round1(total), extraHours: round1(extra), avgPerDay: workedDays ? round1(total / workedDays) : null, meetingsPct: total ? Math.round((meetings / total) * 100) : 0,
      prs: wp.length, prLeadHours: wp.length ? round1(median(wp.map((p) => hoursBetween(p.createdAt, p.mergedAt)))) : null,
      tasks: wt.length, cycleHours: round1(median(wt.map((t) => hoursBetween(t.started, t.resolved))) ?? NaN) || null,
    };
  });
  // direction of the last 4 closed weeks against the 4 before (the week in progress is left out: it is partial)
  const trend = (key) => {
    const vals = rows.filter((r) => !r.current).map((r) => r[key]);
    const avg = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const recent = avg(vals.slice(-4)); const before = avg(vals.slice(-8, -4));
    return recent == null || before == null || !before ? null : Math.round(((recent - before) / before) * 100);
  };
  return { weeks: rows, deltas: Object.fromEntries(['hours', 'extraHours', 'avgPerDay', 'meetingsPct', 'prs', 'prLeadHours', 'tasks', 'cycleHours'].map((k) => [k, trend(k)])) };
};
