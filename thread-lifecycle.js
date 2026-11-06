import fs from 'node:fs/promises';
import path from 'node:path';

const fail = (message, status) => Object.assign(new Error(message), { status });
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);

export const createThreadLifecycle = ({ projectsDir, stateFile, isRunning = () => false, now = Date.now }) => {
  let queue = Promise.resolve();
  const busy = new Set();

  const snapshot = async () => {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.version !== 1 || !state.threads || typeof state.threads !== 'object'
        || Array.isArray(state.threads)
        || Object.values(state.threads).some((entry) => !entry || !['archived', 'deleted'].includes(entry.status))) {
        throw new Error('Invalid thread state');
      }
      return state.threads;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw fail('No se pudo leer el estado de los hilos. No se modificó ningún historial.', 500);
    }
  };

  const persist = async (threads) => {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, threads }, null, 2), { mode: 0o600 });
    await fs.rename(temporary, stateFile);
  };

  const transcript = async (id) => {
    if (!validId(id)) throw fail('Identificador de hilo inválido', 400);
    const dirs = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.includes('scratchpad')) continue;
      const file = path.join(projectsDir, dir.name, `${id}.jsonl`);
      const stat = await fs.lstat(file).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile()) throw fail('El historial no es un archivo regular', 400);
      const [root, resolved] = await Promise.all([fs.realpath(projectsDir), fs.realpath(file)]);
      if (path.dirname(path.dirname(resolved)) !== root) throw fail('Ruta de historial inválida', 400);
      return { file, stat };
    }
    throw fail('Hilo no encontrado', 404);
  };

  const assertRunnable = async (id) => {
    if (!validId(id)) throw fail('Identificador de hilo inválido', 400);
    if (busy.has(id)) throw fail('El hilo se está modificando. Intentá de nuevo.', 409);
    const states = await snapshot();
    if (busy.has(id)) throw fail('El hilo se está modificando. Intentá de nuevo.', 409);
    if (states[id]?.status === 'deleted') throw fail('El hilo fue eliminado', 404);
    if (states[id]?.status === 'archived') throw fail('Restaurá el hilo antes de continuarlo', 409);
  };

  const change = async (id, action, confirmed = false) => {
    if (!validId(id)) throw fail('Identificador de hilo inválido', 400);
    if (!['archive', 'restore', 'delete'].includes(action)) throw fail('Acción inválida', 400);
    if (action === 'delete' && confirmed !== true) throw fail('Confirmá el borrado del historial', 400);
    if (busy.has(id)) throw fail('El hilo se está modificando. Intentá de nuevo.', 409);
    busy.add(id);
    const operation = queue.catch(() => {}).then(async () => {
      const states = await snapshot();
      if (states[id]?.status === 'deleted') throw fail('El hilo fue eliminado', 404);
      const { file, stat } = await transcript(id);
      if (action !== 'restore' && (isRunning(id) || now() - stat.mtimeMs < 15_000)) {
        throw fail('El hilo está activo. Detenelo y esperá unos segundos antes de archivarlo o borrarlo.', 409);
      }
      const previous = { ...states };
      if (action === 'restore') delete states[id];
      else states[id] = { status: action === 'archive' ? 'archived' : 'deleted', at: new Date(now()).toISOString() };
      await persist(states);
      if (action === 'delete') {
        try {
          // Persist the tombstone first so a concurrent scan cannot resurrect the transcript.
          await fs.unlink(file);
        } catch (error) {
          await persist(previous);
          throw error;
        }
      }
      return { id, status: action === 'restore' ? 'active' : states[id].status, file };
    });
    queue = operation;
    try { return await operation; } finally { busy.delete(id); }
  };

  return { snapshot, change, assertRunnable };
};
