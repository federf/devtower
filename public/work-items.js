const C = window.cockpit;
const { state, api, esc, $ } = C;
state.workItems = [];
let loaded = false;
let loadError = '';
let generation = 0;
let editing = null;
let source = null;
let busy = false;
let dirty = false;
let returnFocus = null;

const dialog = document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'work-item-dialog' }));
dialog.setAttribute('aria-labelledby', 'wi-heading');
const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const unique = (values) => [...new Set(values)];
const request = async (url, body) => {
  const response = await api(url, body);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
};
const load = async () => {
  const current = ++generation;
  try {
    const data = await request('/api/work-items');
    if (current !== generation) return;
    state.workItems = data.items;
    loaded = true;
    loadError = '';
  } catch (error) { if (current === generation) loadError = error.message; }
  C.render();
};
C.loadWorkItems = load;

const threadButton = (thread) => `<button class="btn sm" data-act="work-open-thread" data-thread="${esc(thread.id)}"
  ${thread.status === 'deleted' ? 'disabled' : ''} title="Abrir historial sin enviar mensajes ni consumir IA">
  ✦ ${esc(thread.title)}${thread.status === 'archived' ? ' · archivado' : thread.status === 'deleted' ? ' · eliminado' : ''}</button>`;
const card = (item) => `<article class="work-item" data-work-id="${esc(item.id)}">
  <header><div><h2>${esc(item.title)}</h2><div class="m">${item.projects.map((project) => `<span class="tag" title="${esc(project)}">${esc(project.split('/').filter(Boolean).pop() || project)}</span>`).join(' ')}
  <span>Guardado · ${C.ago(item.updatedAt)}</span></div></div>
  <button class="btn sm" data-act="work-edit">Editar trabajo</button></header>
  <section class="work-next"><b>Próximo paso</b><p>${esc(item.nextStep || 'Definí una acción concreta para retomar sin reconstruir contexto.')}</p></section>
  ${item.notes ? `<section><h3>Dónde quedé</h3><p class="work-notes">${esc(item.notes)}</p></section>` : ''}
  <section><h3>Hilos vinculados · ${item.threads.length}</h3><div class="work-thread-links">${item.threads.map(threadButton).join('') || '<span class="note">Vinculá un hilo desde Editar o desde Hilos → ◇ Trabajo.</span>'}</div></section>
  ${item.links.length ? `<section><h3>Enlaces</h3><ul class="work-links">${item.links.map((url) => `<li><a class="lnk" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></li>`).join('')}</ul></section>` : ''}
</article>`;

C.renderers['work-items'] = () => {
  const query = state.q.toLocaleLowerCase();
  const items = state.workItems.filter((item) => [item.title, item.notes, item.nextStep,
    ...item.projects, ...item.links, ...item.threads.map((thread) => thread.title)].join(' ').toLocaleLowerCase().includes(query));
  return `<div class="work-toolbar"><div><strong>Tu punto de regreso</strong><p class="note">Trabajo, contexto y próximo paso. Guardado local · sin IA automática.</p></div>
    <button class="btn primary" data-act="work-new">＋ Nuevo trabajo</button></div>
    ${loadError ? `<p class="err" role="alert">${esc(loadError)} <button class="btn sm" data-act="work-reload">Reintentar</button></p>` : ''}
    ${!loaded ? '<div class="empty">Cargando trabajos…</div>' : items.length ? `<div class="work-list">${items.map(card).join('')}</div>`
      : `<div class="empty-state"><h3>${query ? 'Sin coincidencias' : 'Un lugar para cada trabajo'}</h3><p>${query ? 'Probá otro título, proyecto o próximo paso.' : 'Desde Hilos, elegí ◇ Trabajo para reunir conversaciones, enlaces y dónde quedaste. También podés empezar uno vacío.'}</p></div>`}`;
};

const threadOptions = (item) => [...new Map([
  ...(item?.threads || []), ...state.threads, ...state.archivedThreads, ...(source ? [source] : []),
].map((thread) => [thread.id, thread])).values()];
const fill = (item) => {
  editing = item || null;
  const selected = new Set([...(item?.threads.map((thread) => thread.id) || []), ...(source ? [source.id] : [])]);
  const projects = unique([...(item?.projects || []), ...(source?.cwd ? [source.cwd] : [])]);
  const imported = source ? [...(source.prs || []).map((pr) => pr.url).filter(Boolean),
    ...(source.tickets || []).map((key) => `${window.DEVTOWER?.jiraSite || ''}/browse/${encodeURIComponent(key)}`)] : [];
  $('#wi-title').value = item?.title || source?.title || '';
  $('#wi-projects').value = projects.join('\n');
  $('#wi-links').value = unique([...(item?.links || []), ...imported]).join('\n');
  $('#wi-notes').value = item?.notes || '';
  $('#wi-next').value = item?.nextStep || '';
  $('#wi-threads').innerHTML = threadOptions(item).map((thread) => `<label data-wi-thread-label>
    <input type="checkbox" name="threadIds" value="${esc(thread.id)}" ${selected.has(thread.id) ? 'checked' : ''}>
    <span>${esc(thread.title)}<small>${esc(thread.cwd || thread.project || 'Sin proyecto')}</small></span></label>`).join('') || '<p class="note">Sin hilos disponibles en el rango actual.</p>';
  $('#wi-thread-search').value = '';
  $('#wi-error').textContent = '';
  dirty = false;
};

const open = async (item = null, thread = null, trigger = null) => {
  if (dialog.open) return;
  if (!loaded) await load();
  if (!loaded) { C.toast(loadError || 'No se pudieron cargar los trabajos.'); return; }
  source = thread;
  returnFocus = trigger;
  const related = thread && state.workItems.find((entry) => entry.threads.some((ref) => ref.id === thread.id));
  const initial = item || related || null;
  dialog.innerHTML = `<form id="wi-form"><header><h2 id="wi-heading">${thread ? 'Organizar hilo en un trabajo' : initial ? 'Editar trabajo' : 'Nuevo trabajo'}</h2>
    <p class="note">Guardado en esta computadora. No llama a Claude ni modifica Jira, Slack o el historial.</p></header>
    ${thread ? `<label>Destino<select id="wi-destination"><option value="">Crear un trabajo nuevo</option>${state.workItems.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.title)}</option>`).join('')}</select></label>` : ''}
    <label>Título<input id="wi-title" required maxlength="200" autocomplete="off"></label>
    <label>Proyectos involucrados <small>Una ruta o nombre por línea</small><textarea id="wi-projects" rows="2"></textarea></label>
    <label>Próximo paso<textarea id="wi-next" rows="2" maxlength="2000" placeholder="Ej.: probar transición de Jira con un ticket de prueba"></textarea></label>
    <label>Dónde quedé<textarea id="wi-notes" rows="4" maxlength="20000" placeholder="Avance, decisiones y bloqueos para retomar"></textarea></label>
    <label>Enlaces <small>Tickets, PRs, Slack o documentación · una URL http/https por línea</small><textarea id="wi-links" rows="2"></textarea></label>
    <fieldset><legend>Hilos vinculados</legend><input id="wi-thread-search" type="search" placeholder="Filtrar hilos disponibles" aria-label="Filtrar hilos disponibles">
    <div id="wi-threads"></div><p class="note">Disponibles según el rango actual, más los ya vinculados. Desmarcar no borra historiales.</p></fieldset>
    <p id="wi-error" class="err" role="alert"></p><footer><button type="button" class="btn" data-act="work-cancel">Cancelar</button>
    <button type="submit" class="btn primary" id="wi-save">Guardar trabajo</button></footer></form>`;
  fill(initial);
  if (thread) $('#wi-destination').value = initial?.id || '';
  dialog.showModal();
  $('#wi-title').focus();
};
const close = () => {
  if (busy) return;
  if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
  dialog.close();
};
dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
dialog.addEventListener('close', () => { dirty = false; returnFocus?.isConnected && returnFocus.focus(); });
dialog.addEventListener('input', (event) => {
  if (event.target.id === 'wi-destination') return;
  if (event.target.id === 'wi-thread-search') {
    const query = event.target.value.toLocaleLowerCase();
    dialog.querySelectorAll('[data-wi-thread-label]').forEach((label) => { label.hidden = !label.textContent.toLocaleLowerCase().includes(query); });
  } else dirty = true;
});
dialog.addEventListener('change', (event) => {
  if (event.target.name === 'threadIds' && event.target.checked) {
    const thread = threadOptions(editing).find((entry) => entry.id === event.target.value);
    if (thread?.cwd) $('#wi-projects').value = unique([...lines($('#wi-projects').value), thread.cwd]).join('\n');
    dirty = true;
  }
  if (event.target.id !== 'wi-destination') return;
  const previous = editing?.id || '';
  if (dirty && !window.confirm('Cambiar de destino descarta las ediciones del formulario. ¿Continuar?')) {
    event.target.value = previous; return;
  }
  fill(state.workItems.find((item) => item.id === event.target.value));
});
dialog.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const body = { title: $('#wi-title').value, projects: lines($('#wi-projects').value),
    links: lines($('#wi-links').value), nextStep: $('#wi-next').value, notes: $('#wi-notes').value,
    threadIds: [...dialog.querySelectorAll('[name="threadIds"]:checked')].map((input) => input.value),
    ...(editing ? { revision: editing.revision } : {}) };
  busy = true;
  generation += 1;
  dialog.querySelectorAll('input,textarea,select,button').forEach((element) => { element.disabled = true; });
  $('#wi-error').textContent = '';
  try {
    const { item } = await request(`/api/work-items${editing ? `/${editing.id}` : ''}`, body);
    state.workItems = [item, ...state.workItems.filter((entry) => entry.id !== item.id)];
    dirty = false;
    dialog.close();
    state.q = ''; $('#search').value = '';
    C.setView('work-items');
    C.toast('Trabajo guardado · sin consumir IA');
    await load();
  } catch (error) { $('#wi-error').textContent = error.message; }
  finally {
    busy = false;
    dialog.querySelectorAll('input,textarea,select,button').forEach((element) => { element.disabled = false; });
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const item = state.workItems.find((entry) => entry.id === button.closest('[data-work-id]')?.dataset.workId);
  switch (button.dataset.act) {
    case 'work-new': return open(null, null, button);
    case 'work-edit': return open(item, null, button);
    case 'work-cancel': return close();
    case 'work-reload': return load();
    case 'work-from-thread': {
      const tab = C.activeTab();
      const thread = C.findThread(button.dataset.id) || (tab?.sessionId === button.dataset.id
        ? { id: tab.sessionId, title: tab.title, cwd: tab.cwd } : null);
      if (thread) return open(null, thread, button);
      C.toast('Actualizá Hilos para vincular esta conversación.');
      return;
    }
    case 'work-open-thread': {
      const thread = item?.threads.find((entry) => entry.id === button.dataset.thread);
      if (!thread) return;
      try {
        await request(`/api/threads/${encodeURIComponent(thread.id)}`);
        await C.openThread(thread.id, thread);
      } catch { C.toast('El historial ya no está disponible. La nota del trabajo se conserva.'); }
      return;
    }
    default: return;
  }
});
window.addEventListener('focus', load);
load();
