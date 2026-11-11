// 🔔 notification center: what needs your answer (Slack, Jira comments, PR reviews/CI,
// master, Claude threads that finished). Unread count also goes to the tab title.
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, api, esc, ago } = C;

state.notifications = { events: [], unread: 0 };
let open = false;
let tab = 'pending'; // 'pending' | 'seen'

const ICON = { slack: '#', jira: '☰', github: '⑂', master: '⛔', claude: '✦' };
const bell = document.createElement('button');
bell.id = 'bell';
bell.className = 'nav';
bell.title = 'Notificaciones: lo que espera tu respuesta';
document.querySelector('#rail [data-view="settings"]')?.before(bell);
const panel = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'notif-panel', hidden: true }));

const title = document.title;
const draw = () => {
  const n = state.notifications;
  bell.innerHTML = `<span>🔔</span>${n.unread ? `<i>${n.unread > 99 ? '99+' : n.unread}</i>` : ''}`;
  document.title = n.unread ? `(${n.unread}) ${title}` : title;
  if (!open) { panel.hidden = true; return; }
  panel.hidden = false;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const fallback = n.native === false;
  const list = n.events.filter((e) => (tab === 'pending') === !e.read);
  panel.innerHTML = `<header><div class="seg">
        <button data-nf-tab="pending" class="${tab === 'pending' ? 'on' : ''}">Pendientes <b>${n.unread || ''}</b></button>
        <button data-nf-tab="seen" class="${tab === 'seen' ? 'on' : ''}">Vistas</button></div><span class="spacer"></span>
      ${fallback && perm === 'default' ? '<button class="btn sm primary" data-nf="allow" title="Muestra avisos de Brave/Chrome mientras devtower está abierto">Activar avisos</button>' : ''}
      ${n.unread && tab === 'pending' ? '<button class="btn sm ghost" data-nf="read-all">Marcar todo visto</button>' : ''}</header>
    ${fallback ? '<div class="empty">Avisos de macOS apagados: activá <b>devtower</b> en Ajustes del Sistema → Notificaciones (o compilalo con <code>npm run notifier</code>). Mientras tanto avisa el navegador.</div>' : ''}
    <div class="nlist">${list.map((e) => `<div class="nrow"><button class="nitem ${e.read ? '' : 'unread'} ${e.urgent ? 'urgent' : ''}" data-id="${esc(e.id)}">
      <i>${ICON[e.source] || '•'}</i><span><b>${esc(e.label)}</b> · ${esc(e.title)}<small>${esc(e.body || '')}</small></span><em>${ago(e.at)}</em></button>
      ${e.read ? '' : `<button class="nread" data-nf-read="${esc(e.id)}" title="Marcar como vista sin abrir">✓</button>`}</div>`).join('')
      || `<div class="empty">${tab === 'pending' ? 'Nada pendiente. Te aviso cuando alguien te escriba, comente o haya algo para revisar.' : 'Todavía no hay notificaciones vistas.'}</div>`}</div>`;
};

// browser notifications: only a fallback while macOS ones are blocked or missing (avoids duplicates)
const canNotify = () => state.notifications.native === false && 'Notification' in window && Notification.permission === 'granted';
let known = null; // ids already seen by this tab
const go = (ev) => {
  markRead([ev.id]);
  if (ev.thread) C.openThread?.(ev.thread);
  else if (ev.url) window.open(ev.url, '_blank');
  if (ev.view) C.setView(ev.view);
};
const announce = (fresh) => {
  if (!canNotify() || !fresh.length) return;
  const show = (title, body, ev) => {
    const n = new Notification(title, { body, tag: ev?.id || 'devtower-burst', icon: '/devtower.svg' });
    n.onclick = () => { window.focus(); n.close(); if (ev) go(ev); else { open = true; draw(); } };
  };
  if (fresh.length > 3) show('devtower', `${fresh.length} novedades: ${[...new Set(fresh.map((e) => e.label))].join(', ')}`);
  else fresh.forEach((e) => show(`devtower · ${e.label}`, `${e.title}${e.body ? ` — ${e.body}` : ''}`, e));
};

const load = async () => {
  try {
    state.notifications = await (await api('/api/notifications')).json();
    const unread = state.notifications.events.filter((e) => !e.read);
    if (known) announce(unread.filter((e) => !known.has(e.id) && !e.quiet));
    known = new Set(state.notifications.events.map((e) => e.id));
  } catch { /* keep last */ }
  draw();
};
const markRead = async (ids) => {
  try { state.notifications = await (await api('/api/notifications/read', { ids })).json(); } catch { /* ignore */ }
  draw();
};

bell.addEventListener('click', (e) => { e.stopPropagation(); open = !open; draw(); });
panel.addEventListener('click', (e) => {
  e.stopPropagation();
  const tabBtn = e.target.closest('[data-nf-tab]');
  if (tabBtn) { tab = tabBtn.dataset.nfTab; draw(); return; }
  const readBtn = e.target.closest('[data-nf-read]');
  if (readBtn) { markRead([readBtn.dataset.nfRead]); return; }
  if (e.target.closest('[data-nf="read-all"]')) { markRead('all'); return; }
  if (e.target.closest('[data-nf="allow"]')) { Notification.requestPermission().then(() => { draw(); load(); }); return; }
  const item = e.target.closest('.nitem');
  if (!item) return;
  const ev = state.notifications.events.find((x) => x.id === item.dataset.id);
  if (!ev) return;
  open = false;
  draw();
  go(ev);
});
document.addEventListener('click', (e) => { if (open && !e.target.closest('#notif-panel')) { open = false; draw(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; draw(); } });

load();
setInterval(load, 30_000);
