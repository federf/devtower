import { groupThreadProjects, startWorkspaces, threadProject } from './thread-projects.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = (url, body) =>
  fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit': '1' }, body: JSON.stringify(body) });
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const state = {
  view: (() => { const v = store.get('view', 'today'); return v === 'board' ? 'today' : v; })(),
  q: '',
  threads: [],
  archivedThreads: [],
  repos: [],
  threadFilter: 'active',
  threadRevision: 0,
  threadMutations: new Set(),
  prs: null,
  slack: { items: [], fetchedAt: null, running: false, error: null },
  prTab: store.get('prTab', 'mine'),
  projectFilter: store.get('threadProject:active', null),
  withPr: false,
  showScheduled: store.get('showScheduled', false),
  kbIdx: -1,
  replies: {},
  days: store.get('days', 14),
  sdays: store.get('sdays', 365),
  hits: null,
  hitsQ: '',
  collapsed: store.get('collapsed', {}),
  tabs: store.get('tabs', []),
  active: store.get('active', null),
  errors: {},
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
};
const match = (...fields) => state.q === '' || fields.join(' ').toLowerCase().includes(state.q.toLowerCase());

// copy buttons on code blocks: copies the text, never the markup
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  let text = btn.parentElement.querySelector('pre')?.textContent || '';
  if (btn.dataset.strip && text.startsWith(btn.dataset.strip)) text = text.slice(btn.dataset.strip.length);
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copiado ✓'; } catch { btn.textContent = 'No se pudo'; }
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('done'); }, 1500);
}, true);

const md = (src) => {
  const blocks = [];
  let t = esc(src).replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, c) => `\u0000${blocks.push(`<div class="codeblock"><button class="copy" data-copy title="Copiar al portapapeles">Copiar</button><pre><code>${c}</code></pre></div>`) - 1}\u0000`);
  t = t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="lnk" target="_blank" href="$2">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<)]+)/g, '$1<a class="lnk" target="_blank" href="$2">$2</a>');
  const out = [];
  let list = [];
  const endList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`); list = []; };
  for (const line of t.split('\n')) {
    const li = line.match(/^\s*[-*]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (li) list.push(li[1]);
    else { endList(); if (line.trim() !== '') out.push(line.startsWith('\u0000') ? line : `<p>${line.replace(/^#+\s*/, '<b>') + (/^#+\s/.test(line) ? '</b>' : '')}</p>`); }
  }
  endList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
};

// ------------------------------------------------------------- data

const findThread = (id) => state.threads.find((t) => t.id === id) || state.archivedThreads.find((t) => t.id === id) || state.hits?.get(id)?.thread;
const loadThreads = async () => {
  if (state.threadMutations.size) return;
  const revision = state.threadRevision;
  try {
    const res = await api(`/api/threads?days=${state.days}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (revision !== state.threadRevision || state.threadMutations.size) return;
    const { threads, archivedThreads = [] } = data;
    const changed = JSON.stringify([threads, archivedThreads]) !== JSON.stringify([state.threads, state.archivedThreads]);
    const hadError = Boolean(state.errors.threads);
    state.threads = threads;
    state.archivedThreads = archivedThreads;
    delete state.errors.threads;
    if (changed || hadError) { render(); renderDock(false); }
  } catch (e) { state.errors.threads = e.message; render(); }
};
const loadPrs = async (force) => {
  try {
    const d = await (await api(`/api/prs${force ? '?refresh=1' : ''}`)).json();
    if (d.error) throw new Error(d.error);
    state.prs = d; delete state.errors.prs;
  } catch (e) { state.errors.prs = e.message; }
  render();
};
const loadSlack = async () => {
  try { state.slack = await (await api('/api/slack')).json(); } catch (e) { state.errors.slack = e.message; }
  render();
};

// ------------------------------------------------------------- views

const prTags = (p) => {
  const t = [];
  if (p.isDraft) t.push('<span class="tag" title="PR en borrador: todavía no se pidió review">draft</span>');
  if (p.reviewDecision === 'APPROVED') t.push('<span class="tag ok" title="El PR tiene la aprobación de review requerida">aprobado</span>');
  if (p.reviewDecision === 'CHANGES_REQUESTED') t.push('<span class="tag bad" title="Un reviewer pidió cambios: hay que resolverlos antes de mergear">cambios pedidos</span>');
  if (p.reviewDecision === 'REVIEW_REQUIRED') t.push('<span class="tag warn" title="Todavía falta una review aprobatoria">sin review</span>');
  if (p.ci === 'SUCCESS') t.push('<span class="tag ok" title="Todos los checks de CI pasaron">CI ✓</span>');
  if (p.ci === 'FAILURE' || p.ci === 'ERROR') t.push('<span class="tag bad" title="Al menos un check de CI falló">CI ✗</span>');
  if (p.ci === 'PENDING') t.push('<span class="tag info" title="Los checks de CI siguen corriendo">CI …</span>');
  if (p.mergeable === 'CONFLICTING') t.push('<span class="tag bad" title="Hay conflictos de merge con la rama base">conflicto</span>');
  if (p.unresolved > 0) t.push(`<span class="tag warn" title="Hilos de comentarios de review que todavía no se marcaron como resueltos">${p.unresolved} sin resolver</span>`);
  if (p.updatedSinceMyReview) t.push('<span class="tag info" title="Hubo cambios en el PR después de tu última review: conviene volver a mirarlo">actualizado desde tu review</span>');
  return t.join('');
};

const prCard = (p, kind) => `
  <div class="card" data-key="${esc(p.key)}">
    <div class="t"><span>${esc(p.title)}</span></div>
    <div class="m"><a class="lnk" target="_blank" href="${esc(p.url)}">${esc(p.repo)}#${p.number}</a>
      ${kind !== 'mine' ? `<span>@${esc(p.author)}</span>` : ''}<span>${ago(p.updatedAt)}</span><span>+${p.additions} −${p.deletions} · ${p.files}f</span></div>
    <div class="m">${prTags(p)}</div>
    ${window.cockpit?.checkLine?.(p.checkSummary, p.checks) || ''}
    <div class="acts">
      ${kind === 'toReview' || kind === 'reviewed' ? '<button class="btn sm primary" data-act="pr-review" title="Abre un hilo con este PR como contexto y pide un borrador de review en español. No publica nada en GitHub">Revisar con Claude</button>' : ''}
      ${kind === 'mine' && (p.unresolved > 0 || p.flags.includes('changes')) ? '<button class="btn sm primary" data-act="pr-fix" title="Abre un hilo para que Claude lea los comentarios sin resolver y proponga los fixes (te muestra el plan antes de editar)">Arreglar comentarios</button>' : ''}
      ${kind === 'mine' && p.flags.includes('conflict') ? '<button class="btn sm primary" data-act="pr-conflict" title="Claude te ayuda a resolver el conflicto con la rama base">Resolver conflicto</button>' : ''}
      ${kind === 'mine' && p.flags.includes('ci') ? '<button class="btn sm primary" data-act="pr-ci" title="Abre un hilo para que Claude investigue por qué falla el CI y proponga el arreglo">Revisar CI</button>' : ''}
      <button class="btn sm" data-act="pr-ctx" title="Agrega este PR como chip de contexto al hilo activo (o a uno nuevo) sin pedir nada todavía">+ Contexto</button>
    </div>
  </div>`;

const livePr = (key) => ['mine', 'toReview', 'reviewed'].flatMap((k) => state.prs?.[k] || []).find((p) => p.key === key);
const prChip = (p) => {
  const live = livePr(p.key);
  const cls = !live ? '' : live.flags.includes('changes') || live.flags.includes('ci') ? 'bad' : live.reviewDecision === 'APPROVED' ? 'ok' : 'info';
  let st = '';
  if (live) st = live.isDraft ? ' · draft' : live.reviewDecision === 'APPROVED' ? ' · aprobado' : live.flags.includes('changes') ? ' · cambios' : live.flags.includes('ci') ? ' · CI ✗' : ' · abierto';
  return `<a class="tag ${cls}" target="_blank" href="https://github.com/${esc(p.repo)}/pull/${p.number}" title="${p.created ? 'creado en este hilo' : 'mencionado en este hilo'}">${p.created ? '✚ ' : ''}${esc(p.repo.split('/')[1])}#${p.number}${st}</a>`;
};
const JIRA_BROWSE = `${window.DEVTOWER?.jiraSite || ''}/browse`;
const ticketChip = (k) => (window.DEVTOWER?.jiraSite ? `<a class="tag info" title="Abrir la tarea en Jira" target="_blank" href="${JIRA_BROWSE}/${k}">${k}</a>` : `<span class="tag info">${k}</span>`);
const searchTerms = () => (state.hits && state.hitsQ === state.q ? state.q.toLowerCase().split(/\s+/).filter(Boolean) : []);
const hl = (text) => {
  let out = esc(text);
  searchTerms().forEach((t) => {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  });
  return out;
};

const threadActionButtons = (thread) => {
  const disabled = thread.running || state.threadMutations.has(thread.id) ? 'disabled' : '';
  const attrs = `data-id="${esc(thread.id)}" ${disabled}`;
  return `<button class="btn sm ghost" data-act="work-from-thread" data-id="${esc(thread.id)}" title="Crear o vincular un trabajo local, sin consumir IA">◇ Trabajo</button><button class="btn sm ghost" data-act="thread-${thread.archived ? 'restore' : 'archive'}" ${attrs}
    title="${thread.archived ? 'Devolver este hilo a Activos' : 'Ocultar de Hoy y Tareas sin borrar el historial'}">${thread.archived ? '↩ Restaurar' : '▣ Archivar'}</button>
    <button class="btn sm ghost danger" data-act="thread-delete" ${attrs}
    title="Borrar permanentemente el historial original de Claude; requiere confirmación">⌫ Borrar</button>`;
};

const threadCard = (t) => {
  const hit = state.hits && state.hitsQ === state.q ? state.hits.get(t.id) : null;
  const chips = [
    ...(t.tickets || []).map(ticketChip),
    ...(t.prs || []).slice(0, 3).map(prChip),
    t.commits ? `<span class="tag" title="Commits que Claude hizo en este hilo">${t.commits} commits</span>` : '',
    t.filesCount ? `<span class="tag" title="Archivos distintos que Claude editó o creó en este hilo">${t.filesCount} archivos</span>` : '',
  ].join('');
  const snip = hit?.snippet ? hl(hit.snippet) : esc(t.lastText);
  return `
  <div class="card ${state.active === t.id ? 'sel' : ''}" data-act="open-thread" data-id="${t.id}">
    <div class="t"><i class="dot ${t.running ? 'run' : ''}"></i><span>${hl(t.title)}</span></div>
    <div class="m"><span>${esc(t.project)}</span>${t.branch && t.branch !== 'HEAD' ? `<span class="tag">${esc(t.branch.slice(0, 32))}</span>` : ''}<span>${ago(t.updatedAt)}</span><span>${t.prompts} msgs</span></div>
    ${chips ? `<div class="m">${chips}</div>` : ''}
    ${snip ? `<div class="snip">${snip}</div>` : ''}
    <div class="acts thread-actions">${threadActionButtons(t)}${t.running ? '<span class="note">Hilo activo</span>' : ''}</div>
  </div>`;
};

const replyBox = (s) => {
  const r = state.replies[s.id];
  if (!r?.open) return '';
  const dis = r.busy ? 'disabled' : '';
  const canSend = state.slack.source === 'api';
  return `<div class="reply">
    <textarea rows="4" ${dis} placeholder="Escribí tu respuesta. O dejá una instrucción para Claude (ej: «decile que lo reviso hoy») y tocá Redactar">${esc(r.text)}</textarea>
    <div class="acts">
      <button class="btn sm" data-act="slack-suggest" ${dis} title="Claude lee el hilo en Slack y redacta una respuesta. Si escribiste algo, lo toma como instrucción">✨ Redactar con Claude</button>
      ${canSend
        ? `<button class="btn sm primary" data-act="slack-send" data-primary ${dis} title="Envía la respuesta como vos${s.kind === 'dm' && !s.threaded ? ' en el DM' : ' en el hilo'}. Sin IA\n⌘↵">Enviar</button>`
        : `<button class="btn sm primary" data-act="slack-draft" data-primary ${dis} title="Crea la respuesta como borrador en el hilo de Slack. No se envía: la revisás y la mandás vos\n⌘↵">Guardar borrador en Slack</button>`}
      <button class="btn sm ghost" data-act="slack-reply" title="Cerrar el cuadro de respuesta">Cancelar</button>
    </div>
    ${r.status ? `<div class="reply-status ${r.error ? 'err' : ''}">${esc(r.status)} ${r.link ? `<a class="lnk" target="_blank" href="${esc(r.link)}">Abrir en Slack ↗</a>` : ''}</div>` : ''}
    <div class="note">${canSend ? 'Se envía solo al tocar Enviar. Claude redacta únicamente si se lo pedís.' : 'No se envía automáticamente: queda como borrador en tu Slack.'}</div>
  </div>`;
};

const slackCard = (s) => `
  <div class="card" data-id="${esc(s.id)}">
    <div class="t"><span>${esc(s.channel)} · ${esc(s.author)}</span></div>
    <div class="snip" style="-webkit-line-clamp:4">${esc(s.text)}</div>
    <div class="m"><span class="tag ${s.kind === 'mention' ? 'warn' : 'info'}" title="Tipo de pendiente: mención, mensaje directo o hilo con respuesta nueva">${esc(s.kind)}</span><span>${esc(s.reason || '')}</span><span>${s.ts ? ago(s.ts) : ''}</span>
      ${s.permalink ? `<a class="lnk" target="_blank" href="${esc(s.permalink)}">abrir ↗</a>` : ''}</div>
    <div class="acts"><button class="btn sm primary" data-act="slack-reply" title="Responder desde acá. Claude redacta solo si se lo pedís">Responder</button><button class="btn sm" data-act="slack-ctx" title="Agrega este mensaje como contexto de un hilo de Claude Code para trabajarlo">Usar en hilo</button><button class="btn sm ghost" data-act="slack-dismiss" title="Oculta este mensaje de la lista. No modifica nada en Slack">Descartar</button></div>
    ${replyBox(s)}
  </div>`;

const panel = (id, title, count, body, extra = '') => `
  <div class="panel ${state.collapsed[id] ? 'collapsed' : ''}" data-panel="${id}">
    <h2 data-act="collapse" title="Clic para plegar o desplegar este panel">${title}<span class="count">${count}</span></h2>
    <div class="body">${extra}${body}</div>
  </div>`;
const emptyMsg = (m) => `<div class="empty">${m}</div>`;

const views = {
  threads(limit) {
    const searching = state.q !== '';
    const useHits = searching && state.hits && state.hitsQ === state.q;
    const base = useHits ? [...state.hits.values()].sort((x, y) => y.score - x.score).map((h) => h.thread) : state.threadFilter === 'archived' ? state.archivedThreads : state.threads;
    const list = base.filter(
      (t) => Boolean(t.archived) === (state.threadFilter === 'archived') && (!searching || useHits || match(t.title, t.project, t.branch, t.lastText)) && (!state.projectFilter || state.projectFilter === '*' || threadProject(t).key === state.projectFilter) && (!state.withPr || (t.prs || []).length > 0) && (useHits || state.showScheduled || !t.scheduled),
    );
    return (limit ? list.slice(0, limit) : list).map(threadCard).join('') || emptyMsg(state.threadFilter === 'archived' ? 'Sin hilos archivados en este rango de fechas' : 'Sin hilos');
  },
  prs(kind, limit) {
    if (state.errors.prs) return `<div class="err">${esc(state.errors.prs)}</div>`;
    if (!state.prs) return emptyMsg('Cargando…');
    const list = state.prs[kind].filter((p) => match(p.title, p.repo, p.author, p.branch));
    return (limit ? list.slice(0, limit) : list).map((p) => prCard(p, kind)).join('') || emptyMsg('Nada por acá ✨');
  },
  slack(limit) {
    const s = state.slack;
    const hdr = `${s.running && s.source !== 'api' ? '<div class="empty">Consultando Slack con Claude… (~1 min)</div>' : ''}${s.error ? `<div class="banner err" role="alert"><b>${s.errorCode === 'claude_usage_limit' ? 'Límite de Claude alcanzado' : 'No se pudo actualizar Slack'}</b><p>${esc(s.error)}</p><span>${s.fetchedAt ? 'Se conservan los datos de la última consulta exitosa.' : 'Todavía no hay datos guardados para mostrar.'}</span></div>` : ''}`;
    const list = s.items.filter((i) => match(i.channel, i.author, i.text));
    const body = (limit ? list.slice(0, limit) : list).map(slackCard).join('');
    return hdr + (body || (s.running ? '' : emptyMsg(s.error ? 'No se pudo comprobar si hay pendientes en Slack.' : s.fetchedAt ? 'Sin pendientes 🎉' : 'Todavía no consultaste Slack. Tocá ↻ Actualizar.')));
  },
};

const counts = () => {
  const p = state.prs;
  return {
    running: state.threads.filter((t) => t.running).length,
    changes: p ? p.mine.filter((x) => x.flags.includes('changes')).length : 0,
    ci: p ? p.mine.filter((x) => x.flags.includes('ci')).length : 0,
    review: p ? p.toReview.length : 0,
    slack: state.slack.items.length,
  };
};

const STAT_TIPS = {
  'en curso': 'Hilos con actividad en este momento. Clic para ir a Hilos',
  'por revisar': 'PRs que esperan tu review. Clic para ir a PRs',
  'con cambios pedidos': 'Tus PRs donde un reviewer pidió cambios',
  'CI roto': 'Tus PRs con CI fallando',
  'Slack pendientes': 'Mensajes de Slack pendientes de tu respuesta',
};
const renderStats = () => {
  const c = counts();
  $('#stats').innerHTML = [
    ['threads', 'ok', c.running, 'en curso'], ['prs', 'warn', c.review, 'por revisar'], ['prs', 'bad', c.changes, 'con cambios pedidos'],
    ['prs', 'bad', c.ci, 'CI roto'], ['slack', 'warn', c.slack, 'Slack pendientes'],
  ].map(([v, cls, n, l]) => `<span class="chip ${cls}" data-go="${v}" title="${STAT_TIPS[l]}"><b>${n}</b> ${l}</span>`).join('');
  $('#b-threads').textContent = c.running || '';
  $('#b-prs').textContent = c.review + c.changes + c.ci || '';
  $('#b-slack').textContent = c.slack || '';
};

const render = () => {
  if (document.activeElement?.matches?.('.reply textarea, .settings-view input, .settings-view select')
    || document.querySelector('.kcard.dragging')) { state.dirty = true; return; }
  $$('#rail .nav[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#view-title').textContent = { today: 'Hoy', threads: 'Hilos', tasks: 'Tareas', prs: 'Pull requests', slack: 'Slack pendientes', 'work-items': 'Trabajos', settings: 'Configuración' }[state.view] || 'devtower';
  syncRangeUi();
  renderStats();
  const c = $('#content');
  const prev = c.scrollTop;
  const prs = state.prs;
  const custom = window.cockpit?.renderers?.[state.view];
  if (custom) {
    c.innerHTML = custom();
  } else if (state.view === 'board') {
    c.innerHTML = `<div class="board">
      ${panel('threads', 'Hilos recientes', state.threads.length, views.threads(12))}
      ${panel('mine', 'Mis PRs', prs?.mine.length ?? '…', views.prs('mine', 12))}
      ${panel('toReview', 'Para revisar', prs?.toReview.length ?? '…', views.prs('toReview', 12))}
      ${panel('slack', 'Slack pendientes', state.slack.items.length, views.slack(12))}
    </div>`;
  } else if (state.view === 'threads') {
    const visible = state.threadFilter === 'archived' ? state.archivedThreads : state.threads;
    const searchThreads = state.hits && state.hitsQ === state.q ? [...state.hits.values()].map((hit) => hit.thread) : [];
    const available = [...new Map([...visible, ...searchThreads].map((thread) => [thread.id, thread])).values()]
      .filter((thread) => Boolean(thread.archived) === (state.threadFilter === 'archived')
        && (state.showScheduled || !thread.scheduled || (state.hits && state.hitsQ === state.q))
        && (!state.withPr || thread.prs?.length));
    const projects = groupThreadProjects(available);
    if (projects.length && state.projectFilter !== '*' && !projects.some((project) => project.key === state.projectFilter)) {
      state.projectFilter = projects[0].key;
    }
    const selected = projects.find((project) => project.key === state.projectFilter);
    const selectedId = selected ? `thread-project-${projects.indexOf(selected)}` : 'thread-project-all';
    const projectTabs = projects.map((project, index) => {
      const active = project.key === state.projectFilter;
      const repeatedName = projects.some((other) => other.key !== project.key && other.name === project.name);
      const parent = project.directory.split('/').filter(Boolean).slice(-2, -1).join('/');
      return `<button class="project-tab ${active ? 'on' : ''}" role="tab" id="thread-project-${index}"
        aria-selected="${active}" aria-controls="project-thread-panel" tabindex="${active ? 0 : -1}"
        data-project="${esc(project.key)}" title="${esc(project.directory || project.name)}">
        ${project.running ? '<i class="dot run"></i>' : '<span class="project-tab-icon" aria-hidden="true">▣</span>'}
        <span>${esc(project.name)}${repeatedName && parent ? `<small>${esc(parent)}</small>` : ''}</span>
        <b>${project.count}</b></button>`;
    }).join('');
    c.innerHTML = `<div class="viewbar">
      <div class="seg" role="group" aria-label="Estado de los hilos">
        <button class="${state.threadFilter === 'active' ? 'on' : ''}" data-act="thread-filter" data-filter="active" aria-pressed="${state.threadFilter === 'active'}" title="Archivar conserva el historial; borrar lo elimina también de Claude">Activos<b>${state.threads.length}</b></button>
        <button class="${state.threadFilter === 'archived' ? 'on' : ''}" data-act="thread-filter" data-filter="archived" aria-pressed="${state.threadFilter === 'archived'}" title="Podés leerlos, restaurarlos o borrarlos">Archivados<b>${state.archivedThreads.length}</b></button>
      </div>
      <button class="chip ${state.showScheduled ? 'on' : ''}" data-act="toggle-scheduled" aria-pressed="${state.showScheduled}" title="Mostrar sesiones programadas, ocultas por defecto">⏱ Programados</button>
      <button class="chip ${state.withPr ? 'on' : ''}" data-act="toggle-pr" aria-pressed="${state.withPr}">⑂ Con PR</button>
    </div>${state.errors.threads ? `<div class="err" role="alert">${esc(state.errors.threads)}</div>` : ''}
    <div class="project-tabs" role="tablist" aria-label="Proyectos">
      ${projectTabs}<button class="project-tab ${selected ? '' : 'on'}" role="tab" id="thread-project-all"
        aria-selected="${!selected}" aria-controls="project-thread-panel" tabindex="${selected ? -1 : 0}"
        data-project="*" title="Ver hilos de todos los proyectos">Todos <b>${available.length}</b></button>
    </div>
    <div class="project-context"><strong>${esc(selected?.name || 'Todos los proyectos')}</strong>
      ${selected?.directory ? `<span title="${esc(selected.directory)}">${esc(selected.directory)}</span>` : `<span>${projects.length} proyectos</span>`}
      ${selected?.directory ? `<button class="btn sm primary" data-act="new-thread-in" data-cwd="${esc(selected.directory)}" title="Abre un hilo nuevo de Claude en esta carpeta">＋ Nuevo hilo aquí</button>` : ''}</div>
    <section class="list-wide" role="tabpanel" id="project-thread-panel" aria-labelledby="${selectedId}">${views.threads()}</section>`;
  } else if (state.view === 'prs') {
    const tabs = [['mine', 'Mis PRs'], ['toReview', 'Para revisar'], ['reviewed', 'Ya revisados por mí'], ['health', 'Master y métricas']];
    c.innerHTML = `<div class="viewbar"><div class="seg">${tabs.map(([k, l]) => `<button class="${state.prTab === k ? 'on' : ''}" data-prtab="${k}">${l}${k === 'health' ? (state.health?.master.some((r) => r.broken) ? '<b class="bad">●</b>' : '') : `<b>${prs?.[k].length ?? '…'}</b>`}</button>`).join('')}</div>
      <span class="spacer"></span>${(window.cockpit.sourceBtn?.('prs', 'PRs', prs?.fetchedAt, false) ?? '')}</div>
      ${state.prTab === 'health' ? (window.cockpit.renderHealth?.() ?? '') : `<div class="list-wide">${views.prs(state.prTab)}</div>`}`;
  } else {
    c.innerHTML = `<div class="viewbar"><span class="note">${state.slack.source === 'api' ? 'DMs, menciones e hilos sin respuesta tuya · últimos 7 días' : 'Lo lee Claude con tu conector de Slack (solo lectura)'}</span>
      <span class="spacer"></span>${(window.cockpit.sourceBtn?.('slack', 'Slack', state.slack.fetchedAt, state.slack.running) ?? '')}</div><div class="list-wide">${views.slack()}</div>`;
  }
  c.scrollTop = prev;
  applyKb();
  window.cockpit?.afterRender?.();
};

// ------------------------------------------------------------- dock / chat

const MODELS = [
  ['', 'Default · Claude Code', 'Sin forzar modelo: Claude Code lo resuelve según su configuración. No copia la selección de Desktop. El modelo informado aparece en la barra de sesión al iniciar.'],
  ['opus', 'Opus', 'El más capaz: ideal para tareas complejas, más lento y caro'],
  ['sonnet', 'Sonnet', 'Equilibrio entre velocidad, costo y calidad'],
  ['haiku', 'Haiku', 'El más rápido y barato, para tareas simples'],
  ['claude-fable-5-1', 'Fable 5.1', 'Último modelo de la familia Claude 5'],
];
const EFFORTS = [
  ['', 'Auto · CC decide', 'Deja que Claude Code elija el esfuerzo según el modelo y la tarea'],
  ['low', 'Bajo', 'Razonamiento mínimo: respuestas rápidas'],
  ['medium', 'Medio', 'Razonamiento moderado'],
  ['high', 'Alto', 'Razona más antes de responder'],
  ['xhigh', 'Muy alto', 'Razonamiento extendido para problemas difíciles'],
  ['max', 'Máx', 'Máximo esfuerzo: lo más lento y costoso'],
];
const MODES = [
  ['acceptEdits', 'Editar', 'Acepta ediciones de archivos sin preguntar; pide permiso para otros comandos'],
  ['plan', 'Plan', 'Solo investiga y propone un plan: no edita ni ejecuta cambios'],
  ['default', 'Preguntar', 'Pide permiso para cada acción (aparece una tarjeta para permitir y continuar)'],
  ['bypassPermissions', 'Bypass ⚠', 'Ejecuta todo sin preguntar. Peligroso: usar solo en proyectos de confianza'],
];
const fillSelect = (sel, opts) => { sel.innerHTML = opts.map(([v, l, tip]) => `<option value="${v}" title="${esc(tip || '')}">${l}</option>`).join(''); };
fillSelect($('#model'), MODELS);
fillSelect($('#effort'), EFFORTS);
fillSelect($('#mode'), MODES);

const TAB_FIELDS = ['key', 'sessionId', 'cwd', 'title', 'model', 'effort', 'mode', 'allowed', 'deny', 'addDirs', 'appendPrompt', 'maxBudget'];
const tabDefaults = () => ({
  sessionId: null, cwd: '', title: 'Nuevo hilo', messages: [], ctx: [], images: [], draft: '', running: false, runKey: null,
  model: '', effort: '', mode: 'acceptEdits', allowed: [], deny: '', addDirs: '', appendPrompt: '', maxBudget: '',
  cost: 0, turns: 0, info: null, stream: null, fork: false,
});
state.tabs = state.tabs.map((t) => ({ ...tabDefaults(), ...t }));
if (!state.tabs.some((t) => t.key === state.active)) state.active = state.tabs.at(-1)?.key ?? null;
state.showInfo = false;
state.showAdv = false;

const activeTab = () => state.tabs.find((t) => t.key === state.active);
const persistTabs = () => {
  store.set('tabs', state.tabs.map((t) => Object.fromEntries(TAB_FIELDS.map((f) => [f, t[f]]))));
  store.set('active', state.active);
};
const workspaces = () => startWorkspaces(state.threads, state.repos);
// main workspaces (repos and folders, no worktrees), most recently used first
const knownCwds = () => workspaces().main.map((w) => w.dir);
const cwdOptions = (current) => {
  const { main, worktrees } = workspaces();
  const opt = (dir, label) => `<option value="${esc(dir)}" title="${esc(dir)}">${esc(label)}</option>`;
  const listed = new Set([...main, ...worktrees].map((w) => w.dir));
  const used = main.filter((w) => w.count);
  const idle = main.filter((w) => !w.count).sort((a, b) => a.name.localeCompare(b.name));
  return (current && !listed.has(current) ? opt(current, current.split('/').pop()) : '')
    + (used.length ? `<optgroup label="Recientes">${used.map((w) => opt(w.dir, w.name)).join('')}</optgroup>` : '')
    + (idle.length ? `<optgroup label="Repos">${idle.map((w) => opt(w.dir, w.name)).join('')}</optgroup>` : '')
    + (worktrees.length ? `<optgroup label="Worktrees recientes">${worktrees.map((w) => opt(w.dir, `${w.parent} › ${w.name}`)).join('')}</optgroup>` : '');
};
const loadWorkspaces = async () => {
  try { state.repos = (await (await api('/api/workspaces')).json()).repos || []; } catch { /* threads still give folders */ }
};
const showDock = () => { $('#app').classList.remove('no-dock'); $('#app').classList.add('dock-open'); };
let rafPending = false;
const scheduleRender = () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderDock(false); });
};

const newTab = (init = {}) => {
  const last = store.get('defaults', {});
  const tab = { ...tabDefaults(), key: `t${Date.now()}${Math.random().toString(36).slice(2, 5)}`, cwd: init.cwd || knownCwds()[0] || '', model: last.model || '', effort: last.effort || '', mode: last.mode || 'acceptEdits', ...init };
  state.tabs.push(tab);
  state.active = tab.key;
  persistTabs();
  showDock();
  renderDock(true);
  return tab;
};

const openThread = async (id, fallback = null) => {
  const th = findThread(id) || fallback;
  let tab = state.tabs.find((t) => t.sessionId === id);
  if (!tab) tab = newTab({ sessionId: id, cwd: th?.cwd || '', title: th?.title || id.slice(0, 8) });
  state.active = tab.key;
  persistTabs();
  showDock();
  await loadTranscript(tab);
  renderDock(true);
};

const loadTranscript = async (tab) => {
  if (!tab.sessionId || tab.running) return;
  try {
    const r = await api(`/api/threads/${tab.sessionId}`);
    tab.messages = r.ok ? (await r.json()).messages.flatMap((m) => m.blocks.map((b) => ({ role: m.role, ...b }))) : [];
  } catch { /* offline */ }
};

// ---- transcript rendering

const clipLines = (s, n) => { const l = String(s ?? '').split('\n'); return l.length > n ? `${l.slice(0, n).join('\n')}\n… (+${l.length - n} líneas)` : l.join('\n'); };
const diffHtml = (o, n) => {
  const rows = (txt, sign, cls) => clipLines(txt, 40).split('\n').map((l) => `<div class="${cls}">${sign} ${esc(l)}</div>`).join('');
  return `<div class="diff">${o ? rows(o, '-', 'del') : ''}${n ? rows(n, '+', 'add') : ''}</div>`;
};
const todoList = (items) => `<div class="todo">${items.map((t) => {
  const st = t.status || 'pending';
  return `<div class="${st}"><i>${st === 'completed' ? '✓' : st === 'in_progress' ? '◐' : '○'}</i>${esc(t.content || t.activeForm || '')}</div>`;
}).join('')}</div>`;

const toolBody = (m) => {
  const i = m.input || {};
  let body;
  if (m.rawName === 'Edit') body = `<div class="path">${esc(i.file_path)}</div>${diffHtml(i.old_string, i.new_string)}`;
  else if (m.rawName === 'MultiEdit') body = `<div class="path">${esc(i.file_path)}</div>${Array.isArray(i.edits) ? i.edits.map((e) => diffHtml(e.old_string, e.new_string)).join('') : ''}`;
  else if (m.rawName === 'Write') body = `<div class="path">${esc(i.file_path)}</div><pre>${esc(clipLines(i.content, 30))}</pre>`;
  else if (m.rawName === 'Bash') body = `<div class="codeblock"><button class="copy" data-copy data-strip="$ " title="Copiar el comando">Copiar</button><pre>$ ${esc(i.command)}</pre></div>`;
  else body = `<pre>${esc(JSON.stringify(i, null, 2))}</pre>`;
  if (m.result) body += `<pre class="res ${m.error ? 'err' : ''}">${esc(m.result)}</pre>`;
  return body;
};

const renderMsg = (m, i, tab) => {
  if (m.type === 'sys') return `<div class="sys">${esc(m.text)}</div>`;
  if (m.type === 'denial') {
    return `<div class="denial"><b>Permiso denegado</b>${m.items.map((it) => `<div class="m"><code>${esc(it.label)}</code></div>`).join('')}
      <div class="acts"><button class="btn sm primary" data-act="allow" data-i="${i}" title="Guarda estas reglas para el hilo y le pide a Claude que continúe">Permitir y continuar</button><button class="btn sm ghost" data-act="dismiss-denial" data-i="${i}" title="Descartar este aviso sin permitir nada">Ignorar</button></div></div>`;
  }
  if (m.type === 'thinking') return `<details class="think" data-i="${i}" ${m.open ? 'open' : ''}><summary>💭 Pensamiento${m.streaming ? ' …' : ''}</summary><pre>${esc(m.text)}</pre></details>`;
  if (m.type === 'tool') {
    const todos = m.rawName === 'TodoWrite' ? m.input?.todos : m.rawName?.endsWith('update_plan') ? m.input?.items : null;
    if (Array.isArray(todos)) return todoList(todos);
    const icon = m.result !== undefined ? (m.error ? '✗' : '✓') : tab.running ? '⏳' : '·';
    return `<details class="toolcard ${m.error ? 'bad' : ''}" data-i="${i}" ${m.open ? 'open' : ''}><summary><i>${icon}</i><b>${esc(m.name)}</b> ${esc(m.detail)}</summary><div class="tb">${toolBody(m)}</div></details>`;
  }
  if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
  return `<div class="msg assistant">${md(m.text)}${m.streaming ? '<span class="cursor"></span>' : `<button class="cp" data-act="copy-msg" data-i="${i}" title="Copiar">⧉</button>`}</div>`;
};

// Simple mode: tool calls and thinking between two messages collapse into one expandable line;
// your messages, Claude's answers, denials and todo lists stay visible. Verbose shows everything.
state.chatMode = store.get('chatMode', 'simple');
const isStep = (m) => m.type === 'thinking' || (m.type === 'tool' && !(m.rawName === 'TodoWrite' || m.rawName?.endsWith('update_plan')));
const stepGroup = (steps, tab, last) => {
  const tools = steps.filter(({ m }) => m.type === 'tool');
  const counts = {};
  tools.forEach(({ m }) => { counts[m.name] = (counts[m.name] || 0) + 1; });
  const names = Object.entries(counts).slice(0, 5).map(([n, c]) => (c > 1 ? `${esc(n)} ×${c}` : esc(n))).join(' · ');
  const failed = tools.filter(({ m }) => m.error).length;
  const key = steps[0].i;
  const busy = last && tab.running;
  const current = busy ? [...tools].reverse()[0]?.m : null;
  return `<details class="stepgroup ${failed ? 'bad' : ''}" data-group="${key}" ${tab.openGroups?.[key] ? 'open' : ''}>
    <summary><i>${busy ? '⏳' : failed ? '✗' : '⚙'}</i><span>${busy && current ? `${esc(current.name)} ${esc(current.detail || '')}` : `${tools.length || steps.length} ${tools.length === 1 ? 'paso' : 'pasos'}${names ? ` · ${names}` : ''}`}</span>${failed ? `<em>${failed} con error</em>` : ''}</summary>
    <div class="steps">${steps.map(({ m, i }) => renderMsg(m, i, tab)).join('')}</div></details>`;
};
const renderTranscript = (tab) => {
  if (state.chatMode === 'verbose') return tab.messages.map((m, i) => renderMsg(m, i, tab)).join('');
  const out = [];
  let steps = [];
  const flush = (last = false) => { if (steps.length) out.push(stepGroup(steps, tab, last)); steps = []; };
  tab.messages.forEach((m, i) => { if (isStep(m)) steps.push({ m, i }); else { flush(); out.push(renderMsg(m, i, tab)); } });
  flush(true);
  return out.join('');
};

const renderActivity = (tab) => {
  const th = tab && findThread(tab.sessionId);
  const box = $('#activity');
  if (!th || (!th.prs.length && !th.tickets.length && !th.filesCount && !th.commits)) { box.innerHTML = ''; return; }
  const open = box.querySelector('details')?.open ? ' open' : '';
  box.innerHTML = `<details${open}><summary>Actividad · ${th.prs.length} PRs · ${th.filesCount} archivos · ${th.commits} commits${th.pushes ? ` · ${th.pushes} push` : ''}</summary>
    <div class="act-body">
      ${th.tickets.length ? `<div class="m">Tareas: ${th.tickets.map(ticketChip).join(' ')}</div>` : ''}
      ${th.prs.length ? `<div class="m">PRs: ${th.prs.map(prChip).join(' ')}</div>` : ''}
      ${th.branches.length ? `<div class="m">Ramas: ${th.branches.map((b) => `<span class="tag">${esc(b)}</span>`).join(' ')}</div>` : ''}
      ${th.files.length ? `<div class="m files">${th.files.map((f) => `<code>${esc(f)}</code>`).join('')}</div>` : ''}
    </div></details>`;
};

const renderSessionBar = (tab) => {
  const el = $('#sessionbar');
  if (!tab) { el.innerHTML = ''; return; }
  const i = tab.info;
  const mcpOk = i ? i.mcp.filter((s) => s.status === 'connected').length : 0;
  const info = state.showInfo && i ? `<div class="infobox">
      <div><b>Permisos:</b> ${esc(i.permissionMode || tab.mode)} · <b>Tools:</b> ${i.tools}</div>
      <div class="m"><b>MCP:</b> ${i.mcp.map((s) => `<span class="tag ${s.status === 'connected' ? 'ok' : s.status === 'needs-auth' ? 'warn' : ''}">${esc(s.name)}</span>`).join(' ')}</div>
      ${i.agents.length ? `<div class="m"><b>Agentes:</b> ${i.agents.map((a) => `<span class="tag">${esc(a)}</span>`).join(' ')}</div>` : ''}
      <div><b>Comandos/skills:</b> ${i.slashCommands.length}</div></div>` : '';
  el.innerHTML = `<div class="sb"><span title="${i?.model ? 'Modelo informado por Claude Code en la última ejecución' : 'Modelo solicitado; se confirma al iniciar la ejecución'}">${esc(i?.model || tab.model || 'modelo default')}</span>${tab.cost ? `<span>$${tab.cost.toFixed(2)}</span>` : ''}${tab.turns ? `<span>${tab.turns} turnos</span>` : ''}${i ? `<span>${i.tools} tools · MCP ${mcpOk}/${i.mcp.length}</span>` : ''}
    <span class="spacer"></span>
    <div class="seg mini" role="group" aria-label="Detalle del chat">${[['simple', 'Simple', 'Solo los mensajes; los pasos de Claude agrupados en una línea'], ['verbose', 'Detallado', 'Todas las herramientas, resultados y razonamiento']]
      .map(([k, l, t]) => `<button class="${state.chatMode === k ? 'on' : ''}" data-act="chat-mode" data-mode="${k}" title="${t}">${l}</button>`).join('')}</div>
    ${tab.sessionId && !findThread(tab.sessionId)?.archived ? '<button class="btn sm ghost" data-act="fork" title="Continuar en una copia del hilo">⑃ Bifurcar</button><button class="btn sm ghost" data-act="copycmd" title="Copiar comando para retomar en terminal">⌘ CLI</button><button class="btn sm ghost" data-act="rename" title="Renombrar">✎</button>' : ''}
    ${tab.sessionId ? threadActionButtons({ ...findThread(tab.sessionId), id: tab.sessionId, running: tab.running || findThread(tab.sessionId)?.running }) : ''}
    ${i ? '<button class="btn sm ghost" data-act="info" title="Info de la sesión">ⓘ</button>' : ''}</div>${info}`;
};

const renderTray = (tab) => {
  $('#ctx-tray').innerHTML = tab.ctx.map((c, i) => `<span class="ctx"><span title="${esc(c.text)}">${esc(c.label)}</span><button data-rmctx="${i}">×</button></span>`).join('')
    + tab.images.map((im, i) => `<span class="ctx img"><img src="${im.url}" alt=""><span>${esc(im.name)}</span><button data-act="rm-img" data-i="${i}">×</button></span>`).join('');
};

const renderAdv = (tab) => {
  $('#adv').hidden = !state.showAdv;
  $('#adv-dirs').value = tab.addDirs;
  $('#adv-sys').value = tab.appendPrompt;
  $('#adv-deny').value = tab.deny;
  $('#adv-budget').value = tab.maxBudget;
  $('#adv-allowed').innerHTML = tab.allowed.length
    ? `<div class="m">Permitidos en este hilo: ${tab.allowed.map((r, i) => `<span class="ctx"><span>${esc(r)}</span><button data-act="rm-allow" data-i="${i}">×</button></span>`).join(' ')}</div>` : '';
};

const renderDock = (full) => {
  const tab = activeTab();
  $('#tabs').innerHTML = state.tabs.map((t) => `<button class="tab ${t.key === state.active ? 'active' : ''}" data-tab="${t.key}" title="${esc(t.title)}"><i class="dot ${t.running ? 'run' : ''}"></i><span>${esc(t.title)}</span><b class="x" data-close="${t.key}" title="Cerrar pestaña (el hilo se conserva)\n⌥W">×</b></button>`).join('') + '<button class="tab plus" data-act="new-thread">＋ Nuevo</button>';
  renderActivity(tab);
  renderSessionBar(tab);
  if (!tab) {
    $('#transcript').innerHTML = '<div class="welcome"><h3>Sin hilo abierto</h3>Abrí un hilo desde el board, o sumá un PR / mensaje de Slack como contexto para arrancar uno nuevo.</div>';
    $('#composer').style.display = 'none';
    return;
  }
  $('#composer').style.display = '';
  const tr = $('#transcript');
  const nearBottom = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
  tr.innerHTML = tab.messages.length === 0
    ? '<div class="welcome"><h3>Hilo nuevo</h3>Escribí abajo. <b>/</b> para comandos y skills, <b>@</b> para archivos, pegá imágenes con ⌘V.</div>'
    : renderTranscript(tab);
  if (full || nearBottom) tr.scrollTop = tr.scrollHeight;
  renderTray(tab);
  if (full) {
    $('#input').value = tab.draft;
    renderAdv(tab);
  }
  $('#model').value = tab.model;
  $('#effort').value = tab.effort;
  $('#mode').value = tab.mode;
  const sel = $('#cwd');
  sel.innerHTML = cwdOptions(tab.cwd);
  sel.value = tab.cwd;
  sel.disabled = Boolean(tab.sessionId);
  $('#model').disabled = $('#effort').disabled = false;
  $('#send').disabled = tab.running || Boolean(findThread(tab.sessionId)?.archived);
  $('#stop').hidden = !tab.running;
};

$('#transcript').addEventListener('toggle', (e) => {
  const d = e.target;
  const tab = activeTab();
  if (tab && d.dataset?.group !== undefined) { tab.openGroups = { ...(tab.openGroups || {}), [d.dataset.group]: d.open }; return; }
  if (tab && d.dataset?.i !== undefined && tab.messages[d.dataset.i]) tab.messages[d.dataset.i].open = d.open;
}, true);

// ---- context chips

const addContext = (ctx, { draft, cwd } = {}) => {
  let tab = activeTab();
  if (!tab || tab.sessionId) tab = newTab({ cwd: cwd || tab?.cwd });
  else if (cwd) tab.cwd = cwd;
  tab.ctx.push(ctx);
  if (draft && tab.draft.trim() === '') tab.draft = draft;
  if (tab.title === 'Nuevo hilo') tab.title = ctx.label.slice(0, 40);
  persistTabs();
  showDock();
  renderDock(true);
  $('#input').focus();
};

const prCtx = (p) => ({
  label: `PR ${p.repoName}#${p.number}`,
  text: `PR ${p.repo}#${p.number} "${p.title}" (${p.url}) — rama ${p.branch} → ${p.base}, autor @${p.author}, CI ${p.ci || 'n/a'}, decisión ${p.reviewDecision || 'n/a'}, ${p.unresolved} hilos sin resolver.${(p.checks || []).some((c) => c.state === 'fail') ? ` Checks fallando: ${p.checks.filter((c) => c.state === 'fail').map((c) => `${c.name} (${c.url})`).join(', ')}.` : ''}`,
});
const slackCtx = (s) => ({
  label: `Slack ${s.channel} · ${s.author}`,
  text: `Mensaje de Slack en ${s.channel} de ${s.author}${s.ts ? ` (${s.ts})` : ''}: "${s.text}"${s.permalink ? ` — ${s.permalink}` : ''}`,
});

// ---- sending / streaming

const closeStream = (tab) => {
  if (tab.stream) tab.stream.msg.streaming = false;
  tab.stream = null;
};

const onEvent = (tab, ev) => {
  switch (ev.t) {
    case 'start': tab.runKey = ev.key; break;
    case 'init':
      tab.sessionId = ev.sessionId; tab.runKey = ev.sessionId; tab.fork = false; tab.info = ev;
      persistTabs();
      break;
    case 'delta': {
      const type = ev.kind === 'text' ? 'text' : 'thinking';
      if (tab.stream?.type !== type) {
        closeStream(tab);
        const msg = { role: 'assistant', type, text: '', streaming: true };
        tab.messages.push(msg);
        tab.stream = { type, msg };
      }
      tab.stream.msg.text += ev.text;
      break;
    }
    case 'text':
    case 'thinking':
      if (tab.stream?.type === ev.t) { tab.stream.msg.text = ev.text; closeStream(tab); } else { closeStream(tab); tab.messages.push({ role: 'assistant', type: ev.t, text: ev.text }); }
      break;
    case 'tool': closeStream(tab); tab.messages.push({ role: 'assistant', ...ev }); break;
    case 'tool_result': { const blk = tab.messages.find((m) => m.id === ev.id); if (blk) Object.assign(blk, { result: ev.text, error: ev.error }); break; }
    case 'result': {
      closeStream(tab);
      tab.cost += ev.cost || 0;
      tab.turns += ev.turns || 0;
      const tok = ev.usage ? ` · ${ev.usage.input}→${ev.usage.output} tok` : '';
      tab.messages.push({ type: 'sys', text: `listo · ${(ev.ms / 1000).toFixed(0)}s${ev.cost ? ` · $${ev.cost.toFixed(3)}` : ''}${tok}${ev.isError ? ' · con error' : ''}` });
      if (ev.denials?.length) {
        const items = ev.denials.map((d) => ({ rule: d.tool === 'Bash' ? `Bash(${d.input.command})` : d.tool, label: d.tool === 'Bash' ? `Bash: ${d.input.command}` : `${d.tool} ${d.input.file_path || d.input.url || ''}`.trim() }));
        tab.messages.push({ type: 'denial', items });
      }
      break;
    }
    case 'error': tab.messages.push({ type: 'sys', text: `⚠ ${ev.message}` }); break;
    default:
  }
  scheduleRender();
};

const send = async (override) => {
  const tab = activeTab();
  if (!tab || tab.running) return;
  if (findThread(tab.sessionId)?.archived) { toast('Restaurá el hilo antes de continuarlo'); return; }
  const text = (typeof override === 'string' ? override : $('#input').value).trim();
  if (text === '' && tab.ctx.length === 0 && tab.images.length === 0) return;
  const ctxText = tab.ctx.map((c) => `[Contexto] ${c.text}`).join('\n');
  const prompt = (text.startsWith('/') ? [text, ctxText] : [ctxText, text]).filter(Boolean).join('\n\n');
  const body = {
    sessionId: tab.sessionId, fork: tab.fork, cwd: tab.cwd, prompt, permissionMode: tab.mode, model: tab.model, effort: tab.effort,
    images: tab.images.map(({ mediaType, data }) => ({ mediaType, data })),
    allowedTools: tab.allowed, disallowedTools: tab.deny.split(',').map((x) => x.trim()).filter(Boolean),
    addDirs: tab.addDirs.split('\n').map((x) => x.trim()).filter(Boolean), appendSystemPrompt: tab.appendPrompt, maxBudget: Number(tab.maxBudget) || 0,
  };
  const label = tab.ctx.map((c) => `📎 ${c.label}`).join('  ');
  tab.messages.push({ role: 'user', type: 'text', text: `${label}${label ? '\n' : ''}${text}${tab.images.length ? `\n🖼 ×${tab.images.length}` : ''}` });
  tab.ctx = []; tab.images = []; tab.draft = ''; $('#input').value = '';
  if (text !== '') { tab.history = [...(tab.history || []), text]; tab.hIdx = null; }
  tab.running = true;
  if (tab.title === 'Nuevo hilo') tab.title = (text || 'Hilo').slice(0, 40);
  store.set('defaults', { model: tab.model, effort: tab.effort, mode: tab.mode });
  renderDock(true);
  try {
    const res = await api('/api/run', body);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line) onEvent(tab, JSON.parse(line)); }
    }
  } catch (e) {
    tab.messages.push({ type: 'sys', text: `⚠ ${e.message}` });
  }
  closeStream(tab);
  tab.running = false;
  renderDock(false);
  loadThreads();
};

// ---- dock actions

const flash = (msg) => { const tab = activeTab(); if (tab) { tab.messages.push({ type: 'sys', text: msg }); renderDock(false); } };

$('#dock').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const tab = activeTab();
  const i = Number(el.dataset.i);
  switch (el.dataset.act) {
    case 'copy-msg': await navigator.clipboard.writeText(tab.messages[i].text); el.textContent = '✓'; break;
    case 'info': state.showInfo = !state.showInfo; renderSessionBar(tab); break;
    case 'chat-mode': state.chatMode = el.dataset.mode; store.set('chatMode', state.chatMode); renderDock(false); break;
    case 'copycmd': await navigator.clipboard.writeText(`cd '${tab.cwd}' && claude --resume ${tab.sessionId}`); flash('Comando copiado al portapapeles'); break;
    case 'rename': {
      const title = prompt('Nuevo nombre del hilo', tab.title);
      if (title && title.trim()) { await api('/api/rename', { id: tab.sessionId, title: title.trim() }); tab.title = title.trim(); persistTabs(); renderDock(false); loadThreads(); }
      break;
    }
    case 'fork': newTab({ sessionId: tab.sessionId, fork: true, cwd: tab.cwd, title: `⑃ ${tab.title}`.slice(0, 40), messages: [...tab.messages], model: tab.model, effort: tab.effort, mode: tab.mode, allowed: [...tab.allowed] }); flash('Bifurcado: tu próximo mensaje crea una copia del hilo.'); break;
    case 'allow': {
      const m = tab.messages[i];
      m.items.forEach((it) => { if (!tab.allowed.includes(it.rule)) tab.allowed.push(it.rule); });
      tab.messages.splice(i, 1);
      persistTabs();
      send('Ya tenés permiso para esas acciones. Continuá con lo que estabas haciendo.');
      break;
    }
    case 'dismiss-denial': tab.messages.splice(i, 1); renderDock(false); break;
    case 'rm-img': tab.images.splice(i, 1); renderTray(tab); break;
    case 'rm-allow': tab.allowed.splice(i, 1); persistTabs(); renderAdv(tab); break;
    default:
  }
});

const bindTabField = (sel, field, transform = (v) => v) => {
  $(sel).addEventListener('change', (e) => { const t = activeTab(); if (t) { t[field] = transform(e.target.value); persistTabs(); renderSessionBar(t); } });
};
bindTabField('#model', 'model');
bindTabField('#effort', 'effort');
bindTabField('#mode', 'mode');
bindTabField('#adv-dirs', 'addDirs');
bindTabField('#adv-sys', 'appendPrompt');
bindTabField('#adv-deny', 'deny');
bindTabField('#adv-budget', 'maxBudget');
$('#adv-toggle').addEventListener('click', () => { state.showAdv = !state.showAdv; $('#adv').hidden = !state.showAdv; });

// ---- images

const addImages = (files) => {
  const tab = activeTab();
  if (!tab) return;
  [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.size < 5_000_000).forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => { tab.images.push({ mediaType: f.type, data: String(reader.result).split(',')[1], url: reader.result, name: f.name || 'imagen' }); renderTray(tab); };
    reader.readAsDataURL(f);
  });
};
$('#attach').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });
$('#input').addEventListener('paste', (e) => { const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addImages(imgs); } });
$('#composer').addEventListener('dragover', (e) => e.preventDefault());
$('#composer').addEventListener('drop', (e) => { e.preventDefault(); addImages(e.dataTransfer.files); });

// ---- slash / @file autocomplete

const popup = { open: false, type: null, items: [], sel: 0, start: 0, end: 0 };
const cmdCache = {};
const getCommands = (cwd) => { cmdCache[cwd] ??= api(`/api/commands?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json()).then((d) => d.commands || []).catch(() => []); return cmdCache[cwd]; };
let fileTimer;

const renderPopup = () => {
  const box = $('#popup');
  box.hidden = !popup.open || popup.items.length === 0;
  box.innerHTML = popup.items.map((it, i) => (popup.type === 'slash'
    ? `<div class="pi ${i === popup.sel ? 'sel' : ''}" data-pi="${i}"><b>/${esc(it.name)}</b><em>${esc(it.source)}</em><span>${esc(it.description)}</span></div>`
    : `<div class="pi ${i === popup.sel ? 'sel' : ''}" data-pi="${i}"><b>@${esc(it)}</b></div>`)).join('');
};
const closePopup = () => { popup.open = false; popup.items = []; renderPopup(); };

const updatePopup = async () => {
  const tab = activeTab();
  const input = $('#input');
  if (!tab) return;
  const before = input.value.slice(0, input.selectionStart);
  let m = before.match(/^\/([\w:.-]*)$/);
  if (m) {
    const q = m[1].toLowerCase();
    const all = await getCommands(tab.cwd || '~');
    const items = all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q))).slice(0, 8);
    Object.assign(popup, { open: true, type: 'slash', items, sel: 0, start: 0, end: input.selectionStart });
    return renderPopup();
  }
  m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (m && tab.cwd) {
    clearTimeout(fileTimer);
    fileTimer = setTimeout(async () => {
      const { files } = await (await api(`/api/files?cwd=${encodeURIComponent(tab.cwd)}&q=${encodeURIComponent(m[1])}`)).json();
      Object.assign(popup, { open: true, type: 'file', items: files.slice(0, 8), sel: 0, start: before.length - m[1].length - 1, end: before.length });
      renderPopup();
    }, 120);
    return null;
  }
  return closePopup();
};

const acceptPopup = (idx) => {
  const it = popup.items[idx];
  if (!it) return;
  const input = $('#input');
  const ins = popup.type === 'slash' ? `/${it.name} ` : `@${it} `;
  input.value = input.value.slice(0, popup.start) + ins + input.value.slice(popup.end);
  input.selectionStart = input.selectionEnd = popup.start + ins.length;
  const tab = activeTab();
  if (tab) tab.draft = input.value;
  closePopup();
  input.focus();
};

$('#input').addEventListener('input', updatePopup);
$('#input').addEventListener('blur', () => setTimeout(closePopup, 150));
$('#popup').addEventListener('mousedown', (e) => { const row = e.target.closest('[data-pi]'); if (row) { e.preventDefault(); acceptPopup(Number(row.dataset.pi)); } });
$('#input').addEventListener('keydown', (e) => {
  if (!popup.open || popup.items.length === 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    popup.sel = (popup.sel + (e.key === 'ArrowDown' ? 1 : -1) + popup.items.length) % popup.items.length;
    renderPopup();
  } else if ((e.key === 'Tab' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    acceptPopup(popup.sel);
  } else if (e.key === 'Escape') closePopup();
}, true);

// ------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('a')) return;
  const go = t.closest('[data-go]');
  if (go) return setView(go.dataset.go);
  const nav = t.closest('#rail .nav[data-view]');
  if (nav) return setView(nav.dataset.view);
  const tabEl = t.closest('[data-tab]');
  if (tabEl && !t.closest('[data-close]')) { state.active = tabEl.dataset.tab; persistTabs(); const tab = activeTab(); await loadTranscript(tab); return renderDock(true); }
  const close = t.closest('[data-close]');
  if (close) {
    state.tabs = state.tabs.filter((x) => x.key !== close.dataset.close);
    if (state.active === close.dataset.close) state.active = state.tabs.at(-1)?.key ?? null;
    persistTabs(); return renderDock(true);
  }
  const rm = t.closest('[data-rmctx]');
  if (rm) { activeTab().ctx.splice(Number(rm.dataset.rmctx), 1); return renderDock(false); }
  const proj = t.closest('[data-project]');
  if (proj) {
    state.projectFilter = proj.dataset.project || '*';
    store.set(`threadProject:${state.threadFilter}`, state.projectFilter);
    state.kbIdx = -1;
    return render();
  }
  const prt = t.closest('[data-prtab]');
  if (prt) { state.prTab = prt.dataset.prtab; store.set('prTab', state.prTab); return render(); }

  const actEl = t.closest('[data-act]');
  if (!actEl) return;
  const card = actEl.closest('.card');
  const pr = () => ['mine', 'toReview', 'reviewed'].flatMap((k) => state.prs?.[k] || []).find((p) => p.key === card.dataset.key);
  switch (actEl.dataset.act) {
    case 'collapse': { const id = actEl.closest('.panel').dataset.panel; state.collapsed[id] = !state.collapsed[id]; store.set('collapsed', state.collapsed); return render(); }
    case 'thread-filter':
      state.threadFilter = actEl.dataset.filter;
      state.hits = null;
      state.projectFilter = store.get(`threadProject:${state.threadFilter}`, null);
      $('#search').dispatchEvent(new Event('input'));
      return;
    case 'thread-archive': return updateThreadLifecycle(actEl.dataset.id, 'archive');
    case 'thread-restore': return updateThreadLifecycle(actEl.dataset.id, 'restore');
    case 'thread-delete': return confirmThreadDeletion(actEl.dataset.id);
    case 'open-thread': return openThread(actEl.dataset.id);
    case 'new-thread': return newTab();
    case 'new-thread-in': newTab({ cwd: actEl.dataset.cwd }); return $('#input').focus();
    case 'toggle-scheduled': state.showScheduled = !state.showScheduled; store.set('showScheduled', state.showScheduled); return render();
    case 'toggle-pr': state.withPr = !state.withPr; return render();
    case 'pr-ctx': return addContext(prCtx(pr()), { cwd: pr().localDir });
    case 'pr-review': return addContext(prCtx(pr()), { cwd: pr().localDir, draft: 'Hacé un primer pase de review de este PR y dame un borrador en español con las observaciones. No publiques nada en GitHub.' });
    case 'pr-fix': return addContext(prCtx(pr()), { cwd: pr().localDir, draft: 'Mirá los comentarios de review sin resolver de este PR y proponé los fixes. Mostrame el plan antes de editar.' });
    case 'pr-ci': return addContext(prCtx(pr()), { cwd: pr().localDir, draft: 'El CI de este PR está fallando. Mirá los checks, encontrá la causa y proponé el fix.' });
    case 'slack-ctx': return addContext(slackCtx(state.slack.items.find((i) => i.id === card.dataset.id)), { draft: 'Ayudame a responder / resolver este mensaje de Slack.' });
    case 'slack-reply': {
      const id = card.dataset.id;
      const cur = state.replies[id] || { text: '' };
      state.replies[id] = { ...cur, open: !cur.open };
      render();
      if (state.replies[id].open) $$('#content .card').find((c) => c.dataset.id === id)?.querySelector('.reply textarea')?.focus();
      return null;
    }
    case 'slack-suggest': return slackSuggest(card.dataset.id);
    case 'slack-draft': return slackDraft(card.dataset.id);
    case 'slack-send': return slackSend(card.dataset.id);
    case 'slack-dismiss': await api('/api/slack/dismiss', { id: card.dataset.id }); return loadSlack();
    default:
  }
});

const setView = (v) => { document.activeElement?.blur?.(); state.view = v; store.set('view', v); render(); };

let searchTimer;
$('#search').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  render();
  clearTimeout(searchTimer);
  if (state.q.length < 2 || state.view === 'work-items') { state.hits = null; return; }
  searchTimer = setTimeout(async () => {
    const q = state.q;
    const visibility = state.threadFilter;
    const revision = state.threadRevision;
    try {
      const { hits } = await (await api(`/api/search?q=${encodeURIComponent(q)}&days=${state.sdays}&visibility=${visibility}`)).json();
      if (q !== state.q || visibility !== state.threadFilter || revision !== state.threadRevision) return;
      state.hits = new Map(hits.map((h) => [h.id, h]));
      state.hitsQ = q;
      render();
    } catch { /* keep local filter */ }
  }, 250);
});
$('#refresh').addEventListener('click', async () => {
  if (state.view === 'work-items') return window.cockpit.loadWorkItems?.();
  loadThreads(); loadPrs(true);
  if (state.view === 'slack') { await api('/api/slack/refresh', {}); state.slack.running = true; render(); pollSlack(); }
  if (state.view === 'tasks') window.cockpit.refreshJira?.();
});
const pollSlack = () => {
  const iv = setInterval(async () => { await loadSlack(); if (!state.slack.running) clearInterval(iv); }, 4000);
};
$('#toggle-dock').addEventListener('click', () => { $('#app').classList.toggle('no-dock'); $('#app').classList.remove('dock-open'); });
$('#send').addEventListener('click', () => send());
$('#stop').addEventListener('click', () => { const t = activeTab(); if (t?.runKey) api('/api/stop', { key: t.runKey }); });
$('#input').addEventListener('input', (e) => { const t = activeTab(); if (t) t.draft = e.target.value; });
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); send(); } });
$('#cwd').addEventListener('change', (e) => { const t = activeTab(); if (t) { t.cwd = e.target.value; persistTabs(); } });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#search').focus(); } });

const resizer = $('#resizer');
resizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev) => { const w = Math.min(900, Math.max(340, window.innerWidth - ev.clientX)); document.documentElement.style.setProperty('--dock', `${w}px`); store.set('dock', w); };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
});
if (store.get('dock', null)) document.documentElement.style.setProperty('--dock', `${store.get('dock', 460)}px`);

const RANGES = [[1, 'Último día'], [7, '7 días'], [14, '14 días'], [30, '30 días'], [90, '90 días'], [365, '1 año'], [0, 'Todo']];
const fillRange = (sel, value) => { sel.innerHTML = RANGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); sel.value = String(value); };
fillRange($('#days'), state.days);
fillRange($('#sdays'), state.sdays);
// range selectors only matter for threads; other views keep the topbar identical
const syncRangeUi = () => {
  const searching = state.q.length >= 2;
  const threads = state.view === 'threads';
  $('#sdays').hidden = !threads || !searching;
  $('#days').hidden = !threads || searching;
};
$('#days').addEventListener('change', (e) => { state.days = Number(e.target.value); store.set('days', state.days); loadThreads(); });
$('#sdays').addEventListener('change', (e) => { state.sdays = Number(e.target.value); store.set('sdays', state.sdays); state.hits = null; $('#search').dispatchEvent(new Event('input')); });
$('#search').addEventListener('input', syncRangeUi);

const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  $('#theme span').textContent = t === 'light' ? '☾' : '☀';
};
applyTheme(document.documentElement.dataset.theme || 'light');
$('#theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

// ------------------------------------------------------------- slack replies

const slackItem = (id) => state.slack.items.find((i) => i.id === id);
const slackSuggest = async (id) => {
  const r = state.replies[id];
  Object.assign(r, { busy: true, error: false, link: null, status: 'Claude está leyendo el hilo y redactando… (puede tardar ~30 s)' });
  render();
  try {
    const res = await api('/api/slack/suggest', { id, instruction: r.text });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    Object.assign(r, { text: d.text, status: state.slack.source === 'api' ? 'Sugerencia lista. Editala si querés y enviala.' : 'Sugerencia lista. Editala si querés y guardá el borrador.' });
  } catch (e) { Object.assign(r, { status: e.message, error: true }); }
  r.busy = false;
  render();
};
const slackDraft = async (id) => {
  const r = state.replies[id];
  if (!r.text.trim()) return;
  Object.assign(r, { busy: true, error: false, link: null, status: 'Guardando borrador en Slack…' });
  render();
  try {
    const res = await api('/api/slack/draft', { id, text: r.text });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    Object.assign(r, { status: 'Borrador guardado en Slack. Revisalo y envialo desde ahí.', link: d.link || slackItem(id)?.permalink });
  } catch (e) { Object.assign(r, { status: e.message, error: true }); }
  r.busy = false;
  render();
};
const slackSend = async (id) => {
  const r = state.replies[id];
  if (!r.text.trim()) return;
  Object.assign(r, { busy: true, error: false, link: null, status: 'Enviando a Slack…' });
  render();
  try {
    const res = await api('/api/slack/send', { id, text: r.text });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    delete state.replies[id];
    state.slack.items = state.slack.items.filter((i) => i.id !== id);
    toast('Respuesta enviada a Slack');
  } catch (e) { Object.assign(r, { status: e.message, error: true, busy: false }); }
  render();
};
document.addEventListener('input', (e) => {
  const ta = e.target.closest?.('.reply textarea');
  const id = ta?.closest('.card')?.dataset.id;
  if (id && state.replies[id]) state.replies[id].text = ta.value;
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target.closest?.('.reply textarea')) { e.preventDefault(); e.target.closest('.card').querySelector('[data-primary]')?.click(); }
});
document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('.reply textarea')) setTimeout(() => { if (state.dirty) { state.dirty = false; render(); } }, 0);
});

// ------------------------------------------------------------- tooltips / shortcuts / help

const tipEl = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'tip' }));
let tipTimer;
const hideTip = () => { clearTimeout(tipTimer); tipEl.classList.remove('on'); };
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[title],[data-tip]');
  if (!el) return hideTip();
  if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
  const text = el.dataset.tip;
  if (!text) return null;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tipEl.textContent = text;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const below = r.bottom + 8 + tipEl.offsetHeight < window.innerHeight;
    tipEl.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    tipEl.style.top = `${below ? r.bottom + 8 : r.top - tipEl.offsetHeight - 8}px`;
    tipEl.classList.add('on');
  }, 350);
  return null;
});
document.addEventListener('mouseout', hideTip);
document.addEventListener('mousedown', hideTip);
document.addEventListener('scroll', hideTip, true);

const toastEl = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toast' }));
let toastTimer;
const toast = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1400);
};

const deleteDialog = document.body.appendChild(Object.assign(document.createElement('dialog'), {
  id: 'thread-delete-dialog',
}));
let deletingThread = null;
let deletingBusy = false;

const updateThreadLifecycle = async (id, action) => {
  if (state.threadMutations.has(id)) return false;
  if (state.tabs.some((tab) => tab.sessionId === id && tab.running) || findThread(id)?.running) {
    toast('Detené el hilo y esperá unos segundos antes de modificarlo');
    return false;
  }
  state.threadMutations.add(id);
  state.threadRevision += 1;
  render(); renderDock(false);
  try {
    const res = await api(`/api/threads/${encodeURIComponent(id)}/${action}`, action === 'delete' ? { confirm: true } : {});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const thread = findThread(id);
    state.threads = state.threads.filter((t) => t.id !== id);
    state.archivedThreads = state.archivedThreads.filter((t) => t.id !== id);
    if (thread && action !== 'delete') {
      thread.archived = action === 'archive';
      (thread.archived ? state.archivedThreads : state.threads).push(thread);
      state.threads.sort((a, b) => b.mtimeMs - a.mtimeMs);
      state.archivedThreads.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    if (action === 'delete') {
      state.tabs = state.tabs.filter((tab) => tab.sessionId !== id);
      if (!activeTab()) state.active = state.tabs.at(-1)?.key ?? null;
      persistTabs();
    }
    state.hits = null;
    sw.hits = []; sw.hitsQ = '';
    toast(action === 'delete' ? 'Historial eliminado de Claude y devtower' : action === 'archive' ? 'Hilo archivado. Lo encontrás en Archivados.' : 'Hilo restaurado');
    return true;
  } catch (error) {
    if (action === 'delete' && deleteDialog.open) {
      deleteDialog.querySelector('[role="alert"]').textContent = error.message;
    } else toast(error.message);
    return false;
  } finally {
    state.threadMutations.delete(id);
    state.threadRevision += 1;
    render(); renderDock(action === 'delete');
    await loadThreads();
    if (state.q.length >= 2) $('#search').dispatchEvent(new Event('input'));
  }
};

const confirmThreadDeletion = (id) => {
  const thread = findThread(id);
  const tab = state.tabs.find((t) => t.sessionId === id);
  if (thread?.running || tab?.running) { toast('No se puede borrar un hilo activo'); return; }
  deletingThread = id;
  deleteDialog.innerHTML = `<h2 id="delete-thread-title">¿Borrar este hilo?</h2>
    <p class="thread-delete-name">${esc(thread?.title || tab?.title || id)}</p>
    <p>Se eliminará permanentemente el archivo de historial original de Claude y el hilo dejará de estar disponible en devtower y en Claude Code.</p>
    <p class="note">No se borran el código, la rama, los commits ni los PRs. Las pestañas de este hilo se cerrarán. Esta acción no se puede deshacer.</p>
    <p class="err" role="alert"></p>
    <div class="acts"><button class="btn" data-delete-cancel autofocus>Cancelar</button>
    <button class="btn danger" data-delete-confirm>Borrar historial definitivamente</button></div>`;
  deleteDialog.setAttribute('aria-labelledby', 'delete-thread-title');
  deleteDialog.showModal();
};

deleteDialog.addEventListener('cancel', (event) => { if (deletingBusy) event.preventDefault(); });
deleteDialog.addEventListener('click', async (event) => {
  if (event.target.closest('[data-delete-cancel]') && !deletingBusy) deleteDialog.close();
  if (!event.target.closest('[data-delete-confirm]') || deletingBusy) return;
  deletingBusy = true;
  deleteDialog.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  const ok = await updateThreadLifecycle(deletingThread, 'delete');
  deletingBusy = false;
  if (ok) deleteDialog.close();
  else deleteDialog.querySelectorAll('button').forEach((button) => { button.disabled = false; });
});

const SHORTCUTS = [
  ['Navegación', [['⌥B · ⌥H · ⌥T · ⌥R · ⌥S', 'Hoy · Hilos · Tareas · PRs · Slack'], ['⌥G', 'Trabajos locales'], ['⌘K', 'Accesos rápidos: vistas, links, tickets'], ['/', 'Buscar'], ['⌥← / ⌥→  ó  [ / ]', 'Sección anterior / siguiente'], ['J / K  ó  ↑ / ↓', 'Moverse por las tarjetas de la lista'], ['↵  ·  O', 'Acción principal de la tarjeta · abrir su link'], ['← / →', 'Cambiar de pestaña dentro de PRs'], ['⌘B', 'Mostrar / ocultar el chat'], ['⌘⇧L', 'Tema claro / oscuro'], ['⌘⇧R', 'Actualizar datos']]],
  ['Hilos y pestañas', [['⌥N', 'Nuevo hilo'], ['⌥W', 'Cerrar pestaña'], ['⌥[  /  ⌥]', 'Pestaña anterior / siguiente'], ['⌥1 – ⌥9', 'Ir a la pestaña N'], ['⌥↑  /  ⌥↓', 'Hilo anterior / siguiente (por recencia)'], ['⌘P  ó  ⌘O', 'Ir a un hilo (buscador rápido)'], ['⌥L', 'Ir al mensaje']]],
  ['Mensaje', [['↵', 'Enviar'], ['⇧↵', 'Nueva línea'], ['Esc', 'Detener respuesta / cerrar menús'], ['↑  /  ↓', 'Mensajes anteriores (con el campo vacío)'], ['⇧Tab', 'Rotar modo de permisos'], ['⌥P', 'Rotar modelo'], ['⌥E', 'Rotar esfuerzo'], ['⌥U', 'Adjuntar imagen'], ['⌥,', 'Opciones avanzadas'], ['/  ·  @', 'Comandos y skills · archivos']]],
  ['General', [['⌘↑  /  ⌘↓', 'Inicio / fin de la conversación'], ['?  ó  ⌘/', 'Esta ayuda']]],
];
const helpEl = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'help', hidden: true }));
helpEl.innerHTML = `<div class="card2"><h2>Atajos de teclado</h2><p class="note">Como corre en el navegador, ⌘W, ⌘N, ⌘T, ⌘1–9 y ⌃Tab los reserva el navegador. Por eso los atajos principales usan ⌥ (Option / Alt).</p><div class="grid2">${SHORTCUTS.map(([g, rows]) => `<div><h3>${g}</h3>${rows.map(([k, d]) => `<div class="k"><span>${d}</span><kbd>${k}</kbd></div>`).join('')}</div>`).join('')}</div></div>`;
const toggleHelp = (on) => { helpEl.hidden = on === undefined ? !helpEl.hidden : !on; };
helpEl.addEventListener('click', (e) => { if (e.target === helpEl) toggleHelp(false); });
$('#help-btn').addEventListener('click', () => toggleHelp(true));

const closeTab = (key) => {
  state.tabs = state.tabs.filter((x) => x.key !== key);
  if (state.active === key) state.active = state.tabs.at(-1)?.key ?? null;
  persistTabs();
  renderDock(true);
};
const cycleTab = async (dir) => {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.key === state.active);
  const next = state.tabs[(i + dir + state.tabs.length) % state.tabs.length];
  state.active = next.key;
  persistTabs();
  await loadTranscript(next);
  renderDock(true);
};
const cycleField = (field, list, label) => {
  const tab = activeTab();
  if (!tab) return;
  const i = list.findIndex(([v]) => v === tab[field]);
  const [v, name] = list[(i + 1) % list.length];
  tab[field] = v;
  persistTabs();
  renderDock(false);
  toast(`${label}: ${name}`);
};
const scrollTranscript = (top) => { const tr = $('#transcript'); tr.scrollTo({ top: top ? 0 : tr.scrollHeight, behavior: 'smooth' }); };
const recallHistory = (e, dir) => {
  const tab = activeTab();
  const input = $('#input');
  const hist = tab?.history || [];
  if (!tab || hist.length === 0) return;
  if (tab.hIdx == null && input.value !== '') return;
  const next = tab.hIdx == null ? (dir < 0 ? hist.length - 1 : null) : tab.hIdx + dir;
  if (next == null) return;
  e.preventDefault();
  if (next >= hist.length) { tab.hIdx = null; input.value = ''; } else { tab.hIdx = Math.max(0, next); input.value = hist[tab.hIdx]; }
  tab.draft = input.value;
};

// ---- keyboard-only thread switching

const swEl = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'switcher', hidden: true }));
swEl.innerHTML = '<div class="card2"><input id="sw-input" placeholder="Ir a un hilo…  título, proyecto, ticket, PR o contenido"><div id="sw-list"></div><div class="sw-foot">↑↓ moverse · ↵ abrir · esc cerrar</div></div>';
const sw = { sel: 0, q: '', hits: null, hitsQ: '', timer: null };

const swItems = () => {
  const terms = sw.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (t) => `${t.title} ${t.project} ${t.branch} ${(t.tickets || []).join(' ')} ${(t.prs || []).map((p) => p.key).join(' ')}`.toLowerCase();
  const open = state.tabs
    .filter((tab) => terms.every((x) => tab.title.toLowerCase().includes(x)))
    .map((tab) => ({ kind: 'tab', key: tab.key, title: tab.title, sub: `pestaña abierta · ${tab.cwd.split('/').pop()}`, running: tab.running }));
  const openIds = new Set(state.tabs.map((t) => t.sessionId));
  const useHits = sw.hits && sw.hitsQ === sw.q && terms.length > 0;
  const pool = useHits ? sw.hits.map((h) => h.thread) : state.threads.filter((t) => terms.every((x) => hay(t).includes(x)));
  const threads = pool.filter((t) => !openIds.has(t.id)).slice(0, 30)
    .map((t) => ({ kind: 'thread', id: t.id, title: t.title, sub: `${t.project} · ${ago(t.updatedAt)}${t.prs?.length ? ` · ${t.prs.length} PR` : ''}`, running: t.running }));
  const starts = terms.length ? workspaces().main.filter((w) => terms.every((x) => w.name.toLowerCase().includes(x))).slice(0, 5)
    .map((w) => ({ kind: 'new', cwd: w.dir, title: `＋ Nuevo hilo en ${w.name}`, sub: w.dir })) : [];
  return [...starts, ...open, ...threads];
};
const renderSw = () => {
  const items = swItems();
  sw.sel = Math.min(sw.sel, Math.max(0, items.length - 1));
  $('#sw-list').innerHTML = items.map((it, i) => `<div class="sw-item ${i === sw.sel ? 'sel' : ''}" data-i="${i}"><i class="dot ${it.running ? 'run' : ''}"></i><b>${esc(it.title)}</b><span>${esc(it.sub)}</span></div>`).join('') || '<div class="empty">Sin resultados</div>';
  $('#sw-list .sel')?.scrollIntoView({ block: 'nearest' });
  return items;
};
const openSwitcher = () => { sw.q = ''; sw.sel = 0; sw.hits = null; swEl.hidden = false; $('#sw-input').value = ''; renderSw(); $('#sw-input').focus(); };
const closeSwitcher = () => { swEl.hidden = true; };
const gotoTab = async (i) => {
  const tab = state.tabs[i];
  if (!tab) return;
  state.active = tab.key;
  persistTabs();
  showDock();
  await loadTranscript(tab);
  renderDock(true);
};
const acceptSwitcher = async () => {
  const it = renderSw()[sw.sel];
  closeSwitcher();
  if (!it) return;
  if (it.kind === 'tab') await gotoTab(state.tabs.findIndex((t) => t.key === it.key));
  else if (it.kind === 'new') newTab({ cwd: it.cwd });
  else await openThread(it.id);
  $('#input').focus();
};
$('#sw-input').addEventListener('input', (e) => {
  sw.q = e.target.value.trim();
  sw.sel = 0;
  renderSw();
  clearTimeout(sw.timer);
  if (sw.q.length < 2) { sw.hits = null; return; }
  sw.timer = setTimeout(async () => {
    const q = sw.q;
    try {
      const { hits } = await (await api(`/api/search?q=${encodeURIComponent(q)}&days=${state.sdays}`)).json();
      if (q !== sw.q) return;
      sw.hits = hits;
      sw.hitsQ = q;
      renderSw();
    } catch { /* local results stay */ }
  }, 200);
});
$('#sw-input').addEventListener('keydown', (e) => {
  const n = swItems().length;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); sw.sel = (sw.sel + 1) % Math.max(1, n); renderSw(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); sw.sel = (sw.sel - 1 + Math.max(1, n)) % Math.max(1, n); renderSw(); }
  else if (e.key === 'Enter') { e.preventDefault(); acceptSwitcher(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
});
swEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.sw-item');
  if (row) { sw.sel = Number(row.dataset.i); acceptSwitcher(); } else if (e.target === swEl) closeSwitcher();
});

const stepThread = (dir) => {
  const list = state.threads;
  const cur = list.findIndex((t) => t.id === activeTab()?.sessionId);
  const next = list[cur < 0 ? (dir > 0 ? 0 : -1) : cur + dir];
  if (next) openThread(next.id);
};

const VIEWS = ['today', 'threads', 'tasks', 'prs', 'slack', 'work-items'];
const stepView = (dir) => setView(VIEWS[(VIEWS.indexOf(state.view) + dir + VIEWS.length) % VIEWS.length]);
const stepPrTab = (dir) => {
  const tabs = ['mine', 'toReview', 'reviewed'];
  state.prTab = tabs[(tabs.indexOf(state.prTab) + dir + tabs.length) % tabs.length];
  store.set('prTab', state.prTab);
  state.kbIdx = -1;
  render();
};
const kbCards = () => $$('#content .card');
const applyKb = () => {
  const cards = kbCards();
  cards.forEach((c, i) => c.classList.toggle('kb', i === state.kbIdx));
  cards[state.kbIdx]?.scrollIntoView({ block: 'nearest' });
};
const listNav = (e) => {
  const cards = kbCards();
  if (e.key === ']') { stepView(1); return true; }
  if (e.key === '[') { stepView(-1); return true; }
  if (cards.length === 0) return false;
  const down = e.key === 'j' || e.key === 'ArrowDown';
  const up = e.key === 'k' || e.key === 'ArrowUp';
  if (down || up) {
    e.preventDefault();
    state.kbIdx = Math.max(0, Math.min(cards.length - 1, state.kbIdx + (down ? 1 : -1)));
    applyKb();
    return true;
  }
  const card = cards[state.kbIdx];
  if (e.key === 'Enter' && card) {
    e.preventDefault();
    if (card.dataset.act === 'open-thread') card.click();
    else (card.querySelector('.btn.primary') || card.querySelector('[data-act="pr-ctx"]'))?.click();
    setTimeout(() => $('#input').focus(), 50);
    return true;
  }
  if (e.key === 'o' && card) {
    card.querySelector('a.lnk[href]')?.click();
    return true;
  }
  if (e.key === 'ArrowRight' && state.view === 'prs') { e.preventDefault(); stepPrTab(1); return true; }
  if (e.key === 'ArrowLeft' && state.view === 'prs') { e.preventDefault(); stepPrTab(-1); return true; }
  return false;
};

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('.project-tabs [role="tab"]') && !e.altKey && !e.metaKey && !e.ctrlKey
    && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const tabs = $$('.project-tabs [role="tab"]');
    const current = tabs.indexOf(e.target.closest('[role="tab"]'));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
      : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const project = tabs[next].dataset.project;
    tabs[next].click();
    $$('.project-tabs [role="tab"]').find((tab) => tab.dataset.project === project)?.focus();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  // ⌥E/⌥N/⌥U son teclas muertas de acentos (á, ñ, ü) en macOS: al escribir no son atajos.
  if (typing && (e.key === 'Dead' || e.isComposing)) return;
  const tab = activeTab();
  if (!helpEl.hidden) { if (e.key === 'Escape') { e.preventDefault(); toggleHelp(false); } return; }
  if (!swEl.hidden) return;

  if (e.altKey && !mod && !e.shiftKey) {
    const alt = {
      KeyW: () => { if (tab) closeTab(tab.key); },
      KeyN: () => { newTab(); $('#input').focus(); },
      KeyL: () => { showDock(); $('#input').focus(); },
      KeyU: () => $('#attach').click(),
      Comma: () => $('#adv-toggle').click(),
      KeyB: () => setView('today'),
      KeyT: () => setView('tasks'),
      KeyH: () => setView('threads'),
      KeyR: () => setView('prs'),
      KeyS: () => setView('slack'),
      KeyG: () => setView('work-items'),
      BracketLeft: () => cycleTab(-1),
      BracketRight: () => cycleTab(1),
    }[e.code];
    if (alt) { e.preventDefault(); alt(); return; }
  }

  if (mod && !e.shiftKey && !e.altKey) {
    const views = { 1: 'today', 2: 'threads', 3: 'tasks', 4: 'prs', 5: 'slack' };
    if (views[key]) { e.preventDefault(); setView(views[key]); return; }
    const handled = {
      k: () => window.cockpit.openPalette?.(),
      n: () => { newTab(); $('#input').focus(); },
      b: () => { $('#app').classList.toggle('no-dock'); $('#app').classList.remove('dock-open'); },
      l: () => { showDock(); $('#input').focus(); },
      u: () => $('#attach').click(),
      p: openSwitcher,
      o: openSwitcher,
      ',': () => $('#adv-toggle').click(),
      '/': () => toggleHelp(true),
      arrowup: () => scrollTranscript(true),
      arrowdown: () => scrollTranscript(false),
    }[key];
    if (handled) { e.preventDefault(); handled(); return; }
  }
  if (mod && e.shiftKey && !e.altKey) {
    if (key === 'o') { e.preventDefault(); newTab(); $('#input').focus(); return; }
    if (key === 'l') { e.preventDefault(); $('#theme').click(); return; }
    if (key === 'r') { e.preventDefault(); $('#refresh').click(); return; }
    if (e.code === 'BracketLeft') { e.preventDefault(); cycleTab(-1); return; }
    if (e.code === 'BracketRight') { e.preventDefault(); cycleTab(1); return; }
  }
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
  if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); gotoTab(Number(e.code.slice(5)) - 1); return; }
  if (e.altKey && !mod && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { e.preventDefault(); stepView(e.code === 'ArrowRight' ? 1 : -1); return; }
  if (mod && !e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) { e.preventDefault(); stepView(e.code === 'BracketRight' ? 1 : -1); return; }
  if (e.altKey && !mod && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) { e.preventDefault(); stepThread(e.code === 'ArrowDown' ? 1 : -1); return; }
  if (!typing && !mod && !e.altKey && listNav(e)) return;
  if (e.altKey && !mod && e.code === 'KeyP') { e.preventDefault(); cycleField('model', MODELS, 'Modelo'); return; }
  if (e.altKey && !mod && e.code === 'KeyE') { e.preventDefault(); cycleField('effort', EFFORTS, 'Esfuerzo'); return; }
  if (e.shiftKey && e.key === 'Tab' && document.activeElement?.id === 'input') { e.preventDefault(); cycleField('mode', MODES, 'Permisos'); return; }
  if (e.key === 'ArrowUp' && document.activeElement?.id === 'input' && !popup.open) { recallHistory(e, -1); return; }
  if (e.key === 'ArrowDown' && document.activeElement?.id === 'input' && !popup.open) { recallHistory(e, 1); return; }
  if (e.key === 'Escape') {
    if (popup.open) return;
    if (tab?.running) { $('#stop').click(); toast('Detenido'); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if (!typing && e.key === '?') { e.preventDefault(); toggleHelp(true); }
});

window.cockpit = {
  state, api, store, $, $$, esc, ago, match, render, setView, addContext, newTab, activeTab, openThread, findThread, renderDock, persistTabs,
  knownCwds, prChip, prTags, prCtx, ticketChip, toast, loadThreads, loadPrs, loadSlack, pollSlack, renderers: {},
};

// ------------------------------------------------------------- boot

(async () => {
  render(); renderDock(true);
  await Promise.all([loadThreads(), loadPrs(false), loadSlack(), loadWorkspaces()]);
  const tab = activeTab();
  if (tab) { await loadTranscript(tab); renderDock(true); }
  if (state.slack.running) pollSlack();
  // deep links from macOS notifications: #thread=<id> opens the thread, #view=<name> the view
  const followHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('thread')) openThread(h.get('thread'));
    else if (h.get('view') && $(`#rail [data-view="${CSS.escape(h.get('view'))}"]`)) setView(h.get('view'));
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  };
  followHash();
  window.addEventListener('hashchange', followHash);
  setInterval(loadThreads, 10_000);
  setInterval(() => loadPrs(false), 120_000);
  // server refreshes sources in background; the UI only re-reads its cache
  setInterval(() => { if (!state.slack.running) loadSlack(); window.cockpit.loadJira?.(); }, 60_000);
  setInterval(async () => {
    const t = activeTab();
    const th = t && state.threads.find((x) => x.id === t.sessionId);
    if (t && th?.running && !t.running) { await loadTranscript(t); renderDock(false); }
  }, 6000);
})();
