// Close flow for a task already in prod: review → impersonate check → comment (+ mentions) → transition.
// Nothing is written to Jira until the final confirmation. Relies on window.cockpit.
const C = window.cockpit;
const { state, api, esc, ago } = C;

const el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'closeflow', hidden: true }));
let f = null; // flow state

const getJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const cleanTitle = (t) => t.replace(/^\s*\[[^\]]+\]\s*-?\s*/, '');

// default comment: what shipped, built from the deploy check (no AI)
const templateComment = (key) => {
  const d = state.deploy[key];
  const shipped = (d?.results || []).filter((r) => ['prod', 'merged_untracked'].includes(r.status));
  const prodTag = shipped.find((r) => r.prodTag)?.prodTag;
  const lines = shipped.map((r) => `• ${cleanTitle(r.title)} (${r.repo.split('/')[1]}#${r.number})`);
  return `Ya está en producción${prodTag ? ` (versión ${prodTag})` : ''}.\n\nCambios incluidos:\n${lines.join('\n') || '• —'}`;
};
const deployNotes = (key) => (state.deploy[key]?.results || [])
  .map((r) => `${r.ticket} · ${r.repo}#${r.number} "${r.title}" · ${r.status}${r.prodTag ? ` (prod ${r.prodTag})` : ''}`).join('\n');

const open = async (key) => {
  f = { key, loading: true, stage: 'edit' };
  draw();
  try {
    // the comment template needs the deploy check: run it if it was not done yet
    const [ctx, deploy] = await Promise.all([getJson(`/api/jira/issue?key=${encodeURIComponent(key)}`),
      state.deploy[key]?.results ? state.deploy[key] : getJson('/api/deploy-check', { key }).catch(() => null)]);
    if (deploy) state.deploy[key] = deploy;
    const done = ctx.transitions.find((t) => t.toCategory === 'done');
    const people = [ctx.issue.reporter, ctx.issue.assignee].filter((p) => p && p.accountId !== ctx.me.accountId)
      .filter((p, i, all) => all.findIndex((x) => x.accountId === p.accountId) === i);
    Object.assign(f, { ...ctx, loading: false, comment: templateComment(key), withComment: true,
      notify: Object.fromEntries(people.map((p, i) => [p.accountId, i === 0])), people,
      transitionId: done?.id || '', impersonateAnswer: ctx.impersonate.likely ? null : 'n/a' });
  } catch (e) { Object.assign(f, { loading: false, error: e.message }); }
  draw();
};
C.openCloseFlow = open;

const section = (n, title, body) => `<section class="cf-sec"><h3><b>${n}</b>${title}</h3>${body}</section>`;
const mentions = () => f.people.filter((p) => f.notify[p.accountId]);
const transition = () => f.transitions.find((t) => t.id === f.transitionId);
const blocked = () => (f.impersonate.likely && !f.impersonateAnswer ? 'Confirmá la validación por impersonate'
  : !f.withComment && !f.transitionId ? 'Elegí al menos una acción' : f.withComment && !f.comment.trim() ? 'El comentario está vacío' : '');

const editView = () => {
  const i = f.issue;
  const d = state.deploy[f.key];
  const review = `<div class="cf-issue"><a class="lnk" target="_blank" href="${esc(i.url)}">${esc(i.key)}</a> <b>${esc(i.summary)}</b>
      <div class="m"><span class="tag info">${esc(i.status)}</span><span class="tag">${esc(i.type)}</span><span class="tag">${esc(i.priority)}</span>
      ${i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}<span>Pidió: ${esc(i.reporter?.name || '—')}</span></div></div>
    ${i.description ? `<details><summary>Descripción</summary><pre>${esc(i.description)}</pre></details>` : ''}
    ${i.comments.length ? `<details><summary>Últimos comentarios (${i.comments.length})</summary>${i.comments.map((c) => `<div class="cf-com"><b>${esc(c.author)}</b> · ${ago(c.at)}<pre>${esc(c.text)}</pre></div>`).join('')}</details>` : ''}
    ${C.deployPanel?.(f.key) || ''}`;
  const imp = f.impersonate.likely
    ? `<div class="cf-warn" role="alert"><b>⚠ Esta tarea puede requerir validación por impersonate</b><ul>${f.impersonate.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <label><input type="radio" name="cf-imp" value="done" ${f.impersonateAnswer === 'done' ? 'checked' : ''}> Ya la validé por impersonate</label>
        <label><input type="radio" name="cf-imp" value="skip" ${f.impersonateAnswer === 'skip' ? 'checked' : ''}> No hace falta validarla</label></div>`
    : '<p class="note">No detecté indicios de que haga falta validar por impersonate.</p>';
  const notify = f.people.length ? `<div class="cf-notify">Notificar: ${f.people.map((p) => `<label class="chip ${f.notify[p.accountId] ? 'on' : ''}"><input type="checkbox" data-notify="${esc(p.accountId)}" ${f.notify[p.accountId] ? 'checked' : ''}> @${esc(p.name)}</label>`).join('')}</div>` : '';
  const comment = `<label class="cf-check"><input type="checkbox" id="cf-with-comment" ${f.withComment ? 'checked' : ''}> Publicar comentario</label>
    ${f.withComment ? `${notify}<textarea id="cf-comment" rows="7">${esc(f.comment)}</textarea>
      <div class="acts"><button class="btn sm" data-cf="draft" ${f.drafting ? 'disabled' : ''} title="Claude redacta a partir de la descripción y los PRs (consume cuota)">${f.drafting ? 'Redactando…' : '✨ Redactar con Claude'}</button>
      <button class="btn sm ghost" data-cf="template" title="Volver al texto armado con los PRs">Restablecer</button></div>` : ''}`;
  const trans = `<select id="cf-transition"><option value="">No cambiar el estado</option>${f.transitions.map((t) => `<option value="${esc(t.id)}" ${t.id === f.transitionId ? 'selected' : ''}>${esc(t.name)} → ${esc(t.to)}</option>`).join('')}</select>`;
  return `${section(1, 'Revisar', review)}${section(2, 'Validación por impersonate', imp)}${section(3, 'Comentario', comment)}${section(4, 'Estado', trans)}
    ${d?.results && d.overall !== 'prod' ? '<p class="note">Ojo: la verificación no confirmó todos los PRs en prod (hay repos sin tags).</p>' : ''}
    <div class="acts end"><span class="note">${esc(blocked())}</span><button class="btn ghost" data-cf="cancel">Cancelar</button>
      <button class="btn primary" data-cf="review" ${blocked() ? 'disabled' : ''}>Revisar y confirmar</button></div>`;
};

const confirmView = () => {
  const t = transition();
  const steps = [
    f.impersonate.likely ? `<li>Validación por impersonate: <b>${f.impersonateAnswer === 'done' ? 'ya validada' : 'no hace falta'}</b></li>` : '',
    f.withComment ? `<li>Publicar en <b>${esc(f.key)}</b>${mentions().length ? `, notificando a ${mentions().map((p) => `<b>@${esc(p.name)}</b>`).join(', ')}` : ''}:<blockquote>${esc(f.comment)}</blockquote></li>` : '',
    t ? `<li>Mover <b>${esc(f.key)}</b> a <b>«${esc(t.to)}»</b> (transición «${esc(t.name)}»)</li>` : '',
  ].join('');
  const results = f.results ? `<div class="cf-results">${f.results.map((r) => `<div class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'} ${esc(r.label)}${r.error ? `: ${esc(r.error)}` : ''}</div>`).join('')}</div>` : '';
  return `<p class="note">Lo ve todo el equipo en Jira${mentions().length ? ' y las personas mencionadas reciben una notificación' : ''}.</p><ol class="cf-steps">${steps}</ol>${results}
    <div class="acts end">${f.finished ? '<button class="btn primary" data-cf="cancel">Cerrar</button>'
      : `<button class="btn ghost" data-cf="back" ${f.busy ? 'disabled' : ''}>Volver</button><button class="btn primary" data-cf="go" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Aplicando…' : 'Confirmar'}</button>`}</div>`;
};

const draw = () => {
  if (!f) { el.hidden = true; el.innerHTML = ''; return; }
  const body = f.loading ? '<p class="note">Leyendo la tarea en Jira…</p>' : f.error && !f.issue ? `<div class="banner err">${esc(f.error)}</div><div class="acts end"><button class="btn" data-cf="cancel">Cerrar</button></div>`
    : f.stage === 'confirm' ? confirmView() : editView();
  el.innerHTML = `<div class="cf-box" role="dialog" aria-label="Cerrar tarea"><h2>Cerrar ${esc(f.key)} · ya está en prod</h2>${body}</div>`;
  el.hidden = false;
};

const run = async () => {
  f.busy = true; f.results = []; draw();
  if (f.withComment) {
    try { await getJson('/api/jira/comment', { key: f.key, text: f.comment, mentions: mentions() }); f.results.push({ ok: true, label: 'Comentario publicado' }); }
    catch (e) { f.results.push({ ok: false, label: 'Comentario', error: e.message }); f.busy = false; draw(); return; }
  }
  const t = transition();
  if (t) {
    try { await getJson('/api/jira/transition', { key: f.key, id: t.id, name: t.name }); f.results.push({ ok: true, label: `Movida a «${t.to}»` }); }
    catch (e) { f.results.push({ ok: false, label: 'Cambio de estado', error: e.message }); f.busy = false; draw(); return; }
  }
  Object.assign(f, { busy: false, finished: true });
  draw();
  C.toast(`${f.key} cerrada`);
  C.refreshJira?.();
};

el.addEventListener('input', (e) => {
  if (!f) return;
  if (e.target.id === 'cf-comment') { f.comment = e.target.value; const b = el.querySelector('[data-cf="review"]'); if (b) b.disabled = Boolean(blocked()); }
});
el.addEventListener('change', (e) => {
  if (!f) return;
  const t = e.target;
  if (t.name === 'cf-imp') f.impersonateAnswer = t.value;
  else if (t.id === 'cf-with-comment') f.withComment = t.checked;
  else if (t.dataset.notify) f.notify[t.dataset.notify] = t.checked;
  else if (t.id === 'cf-transition') f.transitionId = t.value;
  else return;
  draw();
});
el.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cf]');
  if (e.target === el && !f?.busy) { f = null; draw(); return; }
  if (!b || !f) return;
  const act = b.dataset.cf;
  if (act === 'cancel') { f = null; draw(); }
  else if (act === 'review' && !blocked()) { f.stage = 'confirm'; draw(); }
  else if (act === 'back') { f.stage = 'edit'; f.results = null; draw(); }
  else if (act === 'go') run();
  else if (act === 'template') { f.comment = templateComment(f.key); draw(); }
  else if (act === 'draft') {
    f.drafting = true; draw();
    try { f.comment = (await getJson('/api/jira/draft-close', { key: f.key, notes: deployNotes(f.key) })).text; } catch (err) { C.toast(err.message); }
    f.drafting = false; draw();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && f && !f.busy) { e.stopImmediatePropagation(); f = null; draw(); } }, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="close-task"]');
  if (b) open(b.dataset.key);
});
