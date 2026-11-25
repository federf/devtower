// Casos: lo que requiere tu atención (Slack, Gmail, PRs) como una cola única que Claude analiza.
// Módulo puro: unifica fuentes, elige qué analizar (con tope por hora) y arma/valida el prompt y la respuesta.
// Claude solo lee y propone; enviar o comentar siempre lo confirma el usuario.

const DAY = 86_400_000;
const KEEP_CLOSED_MS = 14 * DAY;
const cap = (v, n) => String(v ?? '').slice(0, n);

// incoming: [{ id, source, title, from, text, link, at, sev, ref? }] → store (id → case)
export const mergeCases = (store, incoming, now = Date.now()) => {
  const next = {};
  const live = new Set(incoming.map((i) => i.id));
  for (const [id, c] of Object.entries(store)) {
    const closed = ['dismissed', 'done', 'resolved'].includes(c.status);
    if (closed && now - Date.parse(c.closedAt || c.createdAt) > KEEP_CLOSED_MS) continue;
    if (!live.has(id) && !closed) next[id] = c.status === 'processing' ? c : { ...c, status: 'resolved', closedAt: new Date(now).toISOString() };
    else next[id] = c;
  }
  for (const i of incoming) {
    const prev = next[i.id];
    if (!prev) next[i.id] = { ...i, status: 'new', createdAt: new Date(now).toISOString(), runs: 0 };
    else if (!['dismissed', 'done'].includes(prev.status)) next[i.id] = { ...prev, ...i, status: prev.status === 'resolved' ? 'new' : prev.status, closedAt: undefined,
      proposal: prev.proposal, answers: prev.answers, processedAt: prev.processedAt, createdAt: prev.createdAt, runs: prev.runs };
    else next[i.id] = { ...prev, text: i.text };
  }
  return next;
};

export const nextToProcess = (store, { now = Date.now(), maxPerHour = 6, manual = false } = {}) => {
  const all = Object.values(store);
  if (all.some((c) => c.status === 'processing')) return null;
  if (!manual && all.filter((c) => c.lastRunAt && now - Date.parse(c.lastRunAt) < 3_600_000).length >= maxPerHour) return null;
  return all.filter((c) => c.status === 'new' && !c.failedAt)
    .sort((a, b) => (a.sev ?? 3) - (b.sev ?? 3) || Date.parse(b.at || 0) - Date.parse(a.at || 0))[0] || null;
};

const SOURCE = { slack: 'mensaje de Slack', gmail: 'hilo de correo (Gmail)', pr: 'pull request', jira: 'tarea de Jira pendiente' };

export const buildPrompt = (c, { userName = '', context = '', jira = [], project = '' } = {}) => {
  const prior = c.proposal ? `\nYa analizaste este caso antes. Tu propuesta anterior:\n${cap(c.proposal.summary, 600)}\n${(c.proposal.steps || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}\n${cap(c.proposal.proposal, 2500)}\n${c.answers && Object.keys(c.answers).length ? `Mis respuestas a tus dudas:\n${Object.entries(c.answers).map(([id, a]) => `- ${cap((c.proposal.questions || []).find((q) => q.id === id)?.text || id, 200)} → ${cap(a, 600)}`).join('\n')}\n` : ''}${c.note ? `Indicación mía: ${cap(c.note, 800)}\n` : ''}Ajustá la propuesta con esto y resolvé las dudas que ya respondí.\n` : '';
  return `Sos el asistente de ${userName || 'un desarrollador'}. Un caso necesita su atención: ${SOURCE[c.source] || c.source}.
Título: ${cap(c.title, 200)}
De: ${cap(c.from, 120)}
Cuándo: ${c.at || 'reciente'}
${c.link ? `Link: ${c.link}\n` : ''}Contenido:
"""
${cap(context || c.text, 8000)}
"""
${jira.length ? `\nTickets de Jira mencionados:\n${jira.map((j) => `- ${j.key} «${cap(j.summary, 160)}» (${j.status}${j.assignee ? `, ${j.assignee}` : ''})${j.description ? `: ${cap(j.description, 500)}` : ''}`).join('\n')}\n` : ''}${prior}
${project ? `El directorio actual es el proyecto «${project}»: trabajá sobre su código.\n` : ''}Hacé un análisis RÁPIDO (pocas lecturas, solo lo necesario). Entendé el caso con los datos que puedas recuperar (código en el directorio actual, git log, tickets, el hilo completo) y proponé cómo resolverlo.${c.source === 'jira' ? ' Es una tarea que tengo que desarrollar: ubicá en los repos (subdirectorios del directorio actual) dónde se toca, y proponé el enfoque de desarrollo (archivos y funciones a modificar, pasos, tests, riesgos) y qué falta definir del pedido.' : ''} SOLO LECTURA: no edites archivos, no ejecutes nada que modifique, no envíes ni comentes nada.
Respondé ÚNICAMENTE un JSON válido (sin markdown alrededor) con esta forma:
{"summary":"1-2 frases: qué se pide y por qué importa","scope":["punto concreto de lo que hay que lograr (máx 4)"],"steps":["paso de la solución, accionable y en orden (máx 8)"],"files":[{"path":"ruta/relativa/al/repo.php","change":"qué cambiaría ahí, en una línea"}],"risks":["riesgo o cosa a vigilar (máx 4)"],"tests":["prueba a hacer o escribir (máx 4)"],"estimate":"tamaño y horas, ej. «M · ~3 h»","proposal":"solo si hace falta un detalle extra en markdown corto; si no, vacío","reply":"borrador de respuesta listo para enviar, en español rioplatense, primera persona; vacío si no corresponde responder","questions":[{"id":"q1","text":"duda concreta que solo yo puedo resolver","options":["opción A","opción B"]}],"actions":[{"type":"reply|comment","label":"texto del botón","text":"contenido a enviar","target":"clave de Jira solo para comment"}]}
Reglas: cada ítem de las listas es UNA oración corta (sin párrafos). Para casos que no son de desarrollo (una consulta, un mensaje) dejá files/tests vacíos y poné lo importante en steps y reply. Máximo 4 preguntas, solo las que cambian la solución (si no hay dudas, array vacío); "options" opcional. Acciones: "reply" responde en la misma fuente; "comment" comenta en el ticket de Jira indicado en "target". No inventes datos: si algo no lo sabés, hacelo una pregunta.`;
};

const strOf = (v, n) => cap(typeof v === 'string' ? v : '', n).trim();
const list = (v, max) => (Array.isArray(v) ? v : []).slice(0, max).map((x) => strOf(x, 300)).filter(Boolean);
export const parseResult = (text) => {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to < from) throw new Error('Claude no devolvió una propuesta con el formato esperado');
  const raw = JSON.parse(text.slice(from, to + 1));
  return {
    summary: strOf(raw.summary, 600),
    proposal: strOf(raw.proposal, 6000),
    scope: list(raw.scope, 4), steps: list(raw.steps, 8), risks: list(raw.risks, 4), tests: list(raw.tests, 4),
    files: (Array.isArray(raw.files) ? raw.files : []).slice(0, 12).map((f) => ({ path: strOf(f?.path, 200), change: strOf(f?.change, 240) })).filter((f) => f.path),
    estimate: strOf(raw.estimate, 40),
    reply: strOf(raw.reply, 4000),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 4).map((q, i) => ({
      id: /^[\w-]{1,20}$/.test(String(q?.id)) ? String(q.id) : `q${i + 1}`, text: strOf(q?.text, 400),
      options: (Array.isArray(q?.options) ? q.options : []).slice(0, 5).map((o) => strOf(o, 120)).filter(Boolean),
    })).filter((q) => q.text),
    actions: (Array.isArray(raw.actions) ? raw.actions : []).slice(0, 4)
      .map((a) => ({ type: a?.type === 'comment' ? 'comment' : 'reply', label: strOf(a?.label, 60) || 'Enviar', text: strOf(a?.text, 4000), target: strOf(a?.target, 30) }))
      .filter((a) => a.text),
  };
};

// Unifies the pending items of every source into case candidates
// Scope: my unfinished tasks of the active sprint, plus Slack/Gmail requests that arrived since the sprint started
// (no active sprint known → last 14 days). PRs are not cases: they already have their own views.
const jiraCases = (items) => items.filter((j) => !j.viaParent && j.statusCategory !== 'done' && j.sprint?.state === 'active')
  .map((j) => {
    const days = j.due ? Math.floor((Date.parse(`${j.due.slice(0, 10)}T12:00:00`) - Date.now()) / DAY) : null;
    return { id: `jira:${j.key}`, source: 'jira', ref: j.key, title: `${j.key} ${j.summary}`, from: `${j.type || 'Tarea'} · ${j.status}${j.priority ? ` · ${j.priority}` : ''}${j.due ? ` · vence ${j.due.slice(0, 10)}` : ''}`,
      text: j.summary, link: j.url, at: j.updated, sev: days !== null && days <= 2 ? 1 : /highest|blocker|alta|cr[ií]tic/i.test(j.priority || '') ? 2 : 3 };
  });

export const collectCases = ({ slack = [], gmail = [], jira = [], now = Date.now() }) => {
  const sprint = jira.map((j) => j.sprint).find((sp) => sp?.state === 'active');
  const since = Date.parse(sprint?.start || '') || now - 14 * DAY;
  const inScope = (x) => !x.at || Date.parse(x.at) >= since;
  return [
    ...jiraCases(jira),
    ...slack.map((s) => ({ id: `slack:${s.id}`, source: 'slack', ref: s.id, title: `${s.channel} · ${s.author}`, from: s.author, text: s.text, link: s.permalink || '', at: s.ts, sev: s.kind === 'mention' ? 2 : 3 })).filter(inScope),
    ...gmail.map((g) => ({ id: g.id, source: 'gmail', ref: g.threadId, title: g.channel, from: `${g.author} <${g.email}>`, text: g.text, link: g.permalink, at: g.ts, sev: g.starred || g.unread ? 2 : 3 })).filter(inScope),
  ];
};
