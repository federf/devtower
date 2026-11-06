import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import path from 'node:path';

export const createLiveReload = ({ directory, enabled = true, debounceMs = 150 }) => {
  const clients = new Set();
  const changed = new Set();
  const boot = randomUUID();
  let revision = 0;
  let timer;
  let watcher;
  let heartbeat;
  const version = () => `${boot}:${revision}`;
  const send = (res, event, data) => {
    if (res.destroyed || res.writableEnded) { clients.delete(res); return; }
    res.write(`id: ${version()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const close = () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    watcher?.close();
    watcher = null;
    for (const res of clients) res.end();
    clients.clear();
  };
  if (enabled) {
    try {
      // Frontend assets currently share one directory. Do not watch histories or backend files.
      watcher = watch(directory, (_event, name) => {
        const file = name ? String(name) : '*';
        if (file !== '*' && (path.basename(file).startsWith('.')
          || !/\.(?:html|js|css|svg|png|jpe?g|webp|woff2?)$/i.test(file))) return;
        changed.add(file);
        clearTimeout(timer);
        timer = setTimeout(() => {
          revision += 1;
          const data = { version: version(), files: [...changed] };
          changed.clear();
          for (const res of clients) send(res, 'change', data);
        }, debounceMs);
      });
      watcher.on('error', close);
      watcher.unref();
      heartbeat = setInterval(() => {
        for (const res of clients) if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
      }, 15_000);
      heartbeat.unref();
    } catch {
      watcher = null;
    }
  }
  return {
    connect(_req, res) {
      if (!watcher) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' });
      clients.add(res);
      res.on('close', () => clients.delete(res));
      send(res, 'hello', { version: version() });
    },
    close,
  };
};
