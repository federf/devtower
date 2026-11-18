import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSummary, toMarkdown, toScript, windowFor } from '../summary.js';

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

test('daily covers only sprint, Clockify-logged or fresh tasks with a due date; only explicit "En curso" is in progress; due drops stale dates', () => {
  const w = { kind: 'daily', label: 'Ayer', from: at('2026-11-17T00:00:00'), to: at('2026-11-18T10:00:00') };
  const sprint = { state: 'active' };
  const t = (key, status, statusCategory, extra = {}) => ({ key, summary: key, status, statusCategory, url: key, due: '', created: '2026-11-01T00:00:00', sprint, ...extra });
  const s = buildSummary({ window: w, ticketPattern: '[A-I]',
    entries: [{ description: 'C trabajo', project: 'Core', start: '2026-11-17T09:00:00', end: '2026-11-17T10:00:00' }],
    open: [
      t('A', 'En curso', 'indeterminate'),
      t('B', 'Seleccionado para desarrollo', 'new', { due: '2026-11-18', created: '2026-11-17T15:00:00' }),
      t('C', 'Esperando por el cliente', 'indeterminate', { sprint: null }),
      t('D', 'Backlog', 'new', { due: '2019-01-04' }),
      t('E', 'Backlog', 'new', { due: '2026-11-30' }),
      t('F', 'Backlog', 'new', { due: '2026-12-30' }),
      t('G', 'En curso', 'indeterminate', { sprint: null }),
      t('H', 'Backlog', 'new', { due: '2026-11-19', sprint: null }),
      t('I', 'Seleccionado para desarrollo', 'new', { due: '2026-11-18', sprint: null, created: '2026-11-17T15:43:00' }),
    ] });
  assert.deepEqual(s.tasks.inProgress.map((x) => x.key), ['A']);
  assert.deepEqual(s.tasks.waiting.map((x) => x.key), ['C']);
  assert.deepEqual(s.tasks.due.map((x) => [x.key, x.dueToday, x.fresh]), [['B', true, true], ['I', true, true], ['E', false, false]]);
  assert.match(toMarkdown(s), /\*Con vencimiento\*\n• <B\|B> B — vence hoy \(nueva\)/);
});

test('script is plain first-person talking points', () => {
  const w = { kind: 'daily', label: 'Ayer', from: at('2026-11-17T00:00:00'), to: at('2026-11-18T10:00:00') };
  const s = buildSummary({ window: w, merged: [{ repo: 'o/r', number: 1, title: '[X-1] - feat a', url: 'u', createdAt: '2026-11-17T01:00:00', mergedAt: '2026-11-17T02:00:00' }],
    open: [{ key: 'X-2', summary: 'Hacer b', status: 'En curso', statusCategory: 'indeterminate', url: 'j', sprint: { state: 'active' }, due: '', created: '' }] });
  const text = toScript(s);
  assert.match(text, /AYER\nMergeé 1 PR:\n  • r#1 feat a/);
  assert.match(text, /HOY\nEstoy en:\n  • X-2 Hacer b/);
  assert.doesNotMatch(text, /https?:/);
});

test("standup hours stop at midnight: today's Clockify entries are not counted as yesterday", () => {
  const w = { kind: 'standup', label: 'Ayer', from: at('2026-11-17T00:00:00'), to: at('2026-11-18T11:40:00') };
  const s = buildSummary({ window: w, entries: [
    { description: 'ayer', project: 'Core', start: '2026-11-17T16:00:00', end: '2026-11-17T17:00:00' },
    { description: 'cruza medianoche', project: 'Core', start: '2026-11-17T23:30:00', end: '2026-11-18T00:30:00' },
    { description: 'hoy', project: 'Meeting', start: '2026-11-18T09:00:00', end: '2026-11-18T10:00:00' },
  ] });
  assert.equal(s.hours.total, 1.5);
  assert.deepEqual(s.hours.byProject.map((p) => p.project), ['Core']);
  const week = buildSummary({ window: { ...w, kind: 'week' }, entries: [{ description: 'hoy', project: 'Meeting', start: '2026-11-18T09:00:00', end: '2026-11-18T10:00:00' }] });
  assert.equal(week.hours.total, 1);
});
