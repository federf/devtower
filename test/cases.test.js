import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, collectCases, mergeCases, nextToProcess, parseResult } from '../cases.js';

const item = (id, over = {}) => ({ id, source: 'slack', title: id, from: 'Ana', text: 'hola', at: '2026-11-19T10:00:00Z', sev: 3, ...over });
const NOW = Date.parse('2026-11-19T12:00:00Z');

test('mergeCases: agrega nuevos, conserva propuestas y cierra los que dejaron de estar pendientes', () => {
  let store = mergeCases({}, [item('a'), item('b')], NOW);
  assert.equal(store.a.status, 'new');
  store.a = { ...store.a, status: 'ready', proposal: { summary: 'x' } };
  store = mergeCases(store, [item('a', { text: 'editado' })], NOW + 1000);
  assert.equal(store.a.status, 'ready');
  assert.equal(store.a.proposal.summary, 'x');
  assert.equal(store.a.text, 'editado');
  assert.equal(store.b.status, 'resolved');
  store.a.status = 'dismissed';
  assert.equal(mergeCases(store, [item('a')], NOW + 2000).a.status, 'dismissed');
  assert.equal(mergeCases(store, [], NOW + 20 * 86_400_000).b, undefined);
});

test('nextToProcess: más urgente primero, respeta el tope por hora y no corre en paralelo', () => {
  const store = mergeCases({}, [item('lento', { sev: 3 }), item('urgente', { sev: 1 }), item('medio', { sev: 2 })], NOW);
  assert.equal(nextToProcess(store, { now: NOW }).id, 'urgente');
  const busy = { ...store, urgente: { ...store.urgente, status: 'processing' } };
  assert.equal(nextToProcess(busy, { now: NOW }), null);
  const capped = Object.fromEntries(Object.entries(store).map(([k, c]) => [k, { ...c, lastRunAt: new Date(NOW - 60_000).toISOString() }]));
  assert.equal(nextToProcess(capped, { now: NOW, maxPerHour: 3 }), null);
  assert.ok(nextToProcess(capped, { now: NOW, maxPerHour: 3, manual: true }));
  const failed = { ...store, urgente: { ...store.urgente, failedAt: 'x' } };
  assert.equal(nextToProcess(failed, { now: NOW }).id, 'medio');
});

test('parseResult: valida y recorta la propuesta de Claude', () => {
  const r = parseResult('texto previo {"summary":"S","proposal":"P","reply":"R","questions":[{"id":"q 1!","text":"¿A o B?","options":["A","B"]},{"text":""}],"actions":[{"type":"comment","label":"Comentar","text":"hola","target":"ABC-1"},{"type":"x","text":""}]} fin');
  assert.equal(r.summary, 'S');
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].id, 'q1');
  assert.deepEqual(r.questions[0].options, ['A', 'B']);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].target, 'ABC-1');
  assert.throws(() => parseResult('sin json'));
});

test('buildPrompt incluye respuestas previas y collectCases unifica fuentes', () => {
  const c = { ...item('a'), proposal: { summary: 'S', proposal: 'P', questions: [{ id: 'q1', text: '¿A o B?' }] }, answers: { q1: 'A' }, note: 'más corto' };
  const p = buildPrompt(c, { userName: 'Fede' });
  assert.match(p, /¿A o B\? → A/);
  assert.match(p, /más corto/);
  const cases = collectCases({
    now: Date.parse('2026-11-19T12:00:00Z'),
    jira: [{ key: 'J-1', summary: 'x', status: 'Por Hacer', statusCategory: 'new', sprint: { state: 'active', start: '2026-11-10T00:00:00Z' }, updated: 'z', url: 'u' }],
    slack: [{ id: 's1', channel: '#dev', author: 'Ana', text: 'hola', kind: 'mention', ts: '2026-11-19T10:00:00Z' }, { id: 's0', channel: '#dev', author: 'Ana', text: 'viejo', kind: 'dm', ts: '2026-11-01T10:00:00Z' }],
    gmail: [{ id: 'gmail:t1', threadId: 't1', channel: 'Asunto', author: 'Bo', email: 'bo@x.com', text: 'x', ts: '2026-11-19T10:00:00Z', unread: true, permalink: 'https://mail' }],
  });
  assert.deepEqual(cases.map((x) => [x.id, x.source, x.sev]), [['jira:J-1', 'jira', 3], ['slack:s1', 'slack', 2], ['gmail:t1', 'gmail', 2]]);
});

test('collectCases: solo tareas abiertas del sprint activo', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const j = (key, over = {}) => ({ key, summary: `S ${key}`, status: 'x', statusCategory: 'new', priority: 'Importante', type: 'Tarea', updated: 'z', url: `u/${key}`, sprint: { state: 'active' }, ...over });
  const cases = collectCases({ now, jira: [j('A-1'), j('A-2', { statusCategory: 'indeterminate' }), j('A-3', { sprint: null }), j('A-4', { statusCategory: 'done' }), j('A-5', { viaParent: true }), j('A-6', { sprint: { state: 'future' } })] });
  assert.deepEqual(cases.map((c) => c.id), ['jira:A-1', 'jira:A-2']);
  assert.match(buildPrompt(cases[0]), /enfoque de desarrollo/);
});

test('parseResult: propuesta estructurada (alcance, pasos, archivos, riesgos, pruebas, estimación)', () => {
  const r = parseResult(JSON.stringify({ summary: 'S', scope: ['a', 'b'], steps: ['uno', '', 'dos'], files: [{ path: 'app/X.php', change: 'validar' }, { path: '' }], risks: ['r'], tests: ['t'], estimate: 'M · ~3 h', proposal: '', reply: '', questions: [], actions: [] }));
  assert.deepEqual(r.scope, ['a', 'b']);
  assert.deepEqual(r.steps, ['uno', 'dos']);
  assert.deepEqual(r.files, [{ path: 'app/X.php', change: 'validar' }]);
  assert.equal(r.estimate, 'M · ~3 h');
  assert.deepEqual(parseResult('{"summary":"x"}').steps, []);
});
