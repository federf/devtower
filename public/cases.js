// Casos: everything that needs your attention (Slack, Gmail, PRs) analyzed by Claude in the background.
// Each case arrives with a proposal, questions for you and actions you approve with one click.
// Claude only reads and proposes: nothing is sent or commented until you confirm.
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, api, esc, ago, $ } = C;

state.cases = { cases: [], running: null, config: null, gmail: false, loaded: false, error: '' };
const S = state.cases;
let openId = null;
let busy = '';
let tab = C.store.get('casesTab', 'ready');
let landed = false;
const ICON = { slack: '#', gmail: '✉', pr: '⑂', jira: '☰' };
const SRC = { slack: 'Slack', gmail: 'Gmail', pr: 'GitHub', jira: 'Jira' };

const getJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const dialog = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'case-dialog', hidden: true }));

const refresh = async () => {
  try {
    const data = await getJson('/api/cases');
    Object.assign(S, { cases: data.cases, running: data.running, config: data.config, gmail: data.gmail, loaded: true, error: '' });
  } catch (e) { S.error = e.message; }
  const badge = $('#b-cases');
  if (badge) badge.textContent = (S.cases || []).filter((c) => c.status === 'ready' && !isRefined(c)).length || '';
  if (state.view === 'cases') C.render();
  if (!dialog.hidden && !dirty && !dialog.contains(document.activeElement)) drawDialog();
};
C.loadCases = refresh;

setInterval(() => { if (state.view === 'cases' || S.running || !dialog.hidden) refresh(); }, 6000);
setTimeout(refresh, 2500);

const STATUS = {
  new: ['en cola', ''], processing: ['analizando…', 'info'], ready: ['propuesta lista', 'ok'],
  done: ['resuelto', ''], dismissed: ['descartado', ''], resolved: ['ya no está pendiente', ''],
};
const chip = (c) => { const [label, cls] = c.failedAt ? ['falló', 'bad'] : STATUS[c.status] || [c.status, '']; return `<span class="tag ${cls}">${label}</span>`; };

// sent back to Claude with answers and not closed yet: lives in its own tab until you start development or dismiss it
const isRefined = (c) => Boolean(c.refinedAt || Object.keys(c.answers || {}).length) && ['new', 'processing', 'ready'].includes(c.status);

const caseRow = (c) => `<div class="card item sev${c.sev || 3}" data-case="${esc(c.id)}">
  <i class="ico">${ICON[c.source] || '•'}</i>
  <div class="main"><div class="t"><span>${esc(c.title)}</span></div>
    <div class="m"><span class="why">${SRC[c.source] || c.source} · ${esc(c.from)}</span>${c.project ? `<span class="tag" title="Proyecto sobre el que analizó Claude">${esc(c.project)}</span>` : ''}${chip(c)}${c.proposal?.questions?.length && c.status === 'ready' ? `<span class="tag nosprint">${c.proposal.questions.length} ${c.proposal.questions.length === 1 ? 'duda' : 'dudas'}</span>` : ''}${c.at ? `<span>${ago(c.at)}</span>` : ''}</div>
    ${c.status === 'ready' && c.proposal?.summary ? `<p class="note case-sum">${esc(c.proposal.summary)}</p>` : ''}
    ${c.error ? `<p class="note err">${esc(c.error)}</p>` : ''}</div>
  <div class="acts">${isRefined(c) && c.status === 'ready' && c.proposal ? '<button class="btn sm primary" data-act="case-go" title="Abrir un chat con esta propuesta y tus decisiones, en modo plan">▶ Iniciar desarrollo</button>' : ''}<button class="btn sm ${c.status === 'ready' && !isRefined(c) ? 'primary' : ''}" data-act="case-open">${c.status === 'ready' ? 'Revisar propuesta' : 'Abrir'}</button>${['dismissed', 'done', 'resolved'].includes(c.status) ? '' : '<button class="btn sm ghost" data-act="case-dismiss" title="Ya lo resolví o no hace falta: sacarlo de la lista">Descartar</button>'}</div></div>`;

C.renderers.cases = () => {
  if (!S.loaded) { return S.error ? `<p class="err">${esc(S.error)}</p>` : '<div class="empty">Cargando casos…</div>'; }
  const list = S.cases || [];
  const q = state.q.toLocaleLowerCase();
  const shown = list.filter((c) => !q || `${c.title} ${c.from} ${c.text}`.toLocaleLowerCase().includes(q));
  const tabs = [
    ['refined', 'En proceso', shown.filter((c) => isRefined(c)), 'Las que decidiste trabajar (mandaste respuestas a Claude): cuando termine de refinar, iniciá el desarrollo desde acá'],
    ['ready', 'Para decidir', shown.filter((c) => c.status === 'ready' && !isRefined(c)), 'Claude ya analizó: revisá la propuesta, respondé las dudas y aprobá'],
    ['queue', 'En cola', shown.filter((c) => (c.status === 'new' || c.status === 'processing') && !isRefined(c)), 'Todavía sin relevar: se analizan en la corrida diaria, los más urgentes primero'],
    ['closed', 'Cerrados', shown.filter((c) => ['done', 'dismissed', 'resolved'].includes(c.status)), 'Resueltos, descartados o que dejaron de estar pendientes'],
  ];
  // first visit of the session: land on what you're already working on, if any
  if (!landed) { landed = true; if (tabs[0][2].length) { tab = 'refined'; C.store.set('casesTab', tab); } }
  const cur = tabs.find(([k]) => k === tab) || tabs[0];
  const cfg = S.config || {};
  return `<div class="work-toolbar"><div><strong>Casos que requieren tu atención</strong>
    <p class="note">Slack, ${S.gmail ? 'Gmail' : '<a class="lnk" data-go="settings">Gmail (sin conectar)</a>'} y PRs. Claude los analiza solo (solo lectura): ${cfg.auto ? `automático una vez al día a las ${cfg.at} (${cfg.timezone ? esc(cfg.timezone.split('/').pop().replace('_', ' ')) : 'horario del sistema'}), solo casos nuevos` : 'automático apagado: analizá cada caso a mano'} · se configura en <a class="lnk" data-go="settings">Config</a>.</p></div>
    ${S.running ? '<span class="tag info">Claude analizando casos…</span>' : (S.cases || []).some((c) => c.status === 'new' && !c.failedAt) ? '<button class="btn sm" data-act="case-run" title="Analizar ahora todos los casos que todavía no se relevaron">▶ Analizar pendientes ahora</button>' : ''}</div>
    <div class="viewbar"><div class="seg">${tabs.map(([k, label, items]) => `<button class="${k === cur[0] ? 'on' : ''}" data-act="case-tab" data-tab="${k}">${label}<b>${items.length}</b></button>`).join('')}</div><em class="note">${cur[3]}</em></div>
    ${cur[2].length ? `<div class="list-wide">${cur[2].map(caseRow).join('')}</div>` : `<div class="empty-state"><div class="big">✓</div><h3>Nada en «${cur[1]}»</h3><p>${cur[0] === 'ready' ? 'Cuando Claude termine de analizar un caso, aparece acá.' : cur[0] === 'refined' ? 'Cuando refines un caso con tus respuestas, queda acá para que inicies el desarrollo.' : 'No hay casos en este estado.'}</p></div>`}
`;
};

// ------------------------------------------------------------------ detail dialog

// small markdown: headings, lists, fenced/inline code and bold; everything else is escaped text
const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const md = (text) => {
  const out = [];
  let list = null;
  let code = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(text).split('\n')) {
    if (/^```/.test(line)) { if (code) { out.push(`<pre>${esc(code.join('\n'))}</pre>`); code = null; } else { close(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (h) { close(); out.push(`<h5>${inline(h[1])}</h5>`); }
    else if (li) { const kind = li[1] ? 'ol' : 'ul'; if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (code) out.push(`<pre>${esc(code.join('\n'))}</pre>`);
  close();
  return out.join('');
};
const bullets = (items, kind = 'ul') => (items?.length ? `<${kind} class="case-list">${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${kind}>` : '');
const section = (title, body) => (body ? `<section class="case-sec"><h4>${title}</h4>${body}</section>` : '');
const proposalHtml = (p) => `${section('Qué se pide', bullets(p.scope))}
  ${section('Solución propuesta', bullets(p.steps, 'ol'))}
  ${section('Archivos a tocar', p.files?.length ? `<table class="case-files">${p.files.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td>${inline(f.change)}</td></tr>`).join('')}</table>` : '')}
  ${section('Riesgos', bullets(p.risks))}
  ${section('Pruebas', bullets(p.tests))}
  ${p.proposal ? section(p.steps?.length ? 'Detalle' : 'Propuesta', `<div class="case-prop">${md(p.proposal)}</div>`) : ''}`;

const actionBox = (c, a, i) => {
  const gmail = c.source === 'gmail' && a.type === 'reply';
  return `<div class="case-act"><b>${esc(a.label)}${a.type === 'comment' ? ` · ${esc(a.target)}` : ''}</b>
    <textarea rows="4" data-case-text="${i}">${esc(a.text)}</textarea>
    <div class="row">${gmail ? `<button class="btn sm primary" data-act="case-copy" data-i="${i}">Copiar borrador</button><a class="btn sm" target="_blank" rel="noopener noreferrer" href="${esc(c.link)}">Abrir en Gmail ↗</a>`
      : `<button class="btn sm primary" data-act="case-send" data-i="${i}" ${busy ? 'disabled' : ''}>${esc(a.label)}</button>`}</div></div>`;
};

let dirty = false; // picked/typed answers not sent yet: don't let the poll redraw them away
const drawDialog = () => {
  dirty = false;
  const c = (S.cases || []).find((x) => x.id === openId);
  if (!c) { dialog.hidden = true; return; }
  const p = c.proposal;
  const scroll = dialog.querySelector('.tbody')?.scrollTop || 0;
  dialog.hidden = false;
  dialog.className = 'tmodal';
  dialog.innerHTML = `<div class="tscrim" data-act="case-close"></div><div class="tdialog" role="dialog" aria-label="${esc(c.title)}">
    <div class="thead"><b>${ICON[c.source]} ${esc(c.title)}</b><span class="spacer"></span>${chip(c)}${c.link ? `<a class="btn sm ghost" target="_blank" rel="noopener noreferrer" href="${esc(c.link)}">Abrir ↗</a>` : ''}<button class="btn sm ghost" data-act="case-close" title="Cerrar (Esc)">✕</button></div>
    <div class="tbody case-body">
      <p class="note">${SRC[c.source]} · ${esc(c.from)}${c.project ? ` · proyecto ${esc(c.project)}` : ''}${c.at ? ` · ${ago(c.at)}` : ''}</p>
      <blockquote class="case-quote">${esc(c.text)}</blockquote>
      ${busy ? `<div class="banner">${esc(busy)}</div>` : ''}
      ${c.status === 'processing' ? '<div class="banner">Claude está analizando este caso con el contexto disponible (código, tickets, el hilo)… puede tardar unos minutos.</div>' : ''}
      ${c.error ? `<div class="banner err">${esc(c.error)}</div>` : ''}
      ${p && c.status === 'ready' ? `<div class="case-go"><button class="btn primary" data-act="case-go" title="Abre un hilo de Claude en modo Plan con este caso, tu propuesta y tus respuestas como contexto">▶ Avanzar con el desarrollo</button><span class="note">Abre un hilo en modo Plan: no edita nada hasta que lo apruebes.</span></div>` : ''}
      ${p ? `<div class="case-sumbox"><p>${esc(p.summary)}</p>${p.estimate || c.project ? `<div class="case-meta">${p.estimate ? `<span class="tag">⏱ ${esc(p.estimate)}</span>` : ''}${c.project ? `<span class="tag">${esc(c.project)}</span>` : ''}</div>` : ''}</div>
        ${proposalHtml(p)}
        ${p.questions.length ? `<h4>Dudas para decidir</h4>${p.questions.map((q) => `<div class="case-q"><b>${esc(q.text)}</b>
          ${q.options.length ? `<div class="schips">${q.options.map((o) => `<label class="chip ${c.answers?.[q.id] === o ? 'on' : ''}"><input type="radio" name="q-${esc(q.id)}" value="${esc(o)}" ${c.answers?.[q.id] === o ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>` : ''}
          <input data-case-q="${esc(q.id)}" placeholder="${q.options.length ? 'Otra respuesta (opcional)' : 'Tu respuesta'}" value="${esc(c.answers?.[q.id] && !q.options.includes(c.answers[q.id]) ? c.answers[q.id] : '')}"></div>`).join('')}
          <textarea rows="2" id="case-note" placeholder="Indicación extra para Claude (opcional): más corto, enfocate en…"></textarea>
          <div class="row"><button class="btn primary" data-act="case-refine" ${busy || c.status === 'processing' ? 'disabled' : ''}>Responder y refinar la propuesta</button></div>` : `<div class="row"><textarea rows="2" id="case-note" placeholder="Indicación para Claude (opcional)"></textarea><button class="btn" data-act="case-refine" ${busy || c.status === 'processing' ? 'disabled' : ''}>Refinar</button></div>`}
        ${p.actions.length ? `<h4>Acciones (nada se envía sin tu click)</h4>${p.actions.map((a, i) => actionBox(c, a, i)).join('')}`
          : p.reply ? `<h4>Borrador de respuesta</h4><div class="case-act"><textarea rows="4" readonly>${esc(p.reply)}</textarea><div class="row"><button class="btn sm" data-act="case-copy-reply">Copiar</button></div></div>` : ''}` : ''}
      ${!p && c.status !== 'processing' ? `<div class="row"><button class="btn primary" data-act="case-analyze" ${busy ? 'disabled' : ''}>${c.failedAt ? 'Reintentar análisis' : 'Analizar ahora con Claude'}</button></div>` : ''}
      <div class="row case-foot">${p && c.status !== 'processing' ? '<button class="btn sm ghost" data-act="case-analyze" title="Volver a analizar desde cero">↻ Reanalizar</button>' : ''}
        ${!['dismissed', 'done'].includes(c.status) ? '<button class="btn sm ghost" data-act="case-dismiss">Descartar caso</button>' : ''}
        ${c.source === 'gmail' && /<([^>]+)>/.test(c.from) ? '<button class="btn sm ghost" data-act="case-mute" title="No volver a traer correos de este remitente">Silenciar remitente</button>' : ''}</div>
    </div></div>`;
  const body = dialog.querySelector('.tbody');
  if (body) body.scrollTop = scroll;
};

const textOf = (i) => dialog.querySelector(`[data-case-text="${i}"]`)?.value ?? '';
const call = async (label, fn) => {
  busy = label; drawDialog();
  try { await fn(); } catch (e) { C.toast(e.message); }
  busy = ''; await refresh(); drawDialog();
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act^="case-"]');
  if (!el) return;
  const id = openId || el.closest('[data-case]')?.dataset.case;
  const c = (S.cases || []).find((x) => x.id === id);
  switch (el.dataset.act) {
    case 'case-go': {
      if (!c?.proposal) break;
      const p = c.proposal;
      const answers = Object.entries(c.answers || {}).map(([k, v]) => `- ${p.questions.find((x) => x.id === k)?.text || k} → ${v}`).join('\n');
      const key = c.source === 'jira' ? c.ref : (/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/.exec(`${c.title} ${c.text}`)?.[0] || '');
      const text = `Caso (${SRC[c.source]}): ${c.title}\nDe: ${c.from}\n${c.link ? `Link: ${c.link}\n` : ''}\nPedido:\n${c.text}\n\nResumen del análisis:\n${p.summary}\n\nPropuesta:\n${[p.scope?.length && `Qué se pide:\n${p.scope.map((x) => `- ${x}`).join('\n')}`, p.steps?.length && `Solución propuesta:\n${p.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`, p.files?.length && `Archivos:\n${p.files.map((f) => `- ${f.path}: ${f.change}`).join('\n')}`, p.risks?.length && `Riesgos:\n${p.risks.map((x) => `- ${x}`).join('\n')}`, p.tests?.length && `Pruebas:\n${p.tests.map((x) => `- ${x}`).join('\n')}`, p.proposal].filter(Boolean).join('\n\n')}${answers ? `\n\nDecisiones que tomé:\n${answers}` : ''}`;
      C.addContext({ label: key || c.title.slice(0, 30), text }, { cwd: C.knownCwds?.()[0], draft: `Avancemos con el desarrollo según esta propuesta${key ? ` (${key})` : ''}. Primero armá el plan detallado y marcame lo que quieras confirmar antes de tocar código.` });
      const tab = C.activeTab?.();
      if (tab && !tab.sessionId) { tab.mode = 'plan'; C.persistTabs?.(); C.renderDock?.(false); }
      await getJson('/api/cases/dismiss', { id, status: 'done', label: 'Desarrollo iniciado' }).catch(() => {});
      openId = null; dialog.hidden = true; refresh(); break;
    }
    case 'case-run': await call('Iniciando el análisis…', () => getJson('/api/cases/run', {})); break;
    case 'case-tab': tab = el.dataset.tab; C.store.set('casesTab', tab); C.render(); break;
    case 'case-open': openId = el.closest('[data-case]').dataset.case; drawDialog(); break;
    case 'case-close': openId = null; dialog.hidden = true; break;
    case 'case-analyze': await call('Iniciando el análisis…', () => getJson('/api/cases/process', { id })); break;
    case 'case-refine': {
      const answers = {};
      dialog.querySelectorAll('[data-case-q]').forEach((inp) => {
        const q = inp.dataset.caseQ;
        const picked = dialog.querySelector(`input[name="q-${CSS.escape(q)}"]:checked`)?.value;
        const v = inp.value.trim() || picked;
        if (v) answers[q] = v;
      });
      await call('Enviando tus respuestas a Claude…', () => getJson('/api/cases/answer', { id, answers, note: dialog.querySelector('#case-note')?.value || '' }));
      tab = 'refined'; C.store.set('casesTab', tab); openId = null; dialog.hidden = true; C.toast('Enviado: la encontrás en «En proceso»'); C.render();
      break;
    }
    case 'case-send': {
      const i = Number(el.dataset.i);
      const a = c?.proposal?.actions?.[i];
      if (!a || !confirm(`¿${a.label}${a.type === 'comment' ? ` en ${a.target}` : ''}?\n\n${textOf(i)}`)) break;
      await call('Enviando…', () => getJson('/api/cases/act', { id, index: i, text: textOf(i) }));
      C.toast('Listo, caso resuelto');
      break;
    }
    case 'case-copy': await navigator.clipboard.writeText(textOf(Number(el.dataset.i))); C.toast('Borrador copiado'); break;
    case 'case-copy-reply': await navigator.clipboard.writeText(c?.proposal?.reply || ''); C.toast('Copiado'); break;
    case 'case-mute': {
      const email = /<([^>]+)>/.exec(c?.from || '')?.[1];
      if (!email || !confirm(`¿Ignorar todos los correos de ${email}?`)) break;
      await call('Silenciando…', () => getJson('/api/gmail/mute', { email }));
      await call('Descartando…', () => getJson('/api/cases/dismiss', { id }));
      openId = null; dialog.hidden = true; C.toast(`${email} silenciado`); break;
    }
    case 'case-dismiss': await call('Descartando…', () => getJson('/api/cases/dismiss', { id })); openId = null; dialog.hidden = true; C.toast('Caso descartado'); break;
    default:
  }
});
dialog.addEventListener('change', (e) => {
  const radio = e.target.closest('input[type=radio]');
  if (!radio) return;
  dirty = true;
  dialog.querySelectorAll(`input[name="${CSS.escape(radio.name)}"]`).forEach((r) => r.closest('.chip')?.classList.toggle('on', r.checked));
});
dialog.addEventListener('input', () => { dirty = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dialog.hidden) { e.stopImmediatePropagation(); openId = null; dialog.hidden = true; } }, true);
