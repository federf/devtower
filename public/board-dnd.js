// Drag a card to another column of the Jira board → apply the transition that leads there,
// like Jira does. Swimlanes are JQL queries, so (as in Jira) cards cannot be dropped across them.
// Inside the same column, dragging reorders the cards: a personal order kept in devtower, not Jira's rank.
// Relies on window.cockpit exposed by app.js; requires the Jira API token.
const C = window.cockpit;
const { state, api, esc } = C;

let drag = null; // { key, from }
const chooser = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'dnd-choose', hidden: true }));

const items = () => [...(state.jira.items || []), ...(state.jira.next?.items || [])];
const columns = () => state.jira.board?.columns || [];
const columnOf = (statusId) => columns().findIndex((c) => c.statuses.includes(String(statusId)));
const postJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

// optimistic move: the card jumps now and goes back if Jira refuses
const setStatus = (key, statusId, status) => items().filter((i) => i.key === key).forEach((i) => Object.assign(i, { statusId, status }));

const apply = async (key, t) => {
  const item = items().find((i) => i.key === key);
  const before = { statusId: item.statusId, status: item.status };
  setStatus(key, t.toId, t.to);
  C.render();
  try {
    await postJson('/api/jira/transition', { key, id: t.id, name: t.name });
    C.toast(`${key} → ${t.to}`);
    C.refreshJira?.();
  } catch (e) {
    setStatus(key, before.statusId, before.status);
    C.render();
    C.toast(`No se pudo mover ${key}: ${e.message}`);
  }
};

const drop = async (key, col) => {
  const column = columns()[col];
  const item = items().find((i) => i.key === key);
  if (!column || !item || columnOf(item.statusId) === col) return;
  if (state.jira.source !== 'api') { C.toast('Arrastrar requiere el token de Jira (Config)'); return; }
  let options;
  try { options = (await postJson('/api/jira/transitions', { key })).transitions.filter((t) => column.statuses.includes(t.toId)); }
  catch (e) { C.toast(e.message); return; }
  if (!options.length) { C.toast(`No hay transición de «${item.status}» a «${column.name}»`); return; }
  if (options.length === 1) { apply(key, options[0]); return; }
  chooser.innerHTML = `<div class="box"><h3>Mover ${esc(key)} a ${esc(column.name)}</h3>
    ${options.map((t, i) => `<button class="btn" data-i="${i}">${esc(t.to)}<small>${esc(t.name)}</small></button>`).join('')}
    <button class="btn ghost" data-i="-1">Cancelar</button></div>`;
  chooser.hidden = false;
  chooser.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b && e.target !== chooser) return;
    chooser.hidden = true;
    const i = Number(b?.dataset.i ?? -1);
    if (i >= 0) apply(key, options[i]);
  };
};

const clear = () => document.querySelectorAll('.kcol.drop, .kcard.dragging, .kcard.drop-before, .kcard.drop-after').forEach((n) => n.classList.remove('drop', 'dragging', 'drop-before', 'drop-after'));

// same column: the card under the pointer and whether the dragged one goes above or below it
const target = (e, col) => {
  const cards = [...col.querySelectorAll('.kcard[data-key]')].filter((c) => c.dataset.key !== drag.key);
  const after = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  return after ? { card: after, before: true } : cards.length ? { card: cards.at(-1), before: false } : null;
};
const reorder = (col, e) => {
  const keys = [...col.querySelectorAll('.kcard[data-key]')].map((c) => c.dataset.key).filter((k) => k !== drag.key);
  const t = target(e, col);
  const at = t ? keys.indexOf(t.card.dataset.key) + (t.before ? 0 : 1) : 0;
  keys.splice(at, 0, drag.key);
  state.taskOrder = [...keys, ...state.taskOrder.filter((k) => !keys.includes(k))].slice(0, 500);
  C.store.set('taskOrder', state.taskOrder);
  C.render();
};

document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.kcard[data-key]');
  if (!card) return;
  drag = { key: card.dataset.key, from: Number(card.closest('.kcol')?.dataset.col) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.key);
  card.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  const col = drag && e.target.closest?.('.kcol[data-col]');
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (Number(col.dataset.col) === drag.from) {
    const t = target(e, col);
    document.querySelectorAll('.kcard.drop-before, .kcard.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    t?.card.classList.add(t.before ? 'drop-before' : 'drop-after');
    return;
  }
  if (!col.classList.contains('drop')) { clear(); col.classList.add('drop'); document.querySelector(`.kcard[data-key="${CSS.escape(drag.key)}"]`)?.classList.add('dragging'); }
});
document.addEventListener('drop', (e) => {
  const col = drag && e.target.closest?.('.kcol[data-col]');
  if (!col) return;
  e.preventDefault();
  if (Number(col.dataset.col) === drag.from) { reorder(col, e); drag = null; clear(); return; }
  const { key } = drag;
  drag = null;
  clear();
  drop(key, Number(col.dataset.col));
});
document.addEventListener('dragend', () => { drag = null; clear(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !chooser.hidden) chooser.hidden = true; });
