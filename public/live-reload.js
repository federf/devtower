import { hasPendingWork } from './reload-policy.js';

const source = new EventSource('/api/dev/events');
let version = null;
let pending = false;
let retry;
const notice = document.body.appendChild(Object.assign(document.createElement('div'), {
  id: 'live-reload-status', hidden: true,
}));
notice.setAttribute('role', 'status');
notice.innerHTML = '<span>Cambios listos. Recarga en espera: hay texto sin enviar o trabajo en curso.</span><button type="button">Recargar ahora</button>';

const reloadWhenSafe = () => {
  if (!pending) return;
  const state = window.cockpit?.state || {};
  const modalOpen = Boolean(document.querySelector('dialog[open]'))
    || Boolean(document.querySelector('#modal:not([hidden])'));
  if (hasPendingWork(state, { draft: document.querySelector('#input')?.value || '', modalOpen })) {
    notice.hidden = false;
    retry ??= setInterval(reloadWhenSafe, 1000);
    return;
  }
  pending = false;
  clearInterval(retry);
  source.close();
  window.location.reload();
};
const queueReload = () => { pending = true; reloadWhenSafe(); };
notice.querySelector('button').addEventListener('click', () => {
  if (window.confirm('Recargar puede descartar texto y adjuntos sin enviar o interrumpir una respuesta en pantalla. ¿Querés recargar igual?')) {
    source.close(); window.location.reload();
  }
});

source.addEventListener('hello', (event) => {
  const next = JSON.parse(event.data).version;
  if (version !== null && version !== next) queueReload();
  version = next;
});
source.addEventListener('change', (event) => {
  const data = JSON.parse(event.data);
  version = data.version;
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length && files.every((file) => file.endsWith('.css'))) {
    for (const file of files) {
      const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
        .filter((link) => new URL(link.href).pathname === `/${file}`);
      if (!links.length) { queueReload(); return; }
      for (const link of links) {
        const fresh = link.cloneNode();
        const url = new URL(link.href);
        url.searchParams.set('_live', data.version);
        fresh.href = url.href;
        fresh.onload = () => link.remove();
        fresh.onerror = () => { fresh.remove(); queueReload(); };
        link.after(fresh);
      }
    }
  } else queueReload();
});
window.addEventListener('pagehide', () => { source.close(); clearInterval(retry); });
