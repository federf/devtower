import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createThreadLifecycle } from './thread-lifecycle.js';
import { describeClaudeFailure, parseClaudeResponse } from './claude-errors.js';
import { createLiveReload } from './live-reload.js';
import { createWorkItems } from './work-items.js';
import { createIntegrations } from './integrations.js';
import { CONFIG_DIR, loadConfig, publicConfig } from './config.js';
import { createSettings } from './settings.js';
import { createClockify } from './clockify.js';
import { createNotifier } from './notify.js';
import { readSecret } from './secrets.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CONFIG = loadConfig();
const REPOS_DIR = CONFIG.reposDir;
const ORG = CONFIG.github.org;
const DATA_DIR = path.join(ROOT, 'data');
const GH = process.env.GH_BIN || 'gh';
const liveReload = createLiveReload({ directory: path.join(ROOT, 'public'), enabled: process.env.LIVE_RELOAD !== '0' });
const MAX_THREADS = 1500;
const DAY_MS = 86_400_000;
const REFRESH_MS = 5 * 60_000;
// DEVTOWER_KEYCHAIN=0 disables direct APIs (tests): Slack/Jira fall back to Claude
const clockify = createClockify({ readSecret: process.env.DEVTOWER_KEYCHAIN === '0' ? async () => null : readSecret, ticketPattern: CONFIG.jira.ticketPattern });
const notifier = createNotifier({ readJson: (...a) => readJsonFile(...a), writeJson: (...a) => writeJsonFile(...a), prefs: () => CONFIG.notify,
  appUrl: `http://localhost:${PORT}` });
const settings = createSettings({ loadConfig, forget: () => { direct.forget(); clockify.forget(); }, gh: process.env.GH_BIN || 'gh' });
// config changes need a fresh process: under launchd (autostart) a non-zero exit is relaunched
const UNDER_LAUNCHD = String(process.env.XPC_SERVICE_NAME || '').startsWith('local.devtower');
const restartSoon = () => { if (UNDER_LAUNCHD) setTimeout(() => process.exit(75), 300); return UNDER_LAUNCHD ? 'auto' : 'manual'; };
const direct = createIntegrations({ jiraSite: CONFIG.jira.site, jiraEmail: CONFIG.jira.email,
  ...(process.env.DEVTOWER_KEYCHAIN === '0' ? { readSecret: async () => null } : {}) });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

const readBody = (req, limit = 2_000_000) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ''}`;
  return env;
};

const readJsonFile = async (name, fallback) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJsonFile = async (name, data) => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  // tmp + rename: a concurrent read never sees a truncated file
  const tmp = path.join(DATA_DIR, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, path.join(DATA_DIR, name));
};

// ---------------------------------------------------------------- threads

const META_VERSION = 2;
const metaCache = new Map();
const hayCache = new Map();
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
try {
  const saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  for (const [p, e] of Object.entries(saved)) {
    metaCache.set(p, e.meta);
    hayCache.set(e.meta.id, e.hay);
  }
} catch {
  /* first run */
}
let indexDirty = false;
let indexWrite = Promise.resolve();
const saveIndex = () => {
  indexWrite = indexWrite.catch(() => {}).then(async () => {
    if (!indexDirty) return;
    indexDirty = false;
    const out = {};
    for (const [p, meta] of metaCache) out[p] = { meta, hay: hayCache.get(meta.id) };
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(`${INDEX_FILE}.tmp`, JSON.stringify(out));
      await fsp.rename(`${INDEX_FILE}.tmp`, INDEX_FILE);
    } catch (error) {
      indexDirty = true;
      throw error;
    }
  });
  return indexWrite;
};
const mapPool = async (items, size, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
      await new Promise((r) => setImmediate(r));
    }
  }));
  return out;
};
const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const TICKET_RE = new RegExp(`\\b(?:${CONFIG.jira.ticketPattern})\\b`, 'g');
const idToFile = new Map();
const running = new Map();
const threadLifecycle = createThreadLifecycle({
  projectsDir: PROJECTS_DIR,
  stateFile: path.join(DATA_DIR, 'thread-state.json'),
  isRunning: (id) => running.has(id),
});

const humanText = (content) => {
  const parts = typeof content === 'string' ? [content] : (content || []).filter((c) => c.type === 'text').map((c) => c.text);
  const text = parts
    .join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
  if (text === '' || /^<(command-|local-command|bash-|task-notification)/.test(text)) return '';
  return text;
};

const BIG_LINE = 30_000;
const parseLines = async (file, { skipBig = false } = {}) => {
  const raw = await fsp.readFile(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    if (skipBig && line.length > BIG_LINE && line.includes('"tool_result"')) {
      const id = line.match(/"tool_use_id":"([\w-]+)"/)?.[1];
      out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: line.slice(0, 4000) }] } });
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line while the session is being written */
    }
  }
  return out;
};

const buildMeta = async (file, id, mtimeMs) => {
  const lines = await parseLines(file, { skipBig: true });
  let title = '';
  let firstPrompt = '';
  let cwd = '';
  let branch = '';
  let prompts = 0;
  let lastText = '';
  let lastTs = '';
  const hay = [];
  const branches = new Set();
  const files = new Set();
  const prs = new Map();
  const prCreateIds = new Set();
  let commits = 0;
  let pushes = 0;
  const notePr = (repo, number, created) => {
    const key = `${repo}#${number}`;
    const cur = prs.get(key) || { key, repo, number: Number(number), mentions: 0, created: false };
    cur.mentions += 1;
    cur.created = cur.created || created;
    prs.set(key, cur);
  };
  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type === 'custom-title' && l.customTitle) title = l.customTitle;
    if (l.cwd && cwd === '') cwd = l.cwd;
    if (l.gitBranch) {
      branch = l.gitBranch;
      if (branch !== 'HEAD') branches.add(branch);
    }
    if (l.timestamp) lastTs = l.timestamp;
    if (l.type === 'user' && !l.isMeta) {
      const t = humanText(l.message?.content);
      if (t !== '') {
        prompts += 1;
        hay.push(t);
        if (firstPrompt === '') firstPrompt = t;
      }
      for (const c of Array.isArray(l.message?.content) ? l.message.content : []) {
        if (c.type !== 'tool_result') continue;
        const created = prCreateIds.has(c.tool_use_id);
        for (const m of JSON.stringify(c.content).matchAll(PR_URL_RE)) notePr(m[1], m[2], created);
      }
    }
    if (l.type === 'assistant') {
      const parts = l.message?.content || [];
      const t = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t !== '') {
        lastText = t;
        hay.push(t);
        for (const m of t.matchAll(PR_URL_RE)) notePr(m[1], m[2], false);
      }
      for (const c of parts.filter((p) => p.type === 'tool_use')) {
        const cmd = String(c.input?.command || '');
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && c.input?.file_path) files.add(c.input.file_path);
        if (c.name === 'Bash' && /\bgh\s+pr\s+create\b/.test(cmd)) prCreateIds.add(c.id);
        if (c.name === 'Bash' && /\bgit\s+commit\b/.test(cmd)) commits += 1;
        if (c.name === 'Bash' && /\bgit\s+push\b/.test(cmd)) pushes += 1;
      }
    }
  }
  const text = hay.join('\n');
  const tickets = [...new Set([title, firstPrompt, ...branches, text.slice(0, 20000)].join(' ').match(TICKET_RE) || [])].slice(0, 8);
  const meta = {
    v: META_VERSION,
    scheduled: /^<scheduled-task/.test(firstPrompt),
    scheduledName: firstPrompt.match(/^<scheduled-task name="([^"]+)"/)?.[1] || '',
    id,
    title: title || firstPrompt.split('\n')[0].slice(0, 90) || '(sin título)',
    cwd,
    project: cwd ? path.basename(cwd) : '',
    branch,
    prompts,
    lastText: lastText.slice(0, 220),
    updatedAt: lastTs || new Date(mtimeMs).toISOString(),
    mtimeMs,
    tickets,
    branches: [...branches].slice(-6),
    prs: [...prs.values()].sort((a, b) => Number(b.created) - Number(a.created) || b.mentions - a.mentions).slice(0, 10),
    files: [...files].map((f) => f.replace(`${cwd}/`, '')).slice(-40),
    filesCount: files.size,
    commits,
    pushes,
  };
  hayCache.set(id, {
    head: `${meta.title}\n${tickets.join(' ')} ${meta.branches.join(' ')} ${meta.prs.map((p) => p.key).join(' ')}\n${[...files].join(' ')}`,
    body: text.slice(0, 120_000),
  });
  return meta;
};

const snippet = (text, terms) => {
  const lower = text.toLowerCase();
  const i = Math.min(...terms.map((t) => lower.indexOf(t)).filter((x) => x >= 0));
  if (!Number.isFinite(i)) return '';
  return `${i > 60 ? '…' : ''}${text.slice(Math.max(0, i - 60), i + 140).replace(/\s+/g, ' ')}…`;
};

const searchThreads = async (q, days = 365, visibility = 'active') => {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const threads = await scanThreads(days, visibility);
  return threads
    .map((t) => {
      const entry = hayCache.get(t.id) || { head: '', body: '' };
      const hay = `${entry.head}\n${entry.body}`;
      const lower = hay.toLowerCase();
      if (!terms.every((x) => lower.includes(x))) return null;
      const titleHit = terms.every((x) => t.title.toLowerCase().includes(x));
      return { id: t.id, thread: t, score: (titleHit ? 100 : 0) + terms.reduce((n, x) => n + lower.split(x).length - 1, 0), snippet: snippet(entry.body, terms) || snippet(entry.head, terms) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
};

const scanThreads = async (days = 14, visibility = 'active') => {
  const states = await threadLifecycle.snapshot();
  const dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.includes('scratchpad')) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st) files.push({ p, id: f.slice(0, -6), mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  files.forEach((f) => idToFile.set(f.id, f.p));
  const cutoff = days > 0 ? Date.now() - days * DAY_MS : 0;
  const metas = await mapPool(
    files.filter((f) => f.mtimeMs >= cutoff && states[f.id]?.status !== 'deleted'
      && (visibility === 'all' || (states[f.id]?.status === 'archived') === (visibility === 'archived')))
      .slice(0, MAX_THREADS),
    4,
    async (f) => {
      const cached = metaCache.get(f.p);
      if (cached && cached.v === META_VERSION && cached.mtimeMs === f.mtimeMs) return cached;
      const meta = await buildMeta(f.p, f.id, f.mtimeMs).catch(() => null);
      if (meta) {
        metaCache.set(f.p, meta);
        indexDirty = true;
      }
      return meta;
    },
  );
  const current = await threadLifecycle.snapshot();
  for (const [file, meta] of metaCache) {
    if (current[meta.id]?.status !== 'deleted') continue;
    metaCache.delete(file);
    hayCache.delete(meta.id);
    idToFile.delete(meta.id);
    indexDirty = true;
  }
  saveIndex().catch(() => {});
  const now = Date.now();
  return metas
    .filter((m) => m && m.prompts > 0 && current[m.id]?.status !== 'deleted'
      && (visibility === 'all' || (current[m.id]?.status === 'archived') === (visibility === 'archived')))
    .map((m) => ({ ...m, archived: current[m.id]?.status === 'archived',
      running: running.has(m.id) || now - m.mtimeMs < 15_000 }));
};

const clip = (v, n) => {
  const str = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
};
const slimInput = (input = {}) =>
  Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 4000) : JSON.stringify(v ?? '').length < 6000 ? v : '[omitido]']),
  );
const toolBlock = (c) => {
  const input = c.input || {};
  const detail = input.command || input.file_path || input.pattern || input.description || input.query || input.url || input.prompt || '';
  return {
    type: 'tool',
    id: c.id,
    name: c.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''),
    rawName: c.name,
    detail: String(detail).slice(0, 140),
    input: slimInput(input),
  };
};
const resultText = (content) =>
  clip(typeof content === 'string' ? content : (content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'), 3000);

const loadTranscript = async (id) => {
  if ((await threadLifecycle.snapshot())[id]?.status === 'deleted') return null;
  let file = idToFile.get(id);
  if (!file) {
    await scanThreads(1);
    file = idToFile.get(id);
  }
  if (!file) return null;
  const lines = await parseLines(file);
  const messages = [];
  const toolById = new Map();
  let cur = null;
  const flush = () => {
    if (cur && cur.blocks.length > 0) messages.push(cur);
    cur = null;
  };
  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type === 'user' && !l.isMeta) {
      for (const c of Array.isArray(l.message?.content) ? l.message.content : []) {
        const blk = c.type === 'tool_result' ? toolById.get(c.tool_use_id) : null;
        if (blk) Object.assign(blk, { result: resultText(c.content), error: Boolean(c.is_error) });
      }
      const t = humanText(l.message?.content);
      if (t === '') continue;
      flush();
      messages.push({ role: 'user', blocks: [{ type: 'text', text: t }], ts: l.timestamp });
    } else if (l.type === 'assistant') {
      cur = cur || { role: 'assistant', blocks: [], ts: l.timestamp };
      for (const c of l.message?.content || []) {
        if (c.type === 'text' && c.text.trim() !== '') cur.blocks.push({ type: 'text', text: c.text });
        if (c.type === 'tool_use') {
          const blk = toolBlock(c);
          toolById.set(c.id, blk);
          cur.blocks.push(blk);
        }
      }
    }
  }
  flush();
  return messages.slice(-80);
};

const renameThread = async (id, title) => {
  await threadLifecycle.assertRunnable(id);
  if (!idToFile.has(id)) await scanThreads(1);
  const file = idToFile.get(id);
  if (!file) throw new Error('hilo no encontrado');
  await fsp.appendFile(file, `${JSON.stringify({ type: 'custom-title', customTitle: String(title).slice(0, 120), sessionId: id })}\n`);
};

// ----------------------------------------------------------- commands / files

const BUILTIN_COMMANDS = [
  ['compact', 'Compactar el contexto del hilo'],
  ['context', 'Ver el uso de contexto'],
  ['cost', 'Ver costo de la sesión'],
  ['init', 'Generar CLAUDE.md'],
  ['review', 'Revisar un PR'],
  ['security-review', 'Revisión de seguridad de los cambios'],
];

const readFrontmatter = async (file) => {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  for (const line of m ? m[1].split('\n') : []) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
};

const scanCommands = async (cwd) => {
  const out = new Map();
  const add = (name, description, source) => {
    if (!out.has(name)) out.set(name, { name, description: description.slice(0, 140), source });
  };
  const roots = [[path.join(cwd, '.claude'), 'proyecto'], [path.join(cwd, '.agents'), 'proyecto'], [path.join(HOME, '.claude'), 'usuario']];
  for (const [root, source] of roots) {
    for (const d of await fsp.readdir(path.join(root, 'skills'), { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const fm = await readFrontmatter(path.join(root, 'skills', d.name, 'SKILL.md'));
      add(/^[\w:.-]+$/.test(fm.name || '') ? fm.name : d.name, fm.description || '', source);
    }
    for (const f of await fsp.readdir(path.join(root, 'commands')).catch(() => [])) {
      if (!f.endsWith('.md')) continue;
      const fm = await readFrontmatter(path.join(root, 'commands', f));
      add(f.slice(0, -3), fm.description || '', source);
    }
  }
  const init = await readJsonFile('init.json', {});
  for (const n of init.slashCommands || []) add(n, '', 'sesión');
  for (const [n, d] of BUILTIN_COMMANDS) add(n, d, 'built-in');
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const fileCache = new Map();
const listFiles = (cwd) =>
  new Promise((resolve) => {
    const hit = fileCache.get(cwd);
    if (hit && Date.now() - hit.at < 30_000) return resolve(hit.files);
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      const files = err ? [] : stdout.split('\n').filter(Boolean);
      fileCache.set(cwd, { at: Date.now(), files });
      resolve(files);
    });
  });

const searchFiles = async (cwd, q) => {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const files = await listFiles(cwd);
  return files
    .filter((f) => terms.every((t) => f.toLowerCase().includes(t)))
    .sort((a, b) => a.length - b.length)
    .slice(0, 20);
};

// rama actual + cambios sin commitear + ahead/behind, desde `git status -b`
const gitBranch = (cwd) =>
  new Promise((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '-b'], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const [head, ...rest] = stdout.split('\n');
      const m = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/) || [];
      const track = m[3] || '';
      resolve({
        branch: m[1]?.startsWith('HEAD (') ? 'HEAD desacoplado' : m[1] || '?',
        upstream: m[2] || '',
        ahead: Number(track.match(/ahead (\d+)/)?.[1] || 0),
        behind: Number(track.match(/behind (\d+)/)?.[1] || 0),
        changes: rest.filter(Boolean).length,
      });
    });
  });

// git clones directly under reposDir: offered as places to start a thread even before using them
const listRepos = async () => {
  if (!REPOS_DIR) return [];
  const entries = await fsp.readdir(REPOS_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(REPOS_DIR, e.name, '.git')))
    .map((e) => path.join(REPOS_DIR, e.name));
};

const resolveCwd = (cwd) => {
  const resolved = path.resolve(cwd || HOME);
  if (!resolved.startsWith(HOME) || !fs.existsSync(resolved)) throw new Error(`cwd inválido: ${cwd}`);
  return resolved;
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const strList = (v) => (Array.isArray(v) ? v.map(String).filter((x) => x.trim() !== '') : []);

const buildRunArgs = (body, mode) => {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode];
  if (body.sessionId) {
    args.push('--resume', String(body.sessionId));
    if (body.fork) args.push('--fork-session');
  }
  if (typeof body.model === 'string' && body.model !== '') args.push('--model', body.model);
  if (EFFORTS.includes(body.effort)) args.push('--effort', body.effort);
  if (typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim() !== '') args.push('--append-system-prompt', body.appendSystemPrompt);
  if (Number(body.maxBudget) > 0) args.push('--max-budget-usd', String(Number(body.maxBudget)));
  const dirs = strList(body.addDirs).map(resolveCwd);
  if (dirs.length) args.push('--add-dir', ...dirs);
  if (strList(body.allowedTools).length) args.push('--allowedTools', ...strList(body.allowedTools));
  if (strList(body.disallowedTools).length) args.push('--disallowedTools', ...strList(body.disallowedTools));
  return args;
};

const handleRun = async (req, res) => {
  const body = await readBody(req, 30_000_000);
  const prompt = String(body.prompt || '').trim();
  const images = (Array.isArray(body.images) ? body.images : []).filter((i) => IMAGE_TYPES.includes(i.mediaType) && typeof i.data === 'string').slice(0, 6);
  if (prompt === '' && images.length === 0) return json(res, { error: 'prompt vacío' }, 400);
  const cwd = resolveCwd(body.cwd);
  const mode = ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(body.permissionMode) ? body.permissionMode : 'acceptEdits';
  if (body.sessionId) await threadLifecycle.assertRunnable(body.sessionId);
  const args = buildRunArgs(body, mode);

  const runId = `run_${Date.now()}`;
  let sessionId = body.sessionId && !body.fork ? body.sessionId : null;
  const child = spawn('claude', args, { cwd, env: cleanEnv() });
  running.set(sessionId || runId, { child, cwd, startedAt: Date.now() });

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const emit = (obj) => res.writable && res.write(`${JSON.stringify(obj)}\n`);
  emit({ t: 'start', key: sessionId || runId });

  let reportedFailure = false;
  const onEvent = (ev) => {
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      if (!sessionId) {
        running.set(ev.session_id, running.get(runId));
        running.delete(runId);
      }
      sessionId = ev.session_id;
      const info = { model: ev.model, tools: (ev.tools || []).length, mcp: ev.mcp_servers || [], skills: ev.skills || [], slashCommands: ev.slash_commands || [], agents: ev.agents || [], permissionMode: ev.permissionMode };
      writeJsonFile('init.json', { slashCommands: info.slashCommands }).catch(() => {});
      return emit({ t: 'init', sessionId, ...info });
    }
    if (ev.parent_tool_use_id) return null;
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
      const d = ev.event.delta;
      if (d.type === 'text_delta') emit({ t: 'delta', kind: 'text', text: d.text });
      if (d.type === 'thinking_delta') emit({ t: 'delta', kind: 'thinking', text: d.thinking });
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text') emit({ t: 'text', text: c.text });
        if (c.type === 'thinking' && c.thinking) emit({ t: 'thinking', text: c.thinking });
        if (c.type === 'tool_use') emit({ t: 'tool', ...toolBlock(c) });
      }
    } else if (ev.type === 'user') {
      for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (c.type === 'tool_result') emit({ t: 'tool_result', id: c.tool_use_id, text: resultText(c.content), error: Boolean(c.is_error) });
      }
    } else if (ev.type === 'result') {
      if (ev.is_error || ev.api_error_status >= 400) {
        const error = describeClaudeFailure(ev);
        reportedFailure = true;
        return emit({ t: 'error', message: error.message, code: error.code, resetAt: error.resetAt });
      }
      emit({
        t: 'result',
        cost: ev.total_cost_usd,
        ms: ev.duration_ms,
        turns: ev.num_turns,
        usage: ev.usage ? { input: ev.usage.input_tokens, output: ev.usage.output_tokens, cacheRead: ev.usage.cache_read_input_tokens } : null,
        isError: Boolean(ev.is_error),
        denials: (ev.permission_denials || []).map((d) => ({ tool: d.tool_name, input: slimInput(d.tool_input) })),
      });
    }
    return null;
  };

  let buf = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    }
  });
  child.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-2000);
  });
  child.on('close', (code) => {
    running.delete(sessionId || runId);
    if (code !== 0 && !reportedFailure) {
      const error = describeClaudeFailure(stderr);
      emit({ t: 'error', message: error.message, code: error.code, resetAt: error.resetAt });
    }
    emit({ t: 'done' });
    res.end();
  });
  const content = [
    ...(prompt === '' ? [] : [{ type: 'text', text: prompt }]),
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
  ];
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
};

const handleStop = async (req, res) => {
  const { key } = await readBody(req);
  const run = running.get(key);
  if (run) run.child.kill('SIGTERM');
  json(res, { ok: Boolean(run) });
};

// -------------------------------------------------------------------- PRs

const CHECKS = `contexts(first: 60) { nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl completedAt }
  ... on StatusContext { context state targetUrl description createdAt } } }`;

// GitHub Actions check runs + Jenkins status contexts → one list; reruns collapse by name
const CHECK_STATE = { SUCCESS: 'ok', NEUTRAL: 'ok', SKIPPED: 'skip', FAILURE: 'fail', ERROR: 'fail', TIMED_OUT: 'fail',
  CANCELLED: 'fail', ACTION_REQUIRED: 'fail', STARTUP_FAILURE: 'fail', STALE: 'skip', PENDING: 'run', EXPECTED: 'run' };
const normalizeChecks = (rollup) => {
  const byName = new Map();
  for (const c of rollup?.contexts?.nodes || []) {
    const name = c.name || c.context || '';
    const state = c.__typename === 'CheckRun' ? (c.status === 'COMPLETED' ? CHECK_STATE[c.conclusion] || 'ok' : 'run') : CHECK_STATE[c.state] || 'run';
    const check = { name, state, url: c.detailsUrl || c.targetUrl || '', desc: c.description || '' };
    const prev = byName.get(name);
    if (!prev || prev.state === 'skip' || state !== 'skip') byName.set(name, check);
  }
  const checks = [...byName.values()].sort((a, b) => ['fail', 'run', 'ok', 'skip'].indexOf(a.state) - ['fail', 'run', 'ok', 'skip'].indexOf(b.state));
  const count = (st) => checks.filter((c) => c.state === st).length;
  return { checks, summary: { ok: count('ok'), fail: count('fail'), run: count('run'), skip: count('skip') } };
};

const PR_FIELDS = `
  number title url isDraft updatedAt createdAt headRefName baseRefName additions deletions changedFiles
  mergeable reviewDecision
  author { login }
  repository { nameWithOwner name }
  labels(first: 6) { nodes { name } }
  reviewRequests(first: 8) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  latestReviews(first: 10) { nodes { state submittedAt author { login } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECKS} } } } }
`;

const ghExec = (args) =>
  new Promise((resolve, reject) => {
    execFile(GH, args, { maxBuffer: 20 * 1024 * 1024, env: cleanEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });

let prCache = { at: 0, data: null };

const normalizePr = (n, login) => {
  const reviews = n.latestReviews.nodes.map((r) => ({ login: r.author?.login, state: r.state, at: r.submittedAt }));
  const mine = reviews.find((r) => r.login === login);
  const unresolved = n.reviewThreads.nodes.filter((t) => !t.isResolved).length;
  const rollup = n.commits.nodes[0]?.commit.statusCheckRollup;
  const ci = rollup?.state || null;
  const { checks, summary: checkSummary } = normalizeChecks(rollup);
  const localDir = path.join(REPOS_DIR, n.repository.name);
  const flags = [];
  if (n.reviewDecision === 'CHANGES_REQUESTED') flags.push('changes');
  if (ci === 'FAILURE' || ci === 'ERROR') flags.push('ci');
  if (n.mergeable === 'CONFLICTING') flags.push('conflict');
  if (unresolved > 0) flags.push('unresolved');
  return {
    key: `${n.repository.nameWithOwner}#${n.number}`,
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    repoName: n.repository.name,
    localDir: fs.existsSync(localDir) ? localDir : null,
    isDraft: n.isDraft,
    author: n.author?.login,
    branch: n.headRefName,
    base: n.baseRefName,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    additions: n.additions,
    deletions: n.deletions,
    files: n.changedFiles,
    reviewDecision: n.reviewDecision,
    mergeable: n.mergeable,
    ci,
    checks,
    checkSummary,
    unresolved,
    labels: n.labels.nodes.map((l) => l.name),
    reviews,
    requested: n.reviewRequests.nodes.map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean),
    myReview: mine?.state || null,
    updatedSinceMyReview: mine ? Date.parse(n.updatedAt) - Date.parse(mine.at) > 120_000 : false,
    flags,
  };
};

const loadPrs = async (force) => {
  if (!force && prCache.data && Date.now() - prCache.at < 60_000) return prCache.data;
  const login = (await ghExec(['api', 'user', '--jq', '.login'])).trim();
  const query = `
    query {
      viewer { pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...F } } }
      toReview: search(query: "is:pr is:open review-requested:${login} archived:false", type: ISSUE, first: 50) { nodes { ...F } }
      reviewed: search(query: "is:pr is:open reviewed-by:${login} -author:${login} archived:false", type: ISSUE, first: 30) { nodes { ...F } }
    }
    fragment F on PullRequest { ${PR_FIELDS} }`;
  const raw = JSON.parse(await ghExec(['api', 'graphql', '-f', `query=${query}`]));
  const d = raw.data;
  const norm = (nodes) => nodes.filter((n) => n && n.number).map((n) => normalizePr(n, login));
  const toReview = norm(d.toReview.nodes);
  const reviewed = norm(d.reviewed.nodes).filter((p) => !toReview.some((r) => r.key === p.key));
  prCache = { at: Date.now(), data: { login, fetchedAt: new Date().toISOString(), mine: norm(d.viewer.pullRequests.nodes), toReview, reviewed } };
  notifier.prs(prCache.data);
  return prCache.data;
};

// ------------------------------------------------------------------ Health: master + PR metrics

const CORE_REPOS = ORG ? CONFIG.github.coreRepos : [];
let healthCache = { at: 0, data: null };
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const hoursBetween = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : NaN);

const loadHealth = async (force) => {
  if (!force && healthCache.data && Date.now() - healthCache.at < 4 * 60_000) return healthCache.data;
  const login = (await ghExec(['api', 'user', '--jq', '.login'])).trim();
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const repos = CORE_REPOS.map((name, i) => `r${i}: repository(owner: "${ORG}", name: "${name}") { nameWithOwner url
    defaultBranchRef { name target { ... on Commit { history(first: 10) { nodes {
      abbreviatedOid messageHeadline committedDate url author { name user { login } }
      statusCheckRollup { state ${CHECKS} } } } } } } }`).join('\n');
  const query = `query {
    ${repos}
    merged: search(query: "is:pr author:${login} is:merged merged:>=${since}", type: ISSUE, first: 100) { issueCount nodes { ... on PullRequest {
      createdAt mergedAt additions deletions repository { nameWithOwner }
      reviews(first: 10) { nodes { submittedAt author { login } } } } } }
  }`;
  const d = JSON.parse(await ghExec(['api', 'graphql', '-f', `query=${query}`])).data;
  const master = CORE_REPOS.map((_, i) => d[`r${i}`]).filter(Boolean).map((r) => {
    const commits = (r.defaultBranchRef?.target?.history?.nodes || []).map((c) => ({
      sha: c.abbreviatedOid, title: c.messageHeadline, at: c.committedDate, url: c.url,
      author: c.author?.user?.login || c.author?.name || '', state: c.statusCheckRollup?.state || null,
      ...normalizeChecks(c.statusCheckRollup),
    }));
    const checked = commits.filter((c) => c.state);
    const head = checked[0] || null;
    const broken = head && ['FAILURE', 'ERROR'].includes(head.state);
    const redSince = broken ? checked.findIndex((c) => !['FAILURE', 'ERROR'].includes(c.state)) : 0;
    return { repo: r.nameWithOwner, url: r.url, branch: r.defaultBranchRef?.name || '', head, broken,
      redCommits: broken ? (redSince === -1 ? checked.length : redSince) : 0, lastGreen: checked.find((c) => c.state === 'SUCCESS') || null,
      recent: commits.slice(0, 5).map(({ sha, title, at, url, author, state }) => ({ sha, title, at, url, author, state })) };
  });
  const merged = (d.merged.nodes || []).filter((n) => n.mergedAt);
  const human = (who) => who && who !== login && who !== 'github-actions' && !who.endsWith('[bot]') && !/^(claude|codex|copilot)/i.test(who);
  const firstReview = (n) => (n.reviews.nodes.filter((r) => human(r.author?.login)).map((r) => r.submittedAt).sort()[0]) || null;
  const weeks = [3, 2, 1, 0].map((w) => merged.filter((n) => {
    const age = (Date.now() - Date.parse(n.mergedAt)) / (7 * DAY_MS);
    return age >= w && age < w + 1;
  }).length);
  const open = prCache.data?.mine || [];
  const metrics = {
    since, merged: d.merged.issueCount, sampled: merged.length, weeks,
    leadHours: median(merged.map((n) => hoursBetween(n.createdAt, n.mergedAt))),
    firstReviewHours: median(merged.map((n) => hoursBetween(n.createdAt, firstReview(n)))),
    medianSize: median(merged.map((n) => n.additions + n.deletions)),
    open: open.length,
    openFailing: open.filter((p) => p.flags.includes('ci')).length,
    openWaiting: open.filter((p) => !p.isDraft && !p.reviews.length).length,
    oldestOpenDays: open.length ? Math.floor(Math.max(...open.map((p) => Date.now() - Date.parse(p.createdAt))) / DAY_MS) : 0,
  };
  healthCache = { at: Date.now(), data: { fetchedAt: new Date().toISOString(), master, metrics } };
  notifier.master(master);
  return healthCache.data;
};

// ------------------------------------------------------------------ Deploy check (is a task's PR in prod?)

// The team's own script is the source of truth (config deployCheck.command, "{url}" = PR url).
// Exit codes: 0 in prod, 2 not merged, 3 merged without release tag, 4 tagged but not deployed.
const PROD_CHECK = CONFIG.deployCheck.command;
const PROD_CHECK_BIN = PROD_CHECK.split(/\s+/)[0] || '';
const TAGGED_REPOS = new Set(CONFIG.deployCheck.repos);
const PR_URL_SAFE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const PROD_EXIT = { 0: 'prod', 2: 'not_merged', 3: 'no_tag', 4: 'pending' };
const prodCache = new Map();
let prodQueue = Promise.resolve();

const runProdCheck = (url) => {
  if (!PR_URL_SAFE.test(url)) return Promise.resolve({ status: 'error', message: 'URL de PR inválida' });
  const cached = prodCache.get(url);
  if (cached && (cached.status === 'prod' || Date.now() - cached.at < 5 * 60_000)) return Promise.resolve(cached);
  // one at a time: the script runs git fetch in the local clone
  const job = prodQueue.then(() => new Promise((resolve) => {
    // the url travels as $1, never interpolated into the shell string
    const script = PROD_CHECK.includes('{url}') ? PROD_CHECK.replaceAll('{url}', '"$1"') : `${PROD_CHECK} "$1"`;
    execFile('/bin/bash', ['-c', script, 'devtower', url], { cwd: fs.existsSync(path.dirname(PROD_CHECK_BIN)) ? path.dirname(PROD_CHECK_BIN) : HOME, timeout: 120_000, env: cleanEnv() }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const out = String(stdout || '');
      const result = {
        at: Date.now(), status: PROD_EXIT[code] || 'error',
        firstTag: /Primer tag que incluye el PR: (\S+)/.exec(out)?.[1] || null,
        prodTag: /Tag actual en producción: (\S+)/.exec(out)?.[1] || null,
        message: out.trim().split('\n').filter(Boolean).pop()?.replace(/^\W+/, '') || (err?.killed ? 'El script tardó demasiado' : 'Sin salida del script'),
      };
      if (result.status !== 'error') prodCache.set(url, result);
      resolve(result);
    });
  }));
  prodQueue = job.catch(() => {});
  return job;
};

// PRs of a ticket and its subtasks: key in the title or the ticket number in the branch
const ticketPrs = async (keys) => {
  const query = `query { ${keys.map((k, i) => `k${i}: search(query: "${ORG ? `org:${ORG}` : 'involves:@me'} is:pr ${k}", type: ISSUE, first: 20) { nodes { ... on PullRequest {
    number url title state merged mergedAt headRefName repository { nameWithOwner } } } }`).join('\n')} }`;
  const d = JSON.parse(await ghExec(['api', 'graphql', '-f', `query=${query}`])).data;
  const prs = new Map();
  keys.forEach((k, i) => {
    const [tracker, num] = k.split('-');
    for (const n of d[`k${i}`]?.nodes || []) {
      if (!n?.url) continue;
      const branch = (n.headRefName || '').toLowerCase();
      if (n.title.includes(k) || branch.includes(`${num}_${tracker.toLowerCase()}`)) prs.set(n.url, { ...n, ticket: k });
    }
  });
  return [...prs.values()];
};

const deployCheck = async (key) => {
  const issue = assertJiraKey(key);
  const { items = [] } = await readJsonFile('jira.json', {});
  const keys = [issue, ...items.filter((i) => i.parent === issue).map((i) => i.key)].slice(0, 15);
  const prs = await ticketPrs(keys);
  const results = [];
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    const base = { repo, number: pr.number, url: pr.url, title: pr.title, ticket: pr.ticket, mergedAt: pr.mergedAt };
    if (!pr.merged) results.push({ ...base, status: pr.state === 'OPEN' ? 'open' : 'closed' });
    else if (!TAGGED_REPOS.has(repo)) results.push({ ...base, status: 'merged_untracked' });
    else if (!PROD_CHECK_BIN || !fs.existsSync(PROD_CHECK_BIN)) results.push({ ...base, status: 'error', message: PROD_CHECK ? `No encontré ${PROD_CHECK_BIN}` : 'Configurá deployCheck.command en la config' });
    else results.push({ ...base, ...(await runProdCheck(pr.url)) });
  }
  const verifiable = results.filter((r) => r.status !== 'closed');
  const overall = !verifiable.length ? 'no_prs'
    : verifiable.every((r) => r.status === 'prod') ? 'prod'
      : verifiable.every((r) => ['prod', 'merged_untracked'].includes(r.status)) ? 'prod_partial'
        : verifiable.some((r) => r.status === 'open') ? 'open' : 'pending';
  return { key: issue, keys, overall, results, checkedAt: new Date().toISOString() };
};

// ------------------------------------------------------------------ Close flow (task already in prod)

// Signals that a change should be checked impersonating the customer before closing
const impersonateHint = (issue) => {
  const reasons = [];
  const escalated = issue.labels.filter((l) => CONFIG.jira.supportLabels.includes(l));
  if (escalated.length) reasons.push(`Viene de soporte (${escalated.join(', ')}): lo reportó un cliente`);
  const text = [issue.summary, issue.description, ...issue.comments.map((c) => c.text)].join('\n');
  if (/imperson/i.test(text)) reasons.push('Menciona impersonate en la descripción o los comentarios');
  if (/\b(cliente|customer|cuenta|company|empresa)\b/i.test(issue.summary)) reasons.push('El título refiere a un cliente o cuenta puntual');
  if (issue.type === 'Error' && !reasons.length) reasons.push('Es un error: conviene reproducir el caso original');
  return { likely: reasons.length > 0, reasons };
};

const closeContext = async (key) => {
  const issueKey = assertJiraKey(key);
  if (!(await direct.has('jira'))) throw Object.assign(new Error('Cerrar tareas requiere el token de Jira en el Keychain.'), { code: 'token_missing', status: 503 });
  const [issue, me, transitions] = await Promise.all([direct.jira.issue(issueKey), direct.jira.me(), direct.jira.transitions(issueKey)]);
  return { issue, me, transitions, impersonate: impersonateHint(issue) };
};

// explicit "Redactar con Claude": no tools, only the text it receives
const draftCloseComment = async (key, notes) => {
  const { issue } = await closeContext(key);
  const prompt = `Redactá un comentario breve para cerrar la tarea de Jira ${issue.key} "${issue.summary}" que ya está en producción.
Español rioplatense, primera persona, tono profesional y claro para alguien no técnico. Explicá qué se implementó y qué cambia para el usuario; si corresponde, cómo verificarlo. Sin saludos largos ni firma, máximo 8 líneas.
Descripción de la tarea:
<<<
${issue.description.slice(0, 2500)}
>>>
Datos del deploy y PRs:
<<<
${notes}
>>>
Devolvé ÚNICAMENTE el texto del comentario.`;
  const { text } = await runClaudeText(prompt, { maxTurns: 1, timeoutMs: 120_000 });
  return text.trim();
};

// ------------------------------------------------------------------ Clockify timer

const CLOCKIFY_ID = /^[a-f0-9]{24}$/;
const clockifyEntry = (b = {}) => {
  const description = String(b.description || '').trim().slice(0, 3000);
  if (!description) throw Object.assign(new Error('Falta la descripción'), { status: 400 });
  return { description, projectId: CLOCKIFY_ID.test(String(b.projectId || '')) ? b.projectId : '',
    tagIds: (Array.isArray(b.tagIds) ? b.tagIds : []).filter((t) => CLOCKIFY_ID.test(String(t))).slice(0, 20), billable: Boolean(b.billable) };
};
const startTaskTimer = async (key) => {
  const issueKey = assertJiraKey(key);
  const cached = (await readJsonFile('jira.json', { items: [] })).items.find((i) => i.key === issueKey);
  const full = await direct.jira.issue(issueKey).catch(() => null);
  return clockify.start(await clockify.taskEntry({ key: issueKey, summary: full?.summary || cached?.summary || '', type: full?.type || cached?.type || '', labels: full?.labels || [] }));
};

// ------------------------------------------------------------------ Slack

const slackState = { running: false, error: null, errorCode: null, resetAt: null };

const SLACK_ME = CONFIG.slack.userId || 'desconocido';
const SLACK_PROMPT = `Sos un asistente que SOLO LEE Slack (no envíes, reacciones ni borradores). Soy ${CONFIG.user.name || 'el usuario'}, user id Slack ${SLACK_ME}.
Hacé como máximo 3 búsquedas (slack_search_public_and_private con filters "with:<@${SLACK_ME}> after:<hace 7 días>", más DMs recientes) y NO leas hilos enteros salvo que sea imprescindible.
Encontrá conversaciones de los últimos 7 días donde estoy pendiente de responder:
- menciones mías en canales sin respuesta mía posterior,
- DMs donde el último mensaje es de otra persona,
- hilos donde participé y alguien respondió después de mi último mensaje.
Excluí bots, alertas automáticas y canales de logs. Máximo 15 items, del más reciente al más viejo.
Respondé ÚNICAMENTE con JSON válido (sin markdown, sin texto extra) con esta forma:
{"items":[{"id":"<channelId>-<slackTs>","kind":"mention|dm|thread","channel":"#nombre o DM","channelId":"C… o D…","author":"nombre","text":"texto del mensaje (máx 400 chars)","ts":"ISO-8601","slackTs":"1760562395.123456","threadTs":"ts del hilo raíz si es un hilo, sino igual a slackTs","permalink":"https://<workspace>.slack.com/archives/<channelId>/p<slackTs sin punto>","reason":"por qué está pendiente (máx 80 chars)"}]}
IMPORTANTE: copiá channelId, slackTs, threadTs y permalink TAL CUAL los devuelven las herramientas de Slack. NUNCA los inventes ni uses placeholders: si no tenés un valor real, dejalo como "".`;

const extractJson = (text) => {
  const start = text.indexOf('{"items"');
  const from = start >= 0 ? start : text.indexOf('{');
  const to = text.lastIndexOf('}');
  return JSON.parse(text.slice(from, to + 1));
};

const refreshSlack = async ({ background = false } = {}) => {
  if (slackState.running) return;
  slackState.running = true;
  try {
    const viaApi = await direct.has('slack');
    if (background && !viaApi) return;
    Object.assign(slackState, { error: null, errorCode: null, resetAt: null });
    if (viaApi) {
      await writeJsonFile('slack.json', { fetchedAt: new Date().toISOString(), items: await direct.slack.pending() });
      return;
    }
    const { text } = await runClaudeText(SLACK_PROMPT, {
      allowed: SLACK_READ_TOOLS, maxTurns: 14, timeoutMs: 6 * 60_000,
    });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed.items)) throw new Error('Invalid Slack items');
    await writeJsonFile('slack.json', { fetchedAt: new Date().toISOString(), items: parsed.items });
  } catch (error) {
    Object.assign(slackState, { error: error.code ? error.message : 'No se pudo actualizar Slack. Reintentá la consulta.',
      errorCode: error.code || 'slack_refresh_failed', resetAt: error.resetAt || null });
  } finally { slackState.running = false; }
};

const SLACK_TOOL = 'mcp__claude_ai_Slack__';
const runClaudeText = (prompt, { allowed = [], disallowed = [], maxTurns = 8, timeoutMs = 120_000 } = {}) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', 'sonnet', '--no-session-persistence', '--max-turns', String(maxTurns)];
    if (allowed.length) args.push('--allowedTools', ...allowed);
    if (disallowed.length) args.push('--disallowedTools', ...disallowed);
    const child = spawn('claude', args, { cwd: HOME, env: cleanEnv() });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('No se pudo iniciar Claude Code. Verificá que esté instalado y que tu sesión esté activa.'),
        { code: 'claude_unavailable', status: 503 }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { resolve(parseClaudeResponse(out, err, code, timedOut)); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });

const CHANNEL_RE = /^[CDG][A-Z0-9]{8,}$/;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;
const realTs = (ts) => SLACK_TS_RE.test(ts || '') && !ts.endsWith('.000000');

// the listing model can invent ids; only trust values that look like real Slack ids
const slackTarget = (item) => {
  const link = String(item.permalink || '');
  const m = link.match(/archives\/([CDG][A-Z0-9]{8,})\/p(\d{10})(\d{6})/);
  const q = link.match(/[?&]thread_ts=(\d+\.\d+)/);
  const fromLink = m ? `${m[2]}.${m[3]}` : null;
  const ts = [item.slackTs, fromLink].find(realTs) || null;
  const threadTs = [item.threadTs, q?.[1], ts].find(realTs) || null;
  const channelId = [item.channelId, m?.[1]].find((c) => CHANNEL_RE.test(c || '')) || null;
  return { channelId, ts, threadTs, link: m ? link : '' };
};

const SLACK_READ_TOOLS = ['read_thread', 'read_channel', 'search_public_and_private', 'search_channels', 'read_user_profile'].map((n) => `${SLACK_TOOL}slack_${n}`);

const findSlackItem = async (id) => (await readJsonFile('slack.json', { items: [] })).items.find((i) => i.id === id);

const describeSlackItem = (item, t) => (t.channelId && t.threadTs
  ? `Ubicación exacta: channel_id=${t.channelId}, thread_ts=${t.threadTs}.`
  : `No tenés ids confiables: ubicá el mensaje vos con las herramientas de búsqueda/lectura de Slack (canal ${item.channel}, autor ${item.author}, aprox. ${item.ts || 'hoy'}) y usá sus ids reales. Nunca inventes ids.
Usá SOLO estas herramientas de Slack: slack_search_public_and_private, slack_search_channels, slack_read_thread, slack_read_channel, slack_read_user_profile. Las demás (incluida slack_search_public y slack_search_users) NO están habilitadas: no las llames.`);

const suggestSlackReply = async (id, instruction) => {
  const item = await findSlackItem(id);
  if (!item) throw new Error('Mensaje no encontrado: actualizá Slack');
  const t = slackTarget(item);
  const prompt = `Sos ${CONFIG.user.name || 'el usuario'} (user id Slack ${SLACK_ME}) en Slack. Leé este mensaje y su hilo. ${describeSlackItem(item, t)}
Mensaje de ${item.author} en ${item.channel}: "${item.text}".
Redactá una respuesta breve, natural, en español rioplatense y en primera persona, lista para enviar.${instruction ? `\nInstrucción mía para la respuesta: ${instruction}` : ''}
Devolvé ÚNICAMENTE el texto de la respuesta, sin comillas, sin explicaciones. No envíes nada ni crees borradores.`;
  const { text, denials } = await runClaudeText(prompt, { allowed: SLACK_READ_TOOLS, disallowed: [`${SLACK_TOOL}slack_send_message_draft`], maxTurns: 10 });
  if (denials.length > 0 && /permis|aprob|acceso|permission/i.test(text)) throw new Error('Claude intentó usar una herramienta de Slack no habilitada y no pudo redactar. Reintentá.');
  return text;
};

const draftSlackReply = async (id, text) => {
  const item = await findSlackItem(id);
  if (!item) throw new Error('Mensaje no encontrado: actualizá Slack');
  const t = slackTarget(item);
  const known = Boolean(t.channelId && t.threadTs);
  const prompt = `Tu tarea: crear un BORRADOR (nunca enviar) de respuesta en Slack usando slack_send_message_draft. ${describeSlackItem(item, t)}
Contexto del mensaje al que se responde: de ${item.author} en ${item.channel}: "${item.text}".
Si el mensaje es parte de un hilo, el borrador debe ser una respuesta en ese hilo (thread_ts del hilo raíz). Texto EXACTO del borrador, sin modificarlo:
<<<
${text}
>>>
Si el borrador se creó, respondé la palabra OK seguida del canal y el thread_ts usados. Si no pudiste ubicar el mensaje con certeza o falló, respondé ERROR y el motivo; en ese caso no crees ningún borrador.`;
  const allowed = [`${SLACK_TOOL}slack_send_message_draft`, ...(known ? [] : SLACK_READ_TOOLS)];
  const { text: reply } = await runClaudeText(prompt, { allowed, maxTurns: known ? 6 : 12, timeoutMs: 150_000 });
  if (!/^\W*OK\b/i.test(reply)) throw new Error(`Slack no confirmó el borrador: ${reply.slice(0, 220)}`);
  return t.link;
};

// ------------------------------------------------------------------- Usage

const runCcusage = (cmd) => new Promise((resolve, reject) => {
  execFile('npx', ['ccusage', cmd, '--json'], { cwd: HOME, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (err, out) => {
    if (err) return reject(err);
    try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
  });
});

// Plan limits come from the statusline JSON that scripts/claude-statusline.mjs saves per session.
// Each session reports what its last API response said: within a window usage only grows, so the
// highest value among recent snapshots with the same reset time is the current one.
const CLAUDE_STATUS_DIR = path.join(CONFIG_DIR, 'claude-status');
const loadClaudeLimits = async () => {
  const files = await fsp.readdir(CLAUDE_STATUS_DIR).catch(() => []);
  const now = Date.now();
  const snaps = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    const file = path.join(CLAUDE_STATUS_DIR, f);
    const snap = await fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (!snap) continue;
    if (now - snap.at > 2 * DAY_MS) { fsp.rm(file, { force: true }).catch(() => {}); continue; }
    snaps.push(snap);
  }
  const windowOf = (key) => {
    const live = snaps.map((s) => ({ ...s.rateLimits?.[key], at: s.at })).filter((w) => w.resets_at && w.resets_at * 1000 > now);
    if (!live.length) return null;
    const latestReset = Math.max(...live.map((w) => w.resets_at));
    const same = live.filter((w) => w.resets_at === latestReset);
    return { usedPct: Math.max(...same.map((w) => Number(w.used_percentage) || 0)), resetsAt: new Date(latestReset * 1000).toISOString(),
      reportedAt: new Date(Math.max(...same.map((w) => w.at))).toISOString() };
  };
  const sessions = snaps.filter((s) => now - s.at < 15 * 60_000).sort((a, b) => b.at - a.at).map((s) => ({
    id: s.session, model: s.model, project: s.cwd ? path.basename(s.cwd) : '', at: new Date(s.at).toISOString(),
    costUsd: s.cost?.total_cost_usd ?? null, contextPct: s.context?.used_percentage ?? null,
    linesAdded: s.cost?.total_lines_added ?? null, linesRemoved: s.cost?.total_lines_removed ?? null,
  }));
  const newest = snaps.length ? Math.max(...snaps.map((s) => s.at)) : 0;
  return { fiveHour: windowOf('five_hour'), sevenDay: windowOf('seven_day'), sessions,
    reportedAt: newest ? new Date(newest).toISOString() : null, stale: !newest || now - newest > 15 * 60_000 };
};

const loadUsage = async () => {
  const limits = await loadClaudeLimits();
  const [blocks, weekly] = await Promise.all([runCcusage('blocks'), runCcusage('weekly')]).catch(() => [{ blocks: [] }, { weekly: [] }]);
  const activeBlock = (blocks.blocks || []).find((b) => b.isActive) || null;
  const now = new Date();
  const daysToMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMonday);
  const mondayStr = monday.toISOString().slice(0, 10);
  const weekCost = (weekly.weekly || []).filter((w) => w.period >= mondayStr).reduce((acc, w) => acc + (w.totalCost || 0), 0);
  return {
    block: activeBlock ? {
      cost: activeBlock.costUSD,
      burnRate: activeBlock.burnRate?.costPerHour || 0,
      remainingMinutes: activeBlock.projection?.remainingMinutes || 0,
      projectedCost: activeBlock.projection?.totalCost || 0,
      startTime: activeBlock.startTime,
      endTime: activeBlock.endTime,
    } : null,
    week: { cost: weekCost, since: mondayStr },
    limits,
    fetchedAt: new Date().toISOString(),
  };
};

// ------------------------------------------------------------------- Jira

const JIRA_SITE = CONFIG.jira.site;
const JIRA_CLOUD_ID = CONFIG.jira.cloudId || JIRA_SITE;
const JIRA_TOOL = 'mcp__claude_ai_Atlassian__';
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const jiraState = { running: false, error: null, errorCode: null, resetAt: null };
const jiraHint = (tool) => `Cargá la herramienta con ToolSearch usando exactamente la consulta "select:${JIRA_TOOL}${tool}". Usá SOLO el conector "claude.ai Atlassian" (prefijo ${JIRA_TOOL}); NO uses "Atlassian MCP" ni intentes autenticar. Si ToolSearch dice que el conector todavía está conectando, volvé a buscar (hasta 6 veces) antes de rendirte.`;

const parseJsonLoose = (text) => {
  const clean = text.replace(/```(?:json)?/g, '');
  const starts = ['{', '['].map((c) => clean.indexOf(c)).filter((i) => i >= 0);
  const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (starts.length === 0 || end < 0) throw new Error('la respuesta no contiene JSON');
  return JSON.parse(clean.slice(Math.min(...starts), end + 1));
};

const refreshJira = async ({ background = false } = {}) => {
  if (jiraState.running) return;
  jiraState.running = true;
  try {
    const viaApi = await direct.has('jira');
    if (background && !viaApi) return;
    Object.assign(jiraState, { error: null, errorCode: null, resetAt: null });
    if (viaApi) {
      const { next = null } = await readJsonFile('jira.json', {});
      const items = await direct.jira.search();
      const board = await sprintBoard(items);
      await writeJsonFile('jira.json', { fetchedAt: new Date().toISOString(), items: await withLanes(items, board), board, next });
      return;
    }
    const prompt = `${jiraHint('searchJiraIssuesUsingJql')}
Solo lectura. Usá searchJiraIssuesUsingJql (cloudId ${JIRA_CLOUD_ID}) con el JQL: assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC, hasta 40 resultados, pidiendo los campos summary, status, priority, issuetype, updated, parent.
Respondé ÚNICAMENTE JSON válido, sin markdown: {"items":[{"key":"","summary":"","status":"nombre del estado","statusCategory":"new|indeterminate","priority":"","type":"","updated":"ISO-8601","parent":"KEY del padre o vacío"}]}. No inventes datos.`;
    const { text } = await runClaudeText(prompt, { allowed: [`${JIRA_TOOL}searchJiraIssuesUsingJql`], maxTurns: 14, timeoutMs: 240_000 });
    const items = (parseJsonLoose(text).items || [])
      .filter((i) => JIRA_KEY_RE.test(i.key || ''))
      .map((i) => ({ ...i, url: `${JIRA_SITE}/browse/${i.key}` }));
    await writeJsonFile('jira.json', { fetchedAt: new Date().toISOString(), items });
  } catch (e) {
    Object.assign(jiraState, { error: e.code ? e.message : 'No se pudo actualizar Jira. Reintentá la consulta.',
      errorCode: e.code || 'jira_refresh_failed', resetAt: e.resetAt || null });
  } finally { jiraState.running = false; }
};

// Board of the active sprint (columns + swimlanes), shown as Jira shows it
const sprintBoard = async (items) => {
  const boardId = items.find((i) => i.sprint?.state === 'active' && i.sprint.boardId)?.sprint.boardId;
  if (!boardId) return null;
  try {
    const board = await direct.jira.boardLayout(boardId);
    return { ...board, swimlanes: board.swimlanes.length ? board.swimlanes : [{ name: 'Todas', query: '' }] };
  } catch { return null; }
};
const withLanes = async (items, board, inSprint = (i) => i.sprint?.state === 'active') => {
  if (!board) return items;
  const keys = items.filter(inSprint).map((i) => i.key);
  const lanes = await direct.jira.assignLanes(keys, board.swimlanes);
  return items.map((i) => (lanes.has(i.key) ? { ...i, lane: lanes.get(i.key) } : i));
};

// On demand only: the next sprint is not part of the background refresh
const loadNextSprint = async () => {
  if (!(await direct.has('jira'))) throw Object.assign(new Error('El próximo sprint requiere el token de Jira en el Keychain.'), { code: 'token_missing', status: 503 });
  const cache = await readJsonFile('jira.json', { fetchedAt: null, items: [] });
  const boards = [...new Set(cache.items.filter((i) => i.sprint?.state === 'active' && i.sprint.boardId).map((i) => i.sprint.boardId))];
  const found = await direct.jira.nextSprint(boards);
  const items = await withLanes(found.items, cache.board, () => true);
  const next = { ...found, items, fetchedAt: new Date().toISOString() };
  await writeJsonFile('jira.json', { ...(await readJsonFile('jira.json', cache)), next });
  return next;
};

const loadJira = async () => ({ ...(await readJsonFile('jira.json', { fetchedAt: null, items: [] })), ...jiraState,
  source: (await direct.has('jira')) ? 'api' : 'claude' });

const assertJiraKey = (key) => {
  if (!JIRA_KEY_RE.test(String(key))) throw new Error('Clave de Jira inválida');
  return String(key);
};

const ACCOUNT_RE = /^[\w:-]{10,128}$/;
const commentJira = async (key, text, mentions = []) => {
  const issue = assertJiraKey(key);
  const valid = (Array.isArray(mentions) ? mentions : []).filter((m) => ACCOUNT_RE.test(String(m?.accountId || '')))
    .slice(0, 5).map((m) => ({ accountId: String(m.accountId), name: String(m.name || '').slice(0, 80) }));
  if (await direct.has('jira')) return void await direct.jira.comment(issue, text, valid);
  if (valid.length) throw Object.assign(new Error('Las menciones requieren el token de Jira en el Keychain.'), { code: 'token_missing', status: 503 });
  const prompt = `${jiraHint('addCommentToJiraIssue')}
Usá addCommentToJiraIssue (cloudId ${JIRA_CLOUD_ID}, issue ${issue}) para publicar este comentario EXACTO, sin modificarlo:
<<<
${text}
>>>
Si se publicó, respondé solo la palabra OK. Si falló, respondé ERROR y el motivo.`;
  const { text: reply } = await runClaudeText(prompt, { allowed: [`${JIRA_TOOL}addCommentToJiraIssue`], maxTurns: 14, timeoutMs: 150_000 });
  if (!/^\W*OK\b/i.test(reply)) throw new Error(`Jira no confirmó el comentario: ${reply.slice(0, 200)}`);
};

const listJiraTransitions = async (key) => {
  const issue = assertJiraKey(key);
  if (await direct.has('jira')) return direct.jira.transitions(issue);
  const prompt = `${jiraHint('getTransitionsForJiraIssue')}
Solo lectura. Usá getTransitionsForJiraIssue (cloudId ${JIRA_CLOUD_ID}, issue ${issue}). Respondé ÚNICAMENTE JSON: {"transitions":[{"id":"","name":"nombre de la transición","to":"estado destino"}]}`;
  const { text } = await runClaudeText(prompt, { allowed: [`${JIRA_TOOL}getTransitionsForJiraIssue`], maxTurns: 14, timeoutMs: 150_000 });
  return (parseJsonLoose(text).transitions || []).filter((t) => /^\d+$/.test(String(t.id)));
};

const transitionJira = async (key, id, name) => {
  const issue = assertJiraKey(key);
  if (!/^\d+$/.test(String(id))) throw new Error('Transición inválida');
  if (await direct.has('jira')) return void await direct.jira.transition(issue, id);
  const prompt = `${jiraHint('transitionJiraIssue')}
Usá transitionJiraIssue (cloudId ${JIRA_CLOUD_ID}, issue ${issue}) con la transición id ${id} (${String(name).slice(0, 60)}). No hagas nada más. Si se aplicó, respondé solo OK. Si falló, ERROR y el motivo.`;
  const { text: reply } = await runClaudeText(prompt, { allowed: [`${JIRA_TOOL}transitionJiraIssue`], maxTurns: 14, timeoutMs: 150_000 });
  if (!/^\W*OK\b/i.test(reply)) throw new Error(`Jira no confirmó el cambio de estado: ${reply.slice(0, 200)}`);
};

// Explicit user action only: posts as the user, then hides the answered item
const sendSlackReply = async (id, text) => {
  const item = await findSlackItem(id);
  if (!item) throw new Error('Mensaje no encontrado: actualizá Slack');
  const t = slackTarget(item);
  if (!t.channelId || !t.ts) throw new Error('El mensaje no tiene ids de Slack confiables. Actualizá Slack y reintentá.');
  const inThread = item.kind !== 'dm' || item.threaded;
  const sent = await direct.slack.send({ channelId: t.channelId, threadTs: inThread ? t.threadTs : null, text });
  const dismissed = await readJsonFile('dismissed.json', []);
  await writeJsonFile('dismissed.json', [...new Set([...dismissed, id])]);
  return sent.link || t.link;
};

const loadSlack = async () => {
  const cache = await readJsonFile('slack.json', { fetchedAt: null, items: [] });
  const dismissed = new Set(await readJsonFile('dismissed.json', []));
  return { ...cache, items: cache.items.filter((i) => !dismissed.has(i.id)).map((i) => ({ ...i, permalink: /^https:\/\/[\w.-]+\/archives\/[CDG][A-Z0-9]{8,}\/p\d{16}/.test(i.permalink || '') && !String(i.permalink).includes('000000') ? i.permalink : '' })), ...slackState,
    source: (await direct.has('slack')) ? 'api' : 'claude' };
};

// ------------------------------------------------------------------ Links

// ⌘K quick access: `links` in the user config
const loadLinks = async () => {
  const links = CONFIG.links;
  return (Array.isArray(links) ? links : [])
    .filter((l) => l && typeof l.name === 'string' && /^https?:\/\//.test(String(l.url)))
    .map(({ name, url, icon = '↗', group = '' }) => ({ name: name.slice(0, 80), url: String(url), icon: String(icon).slice(0, 2), group: String(group).slice(0, 30) }));
};

// ----------------------------------------------------------------- router

const guardPost = (req) => {
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
  return okOrigin && req.headers['x-cockpit'] === '1';
};

const serveStatic = async (req, res, pathname) => {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public'))) return json(res, { error: 'not found' }, 404);
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
};

const readWorkBody = async (req) => {
  try { return await readBody(req, 100_000); }
  catch (error) {
    throw Object.assign(new Error(error.message === 'body too large'
      ? 'El trabajo supera el tamaño permitido.' : 'JSON de trabajo inválido.'), { status: 400 });
  }
};

const workItems = createWorkItems({
  file: path.join(DATA_DIR, 'work-items.json'),
  resolveThread: async (id) => {
    if ((await threadLifecycle.snapshot())[id]?.status === 'deleted') return null;
    if (!idToFile.has(id)) await scanThreads(1, 'all');
    const file = idToFile.get(id);
    if (!file) return null;
    try {
      const stat = await fsp.stat(file);
      return await buildMeta(file, id, stat.mtimeMs);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST' && !guardPost(req)) return json(res, { error: 'forbidden' }, 403);

    if (req.method === 'GET' && p === '/api/work-items') {
      const states = await threadLifecycle.snapshot();
      const items = (await workItems.snapshot()).map((item) => ({ ...item,
        threads: item.threads.map((thread) => ({ ...thread, status: states[thread.id]?.status || 'active' })),
      }));
      return json(res, { items });
    }
    if (req.method === 'POST' && p === '/api/work-items') {
      return json(res, { item: await workItems.save(await readWorkBody(req)) }, 201);
    }
    const workItem = p.match(/^\/api\/work-items\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'POST' && workItem) {
      return json(res, { item: await workItems.save(await readWorkBody(req), workItem[1]) });
    }
    if (req.method === 'GET' && p === '/api/dev/events') return liveReload.connect(req, res);
    if (req.method === 'GET' && p === '/api/workspaces') return json(res, { repos: await listRepos() });
    if (req.method === 'GET' && p === '/api/threads') {
      const all = await scanThreads(Number(url.searchParams.get('days') ?? 14), 'all');
      return json(res, { threads: all.filter((t) => !t.archived), archivedThreads: all.filter((t) => t.archived) });
    }
    const threadAction = p.match(/^\/api\/threads\/([^/]+)\/(archive|restore|delete)$/);
    if (req.method === 'POST' && threadAction) {
      const body = await readBody(req);
      const result = await threadLifecycle.change(threadAction[1], threadAction[2], body.confirm);
      if (result.status === 'deleted') {
        metaCache.delete(result.file);
        hayCache.delete(result.id);
        idToFile.delete(result.id);
        indexDirty = true;
        await saveIndex();
      }
      return json(res, { ok: true, id: result.id, status: result.status });
    }
    if (req.method === 'GET' && p === '/api/search') return json(res, { hits: await searchThreads(url.searchParams.get('q') || '', Number(url.searchParams.get('days') ?? 365), url.searchParams.get('visibility') === 'archived' ? 'archived' : 'active') });
    if (req.method === 'GET' && p.startsWith('/api/threads/')) {
      const messages = await loadTranscript(p.split('/')[3]);
      return messages ? json(res, { messages }) : json(res, { error: 'not found' }, 404);
    }
    if (req.method === 'POST' && p === '/api/run') return await handleRun(req, res);
    if (req.method === 'POST' && p === '/api/stop') return await handleStop(req, res);
    if (req.method === 'GET' && p === '/api/commands') return json(res, { commands: await scanCommands(resolveCwd(url.searchParams.get('cwd'))) });
    if (req.method === 'GET' && p === '/api/git-branch') return json(res, { git: await gitBranch(resolveCwd(url.searchParams.get('cwd'))) });
    if (req.method === 'GET' && p === '/api/files') return json(res, { files: await searchFiles(resolveCwd(url.searchParams.get('cwd')), url.searchParams.get('q') || '') });
    if (req.method === 'POST' && p === '/api/rename') {
      const { id, title } = await readBody(req);
      await renameThread(String(id), title);
      metaCache.clear();
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/prs') return json(res, await loadPrs(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && p === '/api/slack') return json(res, await loadSlack());
    if (req.method === 'POST' && p === '/api/slack/refresh') {
      refreshSlack();
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/slack/suggest') {
      const { id, instruction } = await readBody(req);
      return json(res, { text: await suggestSlackReply(String(id), String(instruction || '').slice(0, 500)) });
    }
    if (req.method === 'POST' && p === '/api/slack/send') {
      const { id, text } = await readBody(req);
      const body = String(text || '').trim();
      if (body === '' || body.length > 4000) return json(res, { error: 'El texto debe tener entre 1 y 4000 caracteres' }, 400);
      return json(res, { ok: true, link: await sendSlackReply(String(id), body) });
    }
    if (req.method === 'POST' && p === '/api/slack/draft') {
      const { id, text } = await readBody(req);
      const body = String(text || '').trim();
      if (body === '' || body.length > 4000) return json(res, { error: 'El texto debe tener entre 1 y 4000 caracteres' }, 400);
      return json(res, { ok: true, link: await draftSlackReply(String(id), body) });
    }
    if (req.method === 'POST' && p === '/api/deploy-check') return json(res, await deployCheck((await readBody(req)).key));
    if (req.method === 'GET' && p === '/api/health') return json(res, await loadHealth(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && p === '/api/notifications') return json(res, await notifier.list());
    if (req.method === 'POST' && p === '/api/notifications/read') {
      const { ids } = await readBody(req);
      await notifier.markRead(ids === 'all' ? 'all' : (Array.isArray(ids) ? ids.map(String).slice(0, 200) : []));
      return json(res, await notifier.list());
    }
    if (req.method === 'POST' && p === '/api/notifications/test') return json(res, await notifier.test());
    if (req.method === 'GET' && p === '/api/clockify') return json(res, await clockify.status());
    if (req.method === 'POST' && p === '/api/clockify/start') {
      const body = await readBody(req);
      return json(res, { running: body.key ? await startTaskTimer(body.key) : await clockify.start(clockifyEntry(body)) });
    }
    if (req.method === 'POST' && p === '/api/clockify/stop') { await clockify.stop(); return json(res, { ok: true }); }
    if (req.method === 'GET' && p === '/api/settings') return json(res, await settings.status());
    if (req.method === 'POST' && p === '/api/settings') {
      const config = await settings.save(await readBody(req));
      return json(res, { config, restart: restartSoon() });
    }
    if (req.method === 'POST' && p === '/api/settings/link') {
      const body = await readBody(req);
      const linked = await settings.link(body);
      return json(res, { ...linked, restart: body.name === 'jira' ? restartSoon() : 'none' });
    }
    if (req.method === 'POST' && p === '/api/settings/unlink') {
      await settings.unlink(String((await readBody(req)).name));
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/settings/slack-manifest') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(await fsp.readFile(path.join(ROOT, 'docs', 'slack-manifest.json')));
    }
    if (req.method === 'GET' && p === '/api/settings/jira-suggest') return json(res, await settings.suggestJira());
    if (req.method === 'GET' && p === '/api/settings/repos') return json(res, { repos: await settings.repos(url.searchParams.get('org')) });
    if (req.method === 'GET' && p === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`window.DEVTOWER = ${JSON.stringify(publicConfig(CONFIG))};`);
    }
    if (req.method === 'GET' && p === '/api/links') return json(res, { links: await loadLinks() });
    if (req.method === 'GET' && p === '/api/usage') return json(res, await loadUsage());
    if (req.method === 'GET' && p === '/api/claude-limits') return json(res, await loadClaudeLimits());
    if (req.method === 'GET' && p === '/api/jira') return json(res, await loadJira());
    if (req.method === 'POST' && p === '/api/jira/refresh') {
      refreshJira();
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/jira/issue') return json(res, await closeContext(url.searchParams.get('key')));
    if (req.method === 'POST' && p === '/api/jira/draft-close') {
      const { key, notes } = await readBody(req);
      return json(res, { text: await draftCloseComment(key, String(notes || '').slice(0, 4000)) });
    }
    if (req.method === 'POST' && p === '/api/jira/next') return json(res, { next: await loadNextSprint() });
    if (req.method === 'POST' && p === '/api/jira/comment') {
      const { key, text, mentions } = await readBody(req);
      const body = String(text || '').trim();
      if (body === '' || body.length > 8000) return json(res, { error: 'El comentario debe tener entre 1 y 8000 caracteres' }, 400);
      await commentJira(key, body, mentions);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/jira/transitions') {
      const { key } = await readBody(req);
      return json(res, { transitions: await listJiraTransitions(key) });
    }
    if (req.method === 'POST' && p === '/api/jira/transition') {
      const { key, id, name } = await readBody(req);
      await transitionJira(key, id, name);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/slack/dismiss') {
      const { id } = await readBody(req);
      if (typeof id !== 'string' || !id) return json(res, { error: 'id requerido' }, 400);
      const dismissed = await readJsonFile('dismissed.json', []);
      await writeJsonFile('dismissed.json', [...new Set([...dismissed, id])]);
      await notifier.markRead([`slack:${id}`]); // también sale de pendientes en 🔔
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return await serveStatic(req, res, p);
    json(res, { error: 'not found' }, 404);
  } catch (e) {
    if (!res.headersSent) json(res, { error: e.message, ...(e.code ? { code: e.code } : {}),
      ...(e.resetAt ? { resetAt: e.resetAt } : {}) }, e.status || 500);
    else res.end();
  }
});

server.on('close', () => liveReload.close());
server.listen(PORT, '127.0.0.1', () => console.log(`cockpit → http://127.0.0.1:${PORT}`));

// Background refresh: direct APIs and gh only, never Claude
const backgroundRefresh = () => Promise.allSettled([
  refreshJira({ background: true }), refreshSlack({ background: true }), loadPrs(true).then(() => loadHealth(true)),
]);
// Notifications: cheap checks every minute (2 Slack searches, 1 JQL, local thread scan)
const notifyCheck = async () => {
  const jobs = [scanThreads(1).then((list) => notifier.threads(list))];
  if (await direct.has('slack')) jobs.push(direct.slack.recent(Math.floor(Date.now() / 1000) - 15 * 60).then((m) => notifier.slack(m)));
  if (await direct.has('jira')) jobs.push(direct.jira.recentComments(15).then((c) => notifier.jira(c)));
  const results = await Promise.allSettled(jobs);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error('notify check:', r.reason?.message));
};

if (process.env.DEVTOWER_BACKGROUND !== '0') {
  setTimeout(backgroundRefresh, 3_000).unref();
  setInterval(backgroundRefresh, REFRESH_MS).unref();
  setTimeout(notifyCheck, 8_000).unref();
  setInterval(notifyCheck, 60_000).unref();
  setInterval(() => loadPrs(true).catch(() => {}), 2 * 60_000).unref();
}
