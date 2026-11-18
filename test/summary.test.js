import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSummary, toMarkdown, windowFor } from '../summary.js';

const at = (iso) => new Date(iso).getTime();

test('standup on Monday looks back to Friday; midweek to yesterday; week is 7 days', () => {
  const mon = windowFor('standup', at('2026-11-16T10:00:00'));
  assert.equal(new Date(mon.from).getDay(), 5);
  assert.equal(mon.label, 'Desde el viernes');
  const tue = windowFor('standup', at('2026-11-17T10:00:00'));
  assert.equal(new Date(tue.from).getDate(), 16);
  assert.equal(tue.label, 'Ayer');
  assert.equal(new Date(windowFor('standup', at('2026-11-15T10:00:00')).from).getDay(), 5);
  const week = windowFor('week', at('2026-11-17T10:00:00'));
  assert.equal(new Date(week.from).getDate(), 11);
});

test('joins PRs, Jira movement and Clockify hours by ticket and ignores out-of-window items', () => {
  const w = { kind: 'standup', label: 'Ayer', from: at('2026-11-16T00:00:00'), to: at('2026-11-17T10:00:00') };
  const s = buildSummary({
    window: w, ticketPattern: 'ITPCX-\\d+',
    merged: [
      { repo: 'o/r', number: 1, title: '[ITPCX-1] fix', url: 'u1', createdAt: '2026-11-16T08:00:00', mergedAt: '2026-11-16T10:00:00', additions: 5, deletions: 2 },
      { repo: 'o/r', number: 2, title: 'old', url: 'u2', createdAt: '2026-11-01T08:00:00', mergedAt: '2026-11-02T10:00:00', additions: 9, deletions: 9 },
    ],
    tasks: [{ key: 'ITPCX-1', summary: 'Fix', status: 'Listo', statusCategory: 'done', url: 'j1' }],
    entries: [
      { description: '[ITPCX-1]: fix', project: 'Core', start: '2026-11-16T09:00:00', end: '2026-11-16T10:30:00' },
      { description: 'Meeting', project: 'Meeting', start: '2026-11-16T11:00:00', end: '2026-11-16T11:30:00' },
      { description: 'older', project: 'Core', start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00' },
    ],
  });
  assert.equal(s.delivered.prs.length, 1);
  assert.equal(s.delivered.additions, 5);
  assert.equal(s.hours.total, 2);
  assert.equal(s.hours.unticketed, 0.5);
  assert.deepEqual(s.tickets.map((t) => [t.key, t.prs.length, t.hours]), [['ITPCX-1', 1, 1.5]]);
  assert.deepEqual(s.hours.byProject.map((p) => p.project), ['Core', 'Meeting']);
});

test('markdown is Slack-flavoured and skips empty sections', () => {
  const w = { kind: 'standup', label: 'Ayer', from: 0, to: 10 };
  const s = buildSummary({ window: w });
  assert.equal(toMarkdown(s), '*Standup* · Ayer\nSin actividad registrada en este período.');
  const full = buildSummary({ window: { ...w, from: at('2026-11-16T00:00:00'), to: at('2026-11-17T00:00:00') },
    merged: [{ repo: 'o/r', number: 7, title: 'feat x', url: 'https://gh/7', createdAt: '2026-11-16T01:00:00', mergedAt: '2026-11-16T02:00:00' }] });
  assert.match(toMarkdown(full), /\*Entregado\* \(1 PR mergeado\)\n• feat x \(<https:\/\/gh\/7\|r#7>\)/);
});

test('daily buckets and headline count shipped, reviewed and logged work', () => {
  const w = { kind: 'week', label: 'x', from: at('2026-11-15T00:00:00'), to: at('2026-11-17T12:00:00') };
  const s = buildSummary({
    window: w,
    merged: [{ repo: 'o/a', number: 1, title: 't', url: 'u', createdAt: '2026-11-16T01:00:00', mergedAt: '2026-11-16T05:00:00' }],
    reviewed: [{ repo: 'o/b', number: 2, title: 'r', url: 'u', reviewedAt: '2026-11-17T09:00:00' }],
    entries: [{ description: 'x', project: 'P', start: '2026-11-16T09:00:00', end: '2026-11-16T11:00:00' }],
  });
  assert.deepEqual(s.byDay.map((d) => [d.date, d.prs, d.reviews, d.hours]), [['2026-11-15', 0, 0, 0], ['2026-11-16', 1, 0, 2], ['2026-11-17', 0, 1, 0]]);
  assert.equal(s.headline, 'Mergeaste 1 PR en 1 repo, revisaste 1 PR, registraste 2 h.');
  assert.equal(s.loose.length, 1);
});

test('timeline merges every kind of event, newest first, using Jira transition time', () => {
  const w = { kind: 'standup', label: 'x', from: at('2026-11-16T00:00:00'), to: at('2026-11-17T12:00:00') };
  const s = buildSummary({
    window: w, ticketPattern: 'ITPCX-\\d+',
    merged: [{ repo: 'o/r', number: 1, title: '[ITPCX-1] fix', url: 'u', createdAt: '2026-11-16T08:00:00', mergedAt: '2026-11-16T10:00:00' }],
    reviewed: [{ repo: 'o/b', number: 2, title: 'r', url: 'u', reviewedAt: '2026-11-17T09:00:00' }],
    tasks: [{ key: 'ITPCX-1', summary: 'Fix', status: 'Listo', statusCategory: 'done', url: 'j', movedAt: '2026-11-16T17:30:00', fromStatus: 'En curso', toStatus: 'Listo' }],
    entries: [{ description: 'work', project: 'P', start: '2026-11-16T12:00:00', end: '2026-11-16T13:00:00' }],
  });
  assert.deepEqual(s.timeline.map((e) => e.type), ['reviewed', 'closed', 'time', 'merged']);
  assert.equal(s.timeline[1].detail, 'En curso → Listo');
});
