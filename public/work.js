// Work views: "Hoy" inbox, Jira "Tareas" and the ticket → thread → PR linking.
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, api, esc, ago, $, $$, store } = C;

const JIRA_BROWSE = `${window.DEVTOWER?.jiraSite || ''}/browse`;
const TICKET_RE = new RegExp(`\\b(${window.DEVTOWER?.ticketPattern || '[A-Z][A-Z0-9]{1,9}-\\d{1,7}'})\\b`);

state.jira = { items: [], fetchedAt: null, running: false, error: null };
state.taskFilter = store.get('taskFilter', 'all');
state.taskScope = store.get('taskScope', 'sprint');
state.taskLane = store.get('taskLane', null);
state.taskSel = null;
state.nextSprint = { loading: false, error: null };

// ------------------------------------------------------------------ data

const loadJira = async () => {
  try { state.jira = await (await api('/api/jira')).json(); } catch (e) { state.jira.error = e.message; }
  C.render();
};

const pollSource = (loader, isRunning) => {
  const iv = setInterval(async () => { await loader(); if (!isRunning()) clearInterval(iv); }, 4000);
};

const refreshJira = async () => {
  const response = await api('/api/jira/refresh', {});
  if (!response.ok) { state.jira.error = (await response.json()).error; C.render(); return; }
  state.jira.running = true;
  state.jira.error = null;
  C.render();
  pollSource(loadJira, () => state.jira.running);
};
C.refreshJira = refreshJira;
C.loadJira = loadJira;

const refreshSource = async (src) => {
  if (src === 'prs') return C.loadPrs(true);
  if (src === 'threads') return C.loadThreads();
  if (src === 'jira') return refreshJira();
  const response = await api('/api/slack/refresh', {});
  if (!response.ok) { state.slack.error = (await response.json()).error; C.render(); return; }
  state.slack.running = true;
  C.render();
  return C.pollSlack();
};

const allPrs = () => {
  const p = state.prs;
  if (!p) return [];
  return [...new Map([...p.mine, ...p.toReview, ...p.reviewed].map((x) => [x.key, x])).values()];
};

const prTicket = (p) => {
  const fromTitle = p.title.match(TICKET_RE)?.[1];
  if (fromTitle) return fromTitle;
  const m = (p.branch || '').match(/^(\d+)_([a-z]+)_/i);
  return m ? `${m[2].toUpperCase()}-${m[1]}` : null;
};

// a thread "belongs" to a ticket when the key is in its title or one of its branches
const threadTicket = (t, key) => {
  const [tracker, num] = key.split('-');
  return t.title.includes(key) || (t.branches || []).some((b) => b.toLowerCase().includes(`${num}_${tracker.toLowerCase()}`));
};

// detect=false keeps only the given Jira items (sprint views): PRs/threads attach but never add tasks
const buildTasks = (items = state.jira.items, detect = true) => {
  const map = new Map();
  const ensure = (key) => { if (!map.has(key)) map.set(key, { key, jira: null, threads: [], prs: [] }); return map.get(key); };
  const find = (key) => (detect ? ensure(key) : map.get(key));
  items.forEach((i) => { ensure(i.key).jira = i; });
  const threads = state.threads.filter((t) => !t.scheduled);
  allPrs().forEach((p) => { const k = prTicket(p); if (k) find(k)?.prs.push(p); });
  threads.forEach((t) => {
    for (const k of t.tickets || []) {
      if (map.has(k) && threadTicket(t, k)) map.get(k).threads.push(t);
      else if (threadTicket(t, k)) find(k)?.threads.push(t);
    }
  });
  return [...map.values()].map((t) => ({ ...t, threads: [...new Set(t.threads)].sort((a, b) => b.mtimeMs - a.mtimeMs) }));
};

// ------------------------------------------------------------------ shared pieces

const statusCls = (j) => (!j ? '' : /aprob/i.test(j.status) ? 'warn' : j.statusCategory === 'indeterminate' ? 'info' : '');
const sectionHead = (title, n, hint = '') => `<div class="sect-head"><h3>${title}</h3><span class="count">${n}</span>${hint ? `<em>${hint}</em>` : ''}</div>`;
const viaClaude = (src) => (src === 'slack' || src === 'jira') && state[src]?.source !== 'api';
const sourceBtn = (src, label, at, running) => `<button class="src ${running ? 'busy' : ''}" data-act="src-refresh" data-src="${src}" title="Actualizar ${label}${viaClaude(src) ? ' (tarda 1–3 min: lo consulta Claude con tu conector)' : ' · se actualiza solo cada 5 min'}">
  <b>${label}</b><span>${running ? 'actualizando' : at ? `hace ${ago(at)}` : 'sin datos'}</span><i>↻</i></button>`;
C.sourceBtn = sourceBtn;
const emptyState = (icon, title, text, action = '') => `<div class="empty-state"><div class="big">${icon}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;

// ------------------------------------------------------------------ Hoy

const rowHtml = ({ sev, icon, title, sub, tags = '', acts, attrs = '' }) => `
  <div class="card item sev${sev}" ${attrs}>
    <i class="ico">${icon}</i>
    <div class="main"><div class="t"><span>${title}</span></div><div class="m">${sub}${tags}</div></div>
    <div class="acts">${acts}</div>
  </div>`;

const btn = (act, label, primary, tip) => `<button class="btn sm ${primary ? 'primary' : ''}" data-act="${act}" title="${esc(tip)}">${label}</button>`;
const prLink = (p) => `<a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.repoName)}#${p.number}</a>`;

const inbox = () => {
  const items = [];
  const prs = state.prs;
  const age = (iso) => `<span>${ago(iso)}</span>`;
  for (const p of prs?.mine || []) {
    const base = { attrs: `data-key="${esc(p.key)}"`, title: esc(p.title), at: p.updatedAt, stale: Date.now() - Date.parse(p.updatedAt) > 14 * 86_400_000 };
    const sub = (why) => `<span class="why">${why}</span>${prLink(p)}${age(p.updatedAt)}`;
    if (p.flags.includes('changes')) items.push({ ...base, sev: 1, icon: '✎', sub: sub('Pidieron cambios'), acts: btn('pr-fix', 'Arreglar comentarios', true, 'Claude lee los comentarios y propone los fixes (te muestra el plan antes de editar)') + btn('pr-ctx', '+ Contexto', false, 'Sumar este PR como contexto de un hilo') });
    else if (p.flags.includes('ci')) items.push({ ...base, sev: 1, icon: '⚠', sub: sub('CI fallando') + (C.checkLine?.(p.checkSummary, p.checks, 2) || ''), acts: btn('pr-ci', 'Revisar CI', true, 'Claude investiga por qué falla el CI y propone el arreglo') + btn('pr-logs', 'Logs', false, 'Investigar logs de producción relacionados') });
    else if (p.flags.includes('conflict')) items.push({ ...base, sev: 1, icon: '⇄', sub: sub('Conflicto con la rama base'), acts: btn('pr-conflict', 'Resolver conflicto', true, 'Claude te ayuda a resolver el conflicto de merge') });
    else if (p.unresolved > 0) items.push({ ...base, sev: 2, icon: '💬', sub: sub(`${p.unresolved} comentarios sin resolver`), acts: btn('pr-fix', 'Resolver comentarios', true, 'Claude lee los comentarios sin resolver y propone los fixes') });
    else if (p.reviewDecision === 'APPROVED' && p.ci === 'SUCCESS' && !p.isDraft) items.push({ ...base, sev: 3, icon: '✓', sub: sub('Aprobado y con CI verde: listo para mergear'), acts: `<a class="btn sm primary" target="_blank" href="${esc(p.url)}" title="Abrir el PR en GitHub para mergearlo">Abrir PR ↗</a>` });
  }
  for (const p of prs?.toReview || []) {
    items.push({ sev: 2, icon: '👀', attrs: `data-key="${esc(p.key)}"`, title: esc(p.title), at: p.updatedAt, sub: `<span class="why">Te pidieron review · @${esc(p.author)}</span>${prLink(p)}${age(p.updatedAt)}`, acts: btn('pr-review', 'Revisar con Claude', true, 'Abre un hilo con el PR y pide un borrador de review en español. No publica nada en GitHub') + btn('pr-ctx', '+ Contexto', false, 'Sumar este PR como contexto de un hilo') });
  }
  for (const p of (prs?.reviewed || []).filter((x) => x.updatedSinceMyReview)) {
    items.push({ sev: 2, icon: '↻', attrs: `data-key="${esc(p.key)}"`, title: esc(p.title), at: p.updatedAt, sub: `<span class="why">Actualizado desde tu review · @${esc(p.author)}</span>${prLink(p)}${age(p.updatedAt)}`, acts: btn('pr-review', 'Volver a revisar', true, 'Claude revisa los cambios nuevos del PR') });
  }
  for (const s of state.slack.items) {
    items.push({ sev: s.kind === 'mention' ? 2 : 3, icon: '#', attrs: `data-id="${esc(s.id)}"`, title: `${esc(s.channel)} · ${esc(s.author)}`, at: s.ts, sub: `<span class="why">${esc(s.reason || 'Pendiente de respuesta')}</span><span class="clip">${esc(s.text)}</span>${s.ts ? age(s.ts) : ''}`, acts: btn('today-slack-reply', 'Responder', true, 'Redactar con Claude y guardar como borrador en Slack') + btn('slack-ctx', 'Usar en hilo', false, 'Trabajar este mensaje en un hilo de Claude Code') });
  }
  const tasks = buildTasks();
  for (const t of tasks.filter((x) => x.jira?.statusCategory === 'indeterminate')) {
    const recent = t.threads.some((th) => Date.now() - th.mtimeMs < 3 * 86_400_000);
    if (t.prs.length === 0 && !recent) {
      items.push({ sev: 3, icon: '◐', attrs: `data-task="${t.key}"`, title: `${esc(t.key)} ${esc(t.jira.summary)}`, at: t.jira.updated, sub: `<span class="why">Tarea en curso sin actividad reciente</span><span class="tag ${statusCls(t.jira)}">${esc(t.jira.status)}</span>`, acts: btn(t.threads.length ? 'task-continue' : 'task-start', t.threads.length ? 'Continuar hilo' : 'Empezar con Claude', true, 'Retomar esta tarea con Claude') });
    }
  }
  items.push(...(C.healthAlerts?.() || []));
  const demoted = items.map((i) => (i.stale && i.sev < 3 ? { ...i, sev: 3, sub: `${i.sub}<span class="tag" title="Sin actividad hace más de 14 días: no se marca como urgente">sin movimiento</span>` } : i));
  return demoted.sort((a, b) => a.sev - b.sev || Date.parse(b.at || 0) - Date.parse(a.at || 0));
};

const running = () => state.threads.filter((t) => t.running);

const renderToday = () => {
  const items = inbox();
  const by = (n) => items.filter((i) => i.sev === n);
  const kpi = (n, label, cls, view) => `<button class="kpi ${cls}" data-go="${view}"><b>${n}</b><span>${label}</span></button>`;
  const hour = new Date().getHours();
  const hello = hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buen día' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
  const date = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const urgent = by(1).length;
  const lead = urgent > 0 ? `Tenés <b>${urgent}</b> ${urgent === 1 ? 'cosa urgente' : 'cosas urgentes'} y ${items.length - urgent} más.` : items.length > 0 ? `Nada urgente. Hay <b>${items.length}</b> ${items.length === 1 ? 'cosa' : 'cosas'} para mirar.` : state.slack.error || state.jira.error ? 'No se pudieron actualizar todas las fuentes. Los datos disponibles pueden estar desactualizados.' : 'Todo al día.';
  const section = (n, title, hint) => (by(n).length ? `${sectionHead(title, by(n).length, hint)}<div class="list-wide">${by(n).map(rowHtml).join('')}</div>` : '');
  const live = running();
  return `
    ${window.DEVTOWER?.configured === false ? '<div class="banner"><b>Primera vez acá</b><p>Vinculá GitHub, Jira y Slack para ver tus pendientes.</p><button class="btn sm primary" data-go="settings">Configurar devtower</button></div>' : ''}
    <div class="hero"><div><h2>${hello}${window.DEVTOWER?.userName ? `, ${esc(window.DEVTOWER.userName)}` : ''}</h2><p>${date} · ${lead}</p></div></div>
    <div class="kpis">
      ${kpi(urgent, 'urgente', urgent ? 'bad' : '', 'prs')}
      ${kpi((state.prs?.toReview.length || 0), 'para revisar', state.prs?.toReview.length ? 'warn' : '', 'prs')}
      ${kpi(state.slack.items.length, 'Slack pendientes', state.slack.items.length ? 'warn' : '', 'slack')}
      ${kpi(buildTasks().filter((t) => t.jira?.statusCategory === 'indeterminate').length, 'tareas en curso', '', 'tasks')}
    </div>
    <div class="sources">${sourceBtn('prs', 'PRs', state.prs?.fetchedAt, false)}${sourceBtn('slack', 'Slack', state.slack.fetchedAt, state.slack.running)}${sourceBtn('jira', 'Jira', state.jira.fetchedAt, state.jira.running)}</div>
    ${live.length ? `${sectionHead('Claude trabajando ahora', live.length)}<div class="list-wide">${live.map((t) => `<div class="card link" data-act="open-thread" data-id="${t.id}"><i class="dot run"></i><span>${esc(t.title)}</span><em>${esc(t.project)}</em></div>`).join('')}</div>` : ''}
    ${section(1, 'Urgente', 'Bloquea tu trabajo o el de otros')}
    ${section(2, 'Para hoy', 'Reviews, menciones y comentarios')}
    ${section(3, 'Cuando puedas', 'Listo para mergear, DMs y tareas sin movimiento')}
    ${items.length === 0 ? emptyState('◎', state.slack.error || state.jira.error ? 'No se pudieron comprobar todos los pendientes' : 'Todo al día', state.slack.error || state.jira.error ? 'Una consulta falló. Se conservan los datos guardados; revisá el mensaje en Slack o Tareas.' : state.slack.fetchedAt && state.prs ? 'No hay nada pendiente en PRs, Slack ni Jira.' : 'Todavía faltan datos: actualizá las fuentes de arriba.') : ''}
    ${state.threads.length ? `${sectionHead('Hilos recientes', Math.min(5, state.threads.filter((t) => !t.scheduled).length), 'Seguí donde lo dejaste')}<div class="list-wide">${state.threads.filter((t) => !t.scheduled).slice(0, 5).map((t) => `<div class="card link" data-act="open-thread" data-id="${t.id}"><i class="dot ${t.running ? 'run' : ''}"></i><span>${esc(t.title)}</span><em>${esc(t.project)} · ${ago(t.updatedAt)}</em></div>`).join('')}</div>` : ''}`;
};

// ------------------------------------------------------------------ Tareas

const taskCard = (t) => {
  const j = t.jira;
  const links = [
    ...t.threads.slice(0, 3).map((th) => `<div class="link" data-act="open-thread" data-id="${th.id}"><i class="dot ${th.running ? 'run' : ''}"></i><span>${esc(th.title)}</span><em>${ago(th.updatedAt)}</em></div>`),
    ...t.prs.map((p) => `<div class="link prl">${C.prChip({ key: p.key, repo: p.repo, number: p.number, created: false })}<span class="tags">${C.prTags(p)}</span></div>`),
  ].join('');
  const has = t.threads.length > 0;
  return `<div class="card task" data-task="${esc(t.key)}">
    <div class="t"><a class="key" target="_blank" href="${JIRA_BROWSE}/${t.key}" title="Abrir en Jira">${esc(t.key)}</a><span>${j ? esc(j.summary) : esc(t.prs[0]?.title || t.threads[0]?.title || '')}</span></div>
    <div class="m">${j ? `<span class="tag ${statusCls(j)}" title="Estado en Jira">${esc(j.status)}</span><span class="tag" title="Prioridad">${esc(j.priority || '')}</span><span class="tag" title="Tipo de issue">${esc(j.type || '')}</span><span>${j.updated ? `actualizada ${ago(j.updated)}` : ''}</span>` : '<span class="tag" title="Esta tarea no está en tu lista de Jira (no asignada o ya cerrada): se detectó por tus hilos y PRs">detectada en hilos/PRs</span>'}</div>
    ${links ? `<div class="links">${links}</div>` : ''}
    <div class="acts">
      ${has ? btn('task-continue', 'Continuar hilo', true, 'Abrir el hilo más reciente de esta tarea') : btn('task-start', 'Empezar con Claude', true, 'Nuevo hilo con el ticket como contexto: Claude lo lee en Jira y propone un plan (modo Plan, no edita)')}
      ${has ? btn('task-start', 'Nuevo hilo', false, 'Nuevo hilo con el ticket como contexto (modo Plan)') : ''}
      ${j ? btn('task-comment', 'Comentar', false, 'Publicar un comentario en el ticket de Jira (con confirmación)') : ''}
      ${j ? btn('task-transition', 'Mover estado', false, 'Cambiar el estado del ticket en Jira (con confirmación)') : ''}
      ${btn('task-logs', 'Logs', false, 'Nuevo hilo para investigar logs de producción con las herramientas de logs que tenga Claude, solo lectura')}
      ${j ? btn('task-deploy', '🚀 ¿En prod?', false, 'Busca los PRs de la tarea y sus subtareas y corre tu comando de verificación de deploy en cada uno') : ''}
    </div>
    ${C.deployPanel?.(t.key) || ''}
  </div>`;
};

const loadNextSprint = async () => {
  Object.assign(state.nextSprint, { loading: true, error: null });
  C.render();
  try { state.jira.next = (await postJson('/api/jira/next', {})).next; } catch (e) { state.nextSprint.error = e.message; }
  state.nextSprint.loading = false;
  C.render();
};

const dayLabel = (iso) => new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
const sprintHead = (sprint, list, { refresh = false } = {}) => {
  if (!sprint) return '';
  const done = list.filter((i) => i.statusCategory === 'done').length;
  const days = Math.ceil((Date.parse(sprint.end) - Date.now()) / 86_400_000);
  const when = sprint.state === 'active' ? (days > 0 ? `quedan ${days} ${days === 1 ? 'día' : 'días'}` : 'termina hoy') : `empieza el ${dayLabel(sprint.start)}`;
  return `<div class="sprint-head"><div><b>${esc(sprint.name)}</b><span>${dayLabel(sprint.start)} → ${dayLabel(sprint.end)} · ${when}</span></div>
    <div class="sprint-progress" title="${done} de ${list.length} hechas"><i style="width:${list.length ? Math.round((done / list.length) * 100) : 0}%"></i></div>
    <em>${done}/${list.length} hechas</em>${refresh ? '<button class="btn sm ghost" data-act="next-sprint-refresh" title="Volver a consultar el próximo sprint en Jira">↻</button>' : ''}</div>`;
};

// ------------------------------------------------------------------ board (Jira swimlanes + columns)

const boardCard = (t, selected) => {
  const j = t.jira;
  const marks = [t.threads.length ? `<span title="${t.threads.length} hilo(s) de Claude">✦ ${t.threads.length}</span>` : '',
    t.prs.length ? `<span title="${t.prs.length} PR(s)">⑂ ${t.prs.length}</span>` : ''].join('');
  return `<button class="kcard ${selected ? 'on' : ''}" data-act="task-select" data-key="${esc(t.key)}" title="${esc(j.summary)}">
    <span class="kkey">${esc(t.key)}</span><span class="ksum">${esc(j.summary)}</span>
    <span class="kmeta"><span class="tag">${esc(j.priority || '—')}</span>${j.type === 'Subtarea' ? '<span class="tag">Subtarea</span>' : ''}${marks}${C.deployBadge?.(t.key) || ''}</span></button>`;
};

const renderBoard = (tasks, board) => {
  const lanes = board.swimlanes.map((l, i) => ({ ...l, i, tasks: tasks.filter((t) => t.jira.lane === i) })).filter((l) => l.tasks.length);
  if (!lanes.length) return '';
  const lane = lanes.find((l) => l.name === state.taskLane) || lanes[0];
  const inColumn = (t) => board.columns.findIndex((c) => c.statuses.includes(String(t.jira.statusId)));
  const hidden = lane.tasks.filter((t) => inColumn(t) === -1);
  const sel = state.taskSel && lane.tasks.find((t) => t.key === state.taskSel);
  return `<div class="viewbar lanes"><div class="seg">${lanes.map((l) => `<button class="${l === lane ? 'on' : ''}" data-act="task-lane" data-lane="${esc(l.name)}" title="${esc(l.query || 'Resto de las tareas')}">${esc(l.name)}<b>${l.tasks.length}</b></button>`).join('')}</div></div>
    ${sel ? `<div class="kdetail">${taskCard(sel)}</div>` : ''}
    <div class="kanban" style="--cols:${board.columns.length}">${board.columns.map((c, ci) => {
      const list = lane.tasks.filter((t) => inColumn(t) === ci);
      const deployCol = /deploy/i.test(c.name) && list.length;
      return `<section class="kcol"><header><span>${esc(c.name)}</span>${deployCol ? `<button class="btn sm ghost" data-act="deploy-column" data-keys="${esc(list.map((t) => t.key).join(','))}" title="Verificar con tu script si estas tareas ya están en prod">🚀</button>` : ''}<b>${list.length}</b></header>${list.map((t) => boardCard(t, t.key === state.taskSel)).join('') || '<div class="kempty">—</div>'}</section>`;
    }).join('')}</div>
    ${hidden.length ? `<p class="note">${hidden.length} ${hidden.length === 1 ? 'tarea' : 'tareas'} en un estado que el tablero no muestra (${esc([...new Set(hidden.map((t) => t.jira.status))].join(', '))}): ${hidden.map((t) => `<a class="lnk" target="_blank" href="${JIRA_BROWSE}/${t.key}">${esc(t.key)}</a>`).join(' · ')}</p>` : ''}`;
};

const renderTasks = () => {
  const jr = state.jira;
  const scopes = [['sprint', 'Sprint activo'], ['next', 'Próximo sprint'], ['all', 'Todas']];
  const filters = [['withpr', '⑂ Con PR'], ['nothread', 'Sin hilo']];
  const scope = state.taskScope;
  const sprintItems = jr.items.filter((i) => i.sprint?.state === 'active');
  const nextItems = jr.next?.items || [];
  const source = scope === 'sprint' ? sprintItems : scope === 'next' ? nextItems : jr.items;
  let tasks = buildTasks(source, scope === 'all').filter((t) => C.match(t.key, t.jira?.summary || '', t.jira?.status || '', t.prs.map((p) => p.title).join(' ')));
  if (state.taskFilter === 'withpr') tasks = tasks.filter((t) => t.prs.length);
  if (state.taskFilter === 'nothread') tasks = tasks.filter((t) => !t.threads.length);
  const sortFn = (a, b) => Date.parse(b.jira?.updated || 0) - Date.parse(a.jira?.updated || 0);
  const active = tasks.filter((t) => t.jira?.statusCategory === 'indeterminate').sort(sortFn);
  const todo = tasks.filter((t) => t.jira && t.jira.statusCategory === 'new').sort(sortFn);
  const done = tasks.filter((t) => t.jira?.statusCategory === 'done').sort(sortFn);
  const detected = tasks.filter((t) => !t.jira);
  const board = scope !== 'all' && jr.board && tasks.some((t) => Number.isInteger(t.jira?.lane)) ? jr.board : null;
  const doneList = done.length ? `${sectionHead('Hechas', done.length)}<div class="done-list">${done.map((t) => `<a target="_blank" href="${JIRA_BROWSE}/${t.key}"><b>${esc(t.key)}</b><span>${esc(t.jira.summary)}</span><em>${esc(t.jira.status)}</em></a>`).join('')}</div>` : '';
  const ns = state.nextSprint;
  const scopeHead = scope === 'sprint'
    ? (sprintItems.length ? sprintHead(sprintItems[0].sprint, sprintItems) : jr.fetchedAt ? emptyState('🏁', 'Sin sprint activo', 'No tenés tareas en un sprint abierto. Mirá «Todas».') : '')
    : scope === 'next'
      ? (ns.loading ? '<div class="banner">Consultando el próximo sprint en Jira…</div>'
        : ns.error ? `<div class="banner err" role="alert"><b>No se pudo cargar el próximo sprint</b><p>${esc(ns.error)}</p></div>`
          : !jr.next ? emptyState('⏭', 'Próximo sprint', 'Se consulta solo cuando lo pedís.', '<button class="btn primary" data-act="next-sprint-refresh">Cargar próximo sprint</button>')
            : jr.next.sprint ? sprintHead(jr.next.sprint, nextItems, { refresh: true }) + `<div class="note">Consultado ${ago(jr.next.fetchedAt)}</div>`
              : emptyState('⏭', 'Sin próximo sprint', 'Tu tablero todavía no tiene un sprint futuro planificado.', '<button class="btn" data-act="next-sprint-refresh">Reintentar</button>'))
      : '';
  const group = (title, list, hint) => (list.length ? `${sectionHead(title, list.length, hint)}<div class="list-wide">${list.map(taskCard).join('')}</div>` : '');
  return `
    <div class="viewbar">
      <div class="seg">${scopes.map(([k, l]) => `<button class="${scope === k ? 'on' : ''}" data-act="task-scope" data-s="${k}">${l}</button>`).join('')}</div>
      ${filters.map(([k, l]) => `<button class="chip ${state.taskFilter === k ? 'on' : ''}" data-act="task-filter" data-f="${k}" aria-pressed="${state.taskFilter === k}">${l}</button>`).join('')}
      <span class="spacer"></span>
      ${sourceBtn('jira', 'Jira', jr.fetchedAt, jr.running)}
    </div>
    ${jr.error ? `<div class="banner err" role="alert"><b>${jr.errorCode === 'claude_usage_limit' ? 'Límite de Claude alcanzado' : 'No se pudo actualizar Jira'}</b><p>${esc(jr.error)}</p><span>${jr.fetchedAt ? 'Se conservan las tareas de la última consulta exitosa.' : 'Todavía no hay tareas guardadas para mostrar.'}</span></div>` : ''}
    ${jr.running && jr.source !== 'api' ? '<div class="banner">Claude está leyendo tus tareas de Jira… (puede tardar 1–2 min)</div>' : ''}
    ${!jr.fetchedAt && !jr.running ? emptyState('☰', 'Todavía no cargaste tus tareas', 'Claude las lee de Jira con tu conector Atlassian (solo lectura) y las vincula con tus hilos y PRs.', '<button class="btn primary" data-act="src-refresh" data-src="jira">Cargar mis tareas de Jira</button>') : ''}
    ${scopeHead}
    ${board ? renderBoard(tasks.filter((t) => t.jira), board) : `
    ${group('En curso', active, 'Tareas asignadas a vos en progreso o en revisión')}
    ${group('Por hacer', todo)}
    ${doneList}
    ${group('Detectadas en hilos y PRs', detected, 'No están en tu lista de Jira')}`}
    ${jr.fetchedAt && !jr.error && tasks.length === 0 && (scope === 'all' || source.length) ? emptyState('🔎', 'Sin resultados', 'Probá otro filtro o limpiá la búsqueda.') : ''}`;
};

// ------------------------------------------------------------------ modals (Jira comment / transition)

const modal = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'modal', hidden: true }));
const closeModal = () => { modal.hidden = true; modal.innerHTML = ''; state.cm = null; state.tm = null; };
const openModal = (html) => { modal.innerHTML = `<div class="card2">${html}</div>`; modal.hidden = false; };
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeModal(); } }, true);

const renderComment = () => {
  const m = state.cm;
  if (!m) return;
  const dis = m.busy ? 'disabled' : '';
  openModal(`<h2>Comentar en ${esc(m.key)}</h2>
    ${m.stage === 'confirm'
    ? `<p class="note">Se va a publicar este comentario en <b>${esc(m.key)}</b> con tu usuario de Jira. Es visible para todo el equipo.</p><blockquote>${esc(m.text)}</blockquote>`
    : `<textarea id="cm-text" rows="6" placeholder="Escribí el comentario…" ${dis}>${esc(m.text)}</textarea>`}
    ${m.error ? `<div class="banner err">${esc(m.error)}</div>` : ''}
    <div class="acts end">
      <button class="btn ghost" data-act="modal-cancel" ${dis}>Cancelar</button>
      ${m.stage === 'confirm'
    ? `<button class="btn" data-act="cm-back" ${dis}>Volver</button><button class="btn primary" data-act="cm-send" ${dis}>${m.busy ? 'Publicando…' : 'Confirmar y publicar'}</button>`
    : `<button class="btn primary" data-act="cm-review">Revisar y publicar</button>`}
    </div>`);
  if (m.stage !== 'confirm') $('#cm-text')?.focus();
};

const renderTransition = () => {
  const m = state.tm;
  if (!m) return;
  const body = m.loading ? '<p class="note">Consultando las transiciones disponibles… (~20 s)</p>'
    : m.chosen ? `<p class="note">Vas a mover <b>${esc(m.key)}</b> a <b>«${esc(m.chosen.to || m.chosen.name)}»</b> (transición «${esc(m.chosen.name)}»). Lo ve todo el equipo.</p>`
      : m.list.length ? `<div class="choices">${m.list.map((t, i) => `<button class="btn" data-act="tm-pick" data-i="${i}" title="Transición «${esc(t.name)}»">${esc(t.to || t.name)}<small>${esc(t.name)}</small></button>`).join('')}</div>` : '<p class="note">No hay transiciones disponibles.</p>';
  openModal(`<h2>Mover estado de ${esc(m.key)}</h2>${body}${m.error ? `<div class="banner err">${esc(m.error)}</div>` : ''}
    <div class="acts end"><button class="btn ghost" data-act="modal-cancel" ${m.busy ? 'disabled' : ''}>Cancelar</button>
      ${m.chosen ? `<button class="btn" data-act="tm-back" ${m.busy ? 'disabled' : ''}>Volver</button><button class="btn primary" data-act="tm-go" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Aplicando…' : 'Confirmar cambio'}</button>` : ''}</div>`);
};

modal.addEventListener('input', (e) => { if (e.target.id === 'cm-text' && state.cm) state.cm.text = e.target.value; });

const postJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

// ------------------------------------------------------------------ actions

const taskByKey = (key) => buildTasks().find((t) => t.key === key);
const taskCtx = (t) => ({
  label: t.key,
  text: `Tarea Jira ${t.key}${t.jira ? ` "${t.jira.summary}" — estado: ${t.jira.status}, prioridad: ${t.jira.priority}, tipo: ${t.jira.type}` : ''} (${JIRA_BROWSE}/${t.key}).${t.prs.length ? ` PRs relacionados: ${t.prs.map((p) => p.url).join(', ')}.` : ''}`,
});
const taskCwd = (t) => t.prs.find((p) => p.localDir)?.localDir || t.threads[0]?.cwd || C.knownCwds()[0];
const setMode = (mode) => { const tab = C.activeTab(); if (tab && !tab.sessionId) { tab.mode = mode; C.persistTabs(); C.renderDock(false); } };

const LOGS_PROMPT = (what) => `Investigá en los logs de producción posibles errores relacionados con ${what}. ${window.DEVTOWER?.logsHint || 'Usá las herramientas de logs que tengas disponibles.'} Revisá los últimos 7 días: errores 5xx, excepciones y endpoints implicados. Resumí los hallazgos (endpoint, frecuencia, causa probable). Es solo lectura: no modifiques nada.`;

const findPr = (card) => allPrs().find((p) => p.key === card?.dataset.key);

document.addEventListener('click', async (e) => {
  if (e.target.closest('a')) return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const card = el.closest('.card');
  const task = () => taskByKey(card?.dataset.task);
  switch (el.dataset.act) {
    case 'src-refresh': refreshSource(el.dataset.src); break;
    case 'task-filter': state.taskFilter = state.taskFilter === el.dataset.f ? 'all' : el.dataset.f; store.set('taskFilter', state.taskFilter); C.render(); break;
    case 'task-scope':
      state.taskScope = el.dataset.s; store.set('taskScope', state.taskScope); C.render();
      if (state.taskScope === 'next' && !state.jira.next && !state.nextSprint.loading) loadNextSprint();
      break;
    case 'next-sprint-refresh': loadNextSprint(); break;
    case 'task-lane': state.taskLane = el.dataset.lane; state.taskSel = null; store.set('taskLane', state.taskLane); C.render(); break;
    case 'task-select': state.taskSel = state.taskSel === el.dataset.key ? null : el.dataset.key; C.render(); break;
    case 'task-continue': { const t = task(); if (t?.threads[0]) { await C.openThread(t.threads[0].id); $('#input').focus(); } break; }
    case 'task-start': {
      const t = task();
      if (!t) break;
      C.addContext(taskCtx(t), { cwd: taskCwd(t), draft: 'Leé el ticket con el MCP de Jira y proponé un plan de implementación. No edites nada hasta que yo lo apruebe.' });
      setMode('plan');
      break;
    }
    case 'task-logs': { const t = task(); if (t) { C.addContext(taskCtx(t), { cwd: taskCwd(t), draft: LOGS_PROMPT(`${t.key}${t.jira ? ` («${t.jira.summary}»)` : ''}`) }); setMode('acceptEdits'); } break; }
    case 'task-comment': { const t = task(); if (t) { state.cm = { key: t.key, text: '', stage: 'edit', busy: false, error: null }; renderComment(); } break; }
    case 'task-transition': {
      const t = task();
      if (!t) break;
      state.tm = { key: t.key, loading: true, list: [], chosen: null, busy: false, error: null };
      renderTransition();
      try { state.tm.list = (await postJson('/api/jira/transitions', { key: t.key })).transitions; } catch (err) { state.tm.error = err.message; }
      if (state.tm) { state.tm.loading = false; renderTransition(); }
      break;
    }
    case 'modal-cancel': closeModal(); break;
    case 'cm-review': if (state.cm.text.trim()) { state.cm.stage = 'confirm'; renderComment(); } break;
    case 'cm-back': state.cm.stage = 'edit'; state.cm.error = null; renderComment(); break;
    case 'cm-send': {
      const m = state.cm;
      m.busy = true; m.error = null; renderComment();
      try { await postJson('/api/jira/comment', { key: m.key, text: m.text }); closeModal(); C.toast(`Comentario publicado en ${m.key}`); } catch (err) { m.busy = false; m.error = err.message; renderComment(); }
      break;
    }
    case 'tm-pick': state.tm.chosen = state.tm.list[Number(el.dataset.i)]; renderTransition(); break;
    case 'tm-back': state.tm.chosen = null; state.tm.error = null; renderTransition(); break;
    case 'tm-go': {
      const m = state.tm;
      m.busy = true; m.error = null; renderTransition();
      try {
        await postJson('/api/jira/transition', { key: m.key, id: m.chosen.id, name: m.chosen.name });
        const item = state.jira.items.find((i) => i.key === m.key);
        if (item) item.status = m.chosen.to || m.chosen.name;
        closeModal();
        C.toast(`${m.key} → ${m.chosen.to || m.chosen.name}`);
        C.render();
      } catch (err) { m.busy = false; m.error = err.message; renderTransition(); }
      break;
    }
    case 'pr-conflict': { const p = findPr(card); if (p) C.addContext(C.prCtx(p), { cwd: p.localDir, draft: 'Este PR tiene conflictos con la rama base. Proponé cómo resolverlos y mostrame el plan antes de tocar nada.' }); break; }
    case 'pr-logs': { const p = findPr(card); if (p) C.addContext(C.prCtx(p), { cwd: p.localDir, draft: LOGS_PROMPT(`el PR ${p.repo}#${p.number} («${p.title}»)`) }); break; }
    case 'today-slack-reply': {
      const id = card?.dataset.id;
      if (!id) break;
      state.replies[id] = { ...(state.replies[id] || { text: '' }), open: true };
      C.setView('slack');
      setTimeout(() => $$('#content .card').find((c) => c.dataset.id === id)?.querySelector('.reply textarea')?.focus(), 30);
      break;
    }
    default:
  }
});

// ------------------------------------------------------------------ usage widget

state.usage = null;

const renderUsage = () => {
  const u = state.usage;
  const blockEl = document.getElementById('uw-block-cost');
  const fillEl = document.getElementById('uw-block-fill');
  const weekEl = document.getElementById('uw-week-cost');
  if (!blockEl) return;
  if (u?.block) {
    const cost = u.block.cost;
    blockEl.textContent = `$${cost.toFixed(2)}`;
    blockEl.classList.toggle('hot', cost > 25);
    const start = new Date(u.block.startTime).getTime();
    const end = new Date(u.block.endTime).getTime();
    const pct = Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100));
    if (fillEl) {
      fillEl.style.width = `${pct}%`;
      fillEl.className = `uw-fill${pct > 80 ? ' bad' : pct > 50 ? ' warn' : ''}`;
    }
  } else {
    blockEl.textContent = '—';
    if (fillEl) fillEl.style.width = '0%';
  }
  if (weekEl) weekEl.textContent = u?.week ? `$${u.week.cost.toFixed(2)}` : '—';
};

const loadUsageWidget = async () => {
  try {
    state.usage = await (await fetch('/api/usage')).json();
    renderUsage();
  } catch { /* ignore */ }
};

loadUsageWidget();
setInterval(loadUsageWidget, 90_000);

// ------------------------------------------------------------------ wiring

C.renderers.today = renderToday;
C.renderers.tasks = renderTasks;
C.afterRender = () => {
  const urgent = inbox().filter((i) => i.sev <= 2).length;
  const t = $('#b-today');
  if (t) t.textContent = urgent || '';
};
loadJira().then(() => { if (state.jira.running) pollSource(loadJira, () => state.jira.running); });
C.render();
