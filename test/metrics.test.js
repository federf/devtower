import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMetrics, rangeFor } from '../metrics.js';

const at = (iso) => new Date(iso).getTime();
const range = { days: 7, from: at('2026-11-12T00:00:00'), to: at('2026-11-18T12:00:00') };
const e = (description, project, start, end) => ({ description, project, start, end });

test('range only accepts 7, 14, 28 or 90 days and starts at local midnight', () => {
  assert.equal(rangeFor(99, at('2026-11-18T12:00:00')).days, 7);
  const r = rangeFor(14, at('2026-11-18T12:00:00'));
  assert.equal(new Date(r.from).getDate(), 5);
  assert.equal(new Date(r.from).getHours(), 0);
});

test('aggregates hours by project, ticket and untracked activity, and flags meetings and untracked load', () => {
  const m = buildMetrics({ range, ticketPattern: 'ITPCX-\\d+', entries: [
    e('[ITPCX-1]: fix', 'Core', '2026-11-16T09:00:00', '2026-11-16T10:00:00'),
    e('daily', 'Meeting', '2026-11-16T11:00:00', '2026-11-16T12:00:00'),
    e('daily', 'Meeting', '2026-11-17T11:00:00', '2026-11-17T12:00:00'),
    e('daily', 'Meeting', '2026-11-18T11:00:00', '2026-11-18T12:00:00'),
    e('viejo', 'Core', '2026-11-01T09:00:00', '2026-11-01T10:00:00'),
  ] });
  assert.equal(m.total, 4);
  assert.equal(m.workedDays, 3);
  assert.deepEqual(m.byProject.map((p) => [p.project, p.hours, p.pct]), [['Meeting', 3, 75], ['Core', 1, 25]]);
  assert.deepEqual(m.topTickets.map((t) => [t.key, t.hours]), [['ITPCX-1', 1]]);
  assert.deepEqual(m.recurring.map((u) => [u.label, u.count, u.hours]), [['daily', 3, 3]]);
  assert.equal(m.unticketed.pct, 75);
  assert.ok(m.insights.some((i) => /reuniones/.test(i.text)));
  assert.ok(m.insights.some((i) => /ticket en la descripción/.test(i.text)));
});

test('no entries yields zeroed metrics and no insights', () => {
  const m = buildMetrics({ range, entries: [] });
  assert.equal(m.total, 0);
  assert.deepEqual(m.insights, []);
});

test('flow metrics: PR lead and first-review time, size buckets and Jira cycle time', () => {
  const pr = (number, createdAt, firstReviewAt, mergedAt, additions) => ({ repo: 'o/r', number, title: `pr ${number}`, url: `u${number}`, createdAt, firstReviewAt, mergedAt, additions, deletions: 0 });
  const m = buildMetrics({ range, entries: [], workweek: { skipOffDays: false }, prs: [
    pr(1, '2026-11-16T00:00:00', '2026-11-16T02:00:00', '2026-11-16T04:00:00', 50),
    pr(2, '2026-11-13T00:00:00', '2026-11-15T00:00:00', '2026-11-17T00:00:00', 500),
    pr(3, '2026-11-13T00:00:00', '2026-11-15T00:00:00', '2026-11-17T00:00:00', 600),
  ], tasks: [
    { key: 'T-1', summary: 'a', url: 'j', created: '2026-11-01T00:00:00', started: '2026-11-10T00:00:00', resolved: '2026-11-16T00:00:00' },
    { key: 'T-2', summary: 'b', url: 'j', created: '2026-11-01T00:00:00', started: null, resolved: '2026-11-16T00:00:00' },
  ] });
  assert.equal(m.flow.prs.count, 3);
  assert.equal(m.flow.prs.leadHours, 96);
  assert.equal(m.flow.prs.firstReviewHours, 48);
  assert.deepEqual(m.flow.prs.bySize.map((b) => [b.count, b.leadHours]), [[1, 4], [2, 96]]);
  assert.equal(m.flow.prs.slowest[0].leadHours, 96);
  assert.equal(m.flow.tasks.cycleHours, 144);
  assert.equal(m.flow.tasks.withStart, 1);
  assert.ok(m.flow.insights.some((i) => /PRs grandes/.test(i.text)));
  assert.ok(m.flow.insights.some((i) => /primera review/.test(i.text)));
});

test('review rounds, reviews given vs received, status time, reopens, effort and WIP', () => {
  const now = at('2026-11-18T12:00:00');
  const pr = (number, changeRequests, reviewCount) => ({ repo: 'o/r', number, title: `pr ${number}`, url: 'u', createdAt: '2026-11-16T00:00:00', mergedAt: '2026-11-17T00:00:00', additions: 10, deletions: 0, changeRequests, reviewCount });
  const m = buildMetrics({ range, now, workweek: { skipOffDays: false }, ticketPattern: 'T-\\d+',
    entries: [e('[T-1]: x', 'Core', '2026-11-16T09:00:00', '2026-11-16T13:00:00')],
    prs: [pr(1, 0, 1), pr(2, 2, 3)],
    reviewsGiven: [{ repo: 'o/r', number: 9, submittedAt: '2026-11-17T10:00:00' }, { repo: 'o/r', number: 9, submittedAt: '2026-11-17T11:00:00' }],
    openPrs: [{ repo: 'o/r', number: 5, title: 'old', url: 'u', createdAt: '2026-11-08T12:00:00', draft: true }],
    wipTasks: [{ key: 'T-5', summary: 'wip', url: 'j' }],
    tasks: [{ key: 'T-1', summary: 'a', url: 'j', created: '2026-11-10T00:00:00', started: '2026-11-12T00:00:00', resolved: '2026-11-16T00:00:00', stages: { 'En curso': 48, QA: 12 }, reopened: 1 }] });
  const f = m.flow;
  assert.deepEqual([f.prs.rounds.avg, f.prs.rounds.withChanges], [1, 50]);
  assert.deepEqual([f.reviews.given, f.reviews.givenPrs, f.reviews.received], [2, 1, 4]);
  assert.deepEqual(f.tasks.stages.map((s) => s.status), ['En curso', 'QA']);
  assert.equal(f.tasks.reopened.count, 1);
  assert.deepEqual([f.tasks.effort[0].loggedHours, f.tasks.effort[0].cycleHours], [4, 96]);
  assert.deepEqual([f.wip.tasks, f.wip.openPrs, f.wip.oldest[0].days], [1, 1, 10]);
  assert.ok(f.insights.some((i) => /PRs abiertos lleva/.test(i.text)));
  assert.equal(m.streak, 0);
});

test('WIP rolls subtasks up into their parent task', () => {
  const m = buildMetrics({ range, wipSprint: 'Sprint 9', wipTasks: [
    { key: 'T-1', summary: 'a', url: 'j', status: 'En curso' },
    { key: 'T-2', summary: 'sub', url: 'j', status: 'En curso', parent: 'T-1' },
    { key: 'T-3', summary: 'b', url: 'j', status: 'En curso' },
  ] });
  assert.equal(m.flow.wip.tasks, 2);
  assert.equal(m.flow.wip.sprint, 'Sprint 9');
  assert.equal(m.flow.wip.taskList.length, 3);
});

test('trends bucket hours, PRs and tasks into Monday-start weeks and report direction', async () => {
  const { buildTrends, weeksFor } = await import('../trends.js');
  const now = at('2026-11-18T12:00:00'); // Wednesday
  const weeks = weeksFor(4, now);
  assert.equal(weeks.length, 4);
  assert.equal(new Date(weeks[3].from).getDay(), 1);
  assert.equal(weeks[3].current, true);
  const t = buildTrends({ weeks, workweek: { skipOffDays: false },
    entries: [e('x', 'Core', '2026-11-16T09:00:00', '2026-11-16T11:00:00'), e('d', 'Meeting', '2026-11-09T09:00:00', '2026-11-09T10:00:00')],
    prs: [{ createdAt: '2026-11-16T00:00:00', mergedAt: '2026-11-17T00:00:00' }, { createdAt: '2026-11-10T00:00:00', mergedAt: '2026-11-10T12:00:00' }, { createdAt: '2026-11-10T00:00:00', mergedAt: '2026-11-11T00:00:00' }],
    tasks: [{ resolved: '2026-11-17T00:00:00', started: '2026-11-14T00:00:00' }] });
  assert.deepEqual(t.weeks.map((w) => w.prs), [0, 0, 2, 1]);
  assert.deepEqual([t.weeks[3].hours, t.weeks[2].meetingsPct], [2, 100]);
  assert.equal(t.weeks[3].cycleHours, 72);
  assert.equal(t.weeks[3].prLeadHours, 24);
});

test('workweek splits hours into normal, outside and non-working days, and elapsed time skips off days', async () => {
  const { elapsedHours, normalizeWorkweek, splitHours } = await import('../workweek.js');
  const ww = normalizeWorkweek({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
  // Fri 16:00 → Fri 20:00: 2 h inside, 2 h after hours
  const fri = splitHours(at('2026-11-20T16:00:00'), at('2026-11-20T20:00:00'), ww);
  assert.deepEqual([fri.normal, fri.outside, fri.offDay], [2, 2, 0]);
  // Sat 10:00 → 12:00 is a non-working day
  const sat = splitHours(at('2026-11-21T10:00:00'), at('2026-11-21T12:00:00'), ww);
  assert.deepEqual([sat.normal, sat.outside, sat.offDay], [0, 0, 2]);
  // opened Fri 12:00, merged Mon 12:00: 72 h wall clock, 24 h without the weekend
  assert.equal(elapsedHours('2026-11-20T12:00:00', '2026-11-23T12:00:00', ww), 24);
  assert.equal(elapsedHours('2026-11-20T12:00:00', '2026-11-23T12:00:00', { ...ww, skipOffDays: false }), 72);
  assert.deepEqual(normalizeWorkweek({ days: [], start: '20:00', end: '08:00' }).days, [1, 2, 3, 4, 5]);
});

test('metrics report extra hours, hide empty weekend columns and skip weekends in PR lead time', () => {
  const m = buildMetrics({ range: { days: 7, from: at('2026-11-16T00:00:00'), to: at('2026-11-22T23:00:00') }, now: at('2026-11-22T23:00:00'),
    workweek: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', skipOffDays: true },
    entries: [e('a', 'Core', '2026-11-16T09:00:00', '2026-11-16T12:00:00'), e('b', 'Core', '2026-11-17T17:00:00', '2026-11-17T20:00:00'), e('c', 'Core', '2026-11-21T10:00:00', '2026-11-21T12:00:00')],
    prs: [{ repo: 'o/r', number: 1, title: 't', url: 'u', createdAt: '2026-11-20T12:00:00', mergedAt: '2026-11-23T12:00:00', additions: 1, deletions: 0 }] });
  assert.deepEqual([m.schedule.normal, m.schedule.outside, m.schedule.offDay, m.schedule.extra], [4, 2, 2, 4]);
  assert.equal(m.schedule.extraPct, 50);
  assert.deepEqual(m.byDay.map((d) => d.weekday), ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']); // Sunday has no hours and is off
  assert.equal(m.flow.prs.leadHours, 24);
  assert.ok(m.insights.some((i) => /fuera de tu horario laboral/.test(i.text)));
});
