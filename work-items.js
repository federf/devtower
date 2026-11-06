import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
const text = (value, label, limit, required = false) => {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw fail(`${label}: completá un texto válido de hasta ${limit} caracteres.`);
  }
  return value.trim();
};
const list = (value, label, limit, normalize) => {
  if (!Array.isArray(value) || value.length > limit) throw fail(`${label}: máximo ${limit} elementos.`);
  return [...new Set(value.map(normalize))];
};
const link = (value) => {
  const raw = text(value, 'Enlace', 2000, true);
  let url;
  try { url = new URL(raw); } catch { throw fail('Enlace inválido. Usá una URL http o https.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw fail('Enlace inválido. Usá http o https sin credenciales.');
  }
  return url.href;
};
const fields = (body) => ({
  title: text(body.title, 'Título', 200, true),
  projects: list(body.projects, 'Proyectos', 20, (value) => text(value, 'Proyecto', 1000, true)),
  links: list(body.links, 'Enlaces', 30, link),
  notes: text(body.notes, 'Avance', 20000),
  nextStep: text(body.nextStep, 'Próximo paso', 2000),
});

export const createWorkItems = ({ file, resolveThread, now = Date.now }) => {
  let queue = Promise.resolve();
  const read = async () => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('Invalid state');
      const ids = new Set();
      for (const item of data.items) {
        if (!item || !validId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.revision)
          || item.revision < 1 || !Number.isFinite(Date.parse(item.createdAt))
          || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('Invalid item');
        fields(item);
        if (!Array.isArray(item.threads) || item.threads.length > 30
          || item.threads.some((thread) => !thread || !validId(thread.id)
            || ['title', 'cwd', 'project'].some((key) => typeof thread[key] !== 'string'))) {
          throw new Error('Invalid threads');
        }
        ids.add(item.id);
      }
      return data.items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw fail('No se pudieron leer los trabajos. No se sobrescribió el archivo local.', 500);
    }
  };
  const snapshot = async () => {
    await queue.catch(() => {});
    return (await read()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  };
  const save = (body, id = null) => {
    const operation = queue.catch(() => {}).then(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Trabajo inválido.');
      if (id !== null && !validId(id)) throw fail('Identificador de trabajo inválido.');
      const values = fields(body);
      const threadIds = list(body.threadIds, 'Hilos', 30, (value) => {
        if (!validId(value)) throw fail('Identificador de hilo inválido.');
        return value;
      });
      const items = await read();
      const previous = id === null ? null : items.find((item) => item.id === id);
      if (id !== null && !previous) throw fail('Trabajo no encontrado.', 404);
      if (previous && body.revision !== previous.revision) {
        throw fail('Este trabajo cambió en otra pestaña. Tu texto sigue en el formulario; copiá tus cambios y reabrí el trabajo actualizado.', 409);
      }
      const threads = [];
      for (const threadId of threadIds) {
        const old = previous?.threads.find((thread) => thread.id === threadId);
        if (old) { threads.push(old); continue; }
        const thread = await resolveThread(threadId);
        if (!thread) throw fail('Uno de los hilos ya no está disponible. Actualizá la lista.', 404);
        threads.push({ id: threadId, title: thread.title || threadId, cwd: thread.cwd || '', project: thread.project || '' });
      }
      const timestamp = new Date(now()).toISOString();
      const item = { ...values, threads, id: previous?.id || randomUUID(),
        revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || timestamp, updatedAt: timestamp };
      const next = previous ? items.map((entry) => entry.id === id ? item : entry) : [...items, item];
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, items: next }, null, 2), { mode: 0o600 });
        await fs.rename(temporary, file);
      } catch {
        throw fail('No se pudo guardar el trabajo. Tus cambios siguen en el formulario.', 500);
      }
      return item;
    });
    queue = operation;
    return operation;
  };
  return { snapshot, save };
};
