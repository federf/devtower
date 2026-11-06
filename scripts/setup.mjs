#!/usr/bin/env node
// devtower setup: checks prerequisites, asks for each integration (all optional), validates the
// tokens against the real APIs, stores them outside the repo and writes ~/.config/devtower/config.json.
//   npm run setup                         interactive
//   npm run setup -- --preset team.json   start from a team preset (links, repos, deploy check…)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, CONFIG_FILE, DEFAULTS } from '../config.js';
import { readSecret, storeSecret } from '../secrets.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const title = (s) => console.log(`\n${bold(s)}`);
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const merge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
};

// one line iterator for both a terminal and piped input; tokens are read with echo muted
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
rl._writeToOutput = (text) => { if (!muted) process.stdout.write(text); };
const lines = rl[Symbol.asyncIterator]();
const line = async (prompt, hidden = false) => {
  rl.setPrompt(prompt);
  rl.prompt();
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden || !process.stdin.isTTY) process.stdout.write('\n');
  return done ? null : String(value).trim();
};
const ask = async (q, def = '') => (await line(`  ${q}${def ? dim(` [${def}]`) : ''}: `)) || def;
// end of input never confirms anything with side effects
const yes = async (q, def = true) => {
  const answer = await line(`  ${q} (s/n)${dim(` [${def ? 's' : 'n'}]`)}: `);
  return answer === null ? false : /^(s|si|sí|y|yes)$/i.test(answer || (def ? 's' : 'n'));
};
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const secretInput = async (q) => (await line(`  ${q}: `, true)) || '';

const presetArg = process.argv.indexOf('--preset');
const preset = presetArg > -1 ? readJson(process.argv[presetArg + 1]) : null;
if (presetArg > -1 && !preset) { console.error(`No pude leer el preset ${process.argv[presetArg + 1]}`); process.exit(1); }
let cfg = merge(merge(DEFAULTS, preset || {}), readJson(CONFIG_FILE) || {});

console.log(`\n${bold('devtower')} · setup ${dim(`→ ${CONFIG_FILE}`)}`);
if (preset) ok(`Preset cargado: ${process.argv[presetArg + 1]}`);
console.log(dim('  Enter acepta el valor entre corchetes. Los tokens no se guardan en el repo ni en config.json.'));

// ------------------------------------------------------------------ prerequisites
title('1. Requisitos');
const nodeMajor = Number(process.versions.node.split('.')[0]);
nodeMajor >= 20 ? ok(`Node ${process.versions.node}`) : warn(`Node ${process.versions.node}: se necesita 20 o más`);
const gh = sh('gh', ['--version']);
const ghUser = gh && sh('gh', ['api', 'user', '--jq', '.login']);
if (!gh) warn('gh (GitHub CLI) no está instalado: sin PRs ni master. https://cli.github.com');
else if (!ghUser) warn('gh no tiene sesión: corré `gh auth login` y repetí el setup');
else ok(`GitHub CLI con sesión como ${ghUser}`);
sh('claude', ['--version']) ? ok('Claude Code instalado (hilos y redacción con IA)') : warn('Claude Code no está instalado: las acciones con IA no van a funcionar');

// ------------------------------------------------------------------ you
title('2. Vos');
cfg.user.name = await ask('Tu nombre (para el saludo)', cfg.user.name || (sh('git', ['config', '--global', 'user.name']) || '').split(' ')[0]);
cfg.reposDir = await ask('Carpeta donde tenés clonados los repos', cfg.reposDir);

// ------------------------------------------------------------------ GitHub
if (ghUser) {
  title('3. GitHub');
  const orgs = sh('gh', ['api', 'user/orgs', '--jq', '.[].login'])?.split('\n').filter(Boolean) || [];
  if (orgs.length) console.log(dim(`  Tus orgs: ${orgs.join(', ')}`));
  cfg.github.org = await ask('Org donde buscar PRs de tickets', cfg.github.org || orgs[0] || '');
  if (cfg.github.org) {
    const recent = sh('gh', ['repo', 'list', cfg.github.org, '--limit', '6', '--json', 'name', '--jq', '.[].name'])?.split('\n').filter(Boolean) || [];
    cfg.github.coreRepos = list(await ask('Repos cuyo master/main querés vigilar (coma)', (cfg.github.coreRepos.length ? cfg.github.coreRepos : recent.slice(0, 4)).join(', ')));
  }
}

// ------------------------------------------------------------------ Jira
title('4. Jira');
if (await yes('¿Usás Jira Cloud?', true)) {
  cfg.jira.site = (await ask('Sitio', cfg.jira.site || 'https://tu-empresa.atlassian.net')).replace(/\/+$/, '');
  cfg.jira.email = await ask('Email de tu cuenta Atlassian', cfg.jira.email || sh('git', ['config', '--global', 'user.email']) || '');
  const existing = await readSecret('jira');
  console.log(dim('  Token: https://id.atlassian.com/manage-profile/security/api-tokens → Create API token'));
  const token = await secretInput(existing ? 'API token (Enter = conservar el actual)' : 'API token');
  const use = token || existing?.password;
  if (use) {
    const auth = `Basic ${Buffer.from(`${cfg.jira.email}:${use}`).toString('base64')}`;
    const me = await fetch(`${cfg.jira.site}/rest/api/3/myself`, { headers: { authorization: auth, accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!me) warn('Jira rechazó el token o el sitio: revisalos y repetí el setup');
    else {
      ok(`Jira: ${me.displayName}`);
      if (token) ok(`Token guardado en ${await storeSecret('jira', token, cfg.jira.email)}`);
      cfg.jira.cloudId = (await fetch(`${cfg.jira.site}/_edge/tenant_info`).then((r) => r.json()).catch(() => ({}))).cloudId || cfg.jira.cloudId;
      // ticket pattern from the projects of your own issues
      const res = await fetch(`${cfg.jira.site}/rest/api/3/search/jql`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jql: 'assignee = currentUser() ORDER BY updated DESC', maxResults: 100, fields: ['labels'] }) }).then((r) => r.json()).catch(() => ({}));
      const projects = [...new Set((res.issues || []).map((i) => i.key.split('-')[0]))];
      const suggested = projects.length ? `(?:${projects.join('|')})-\\d{1,7}` : cfg.jira.ticketPattern;
      if (projects.length) console.log(dim(`  Proyectos de tus tareas: ${projects.join(', ')}`));
      cfg.jira.ticketPattern = await ask('Patrón de clave de ticket (regex)', cfg.jira.ticketPattern !== DEFAULTS.jira.ticketPattern ? cfg.jira.ticketPattern : suggested);
      const labels = [...new Set((res.issues || []).flatMap((i) => i.fields?.labels || []))];
      if (labels.length) console.log(dim(`  Etiquetas en tus tareas: ${labels.slice(0, 12).join(', ')}`));
      cfg.jira.supportLabels = list(await ask('Etiquetas de tareas reportadas por clientes (piden validar por impersonate, coma)', cfg.jira.supportLabels.join(', ')));
    }
  }
} else cfg.jira.site = '';

// ------------------------------------------------------------------ Slack
title('5. Slack');
if (await yes('¿Querés ver y responder tus pendientes de Slack?', true)) {
  const existing = await readSecret('slack');
  if (!existing) {
    console.log(`  1. https://api.slack.com/apps → Create New App → ${bold('From an app manifest')} → pestaña JSON`);
    console.log(`  2. Pegá ${bold(path.join(ROOT, 'docs', 'slack-manifest.json'))}`);
    console.log('  3. Install to Workspace → copiá el User OAuth Token (xoxp-…)');
  }
  const token = await secretInput(existing ? 'User token (Enter = conservar el actual)' : 'User token xoxp-…');
  const use = token || existing?.password;
  if (use) {
    const me = await fetch('https://slack.com/api/auth.test', { headers: { authorization: `Bearer ${use}` } }).then((r) => r.json()).catch(() => ({}));
    if (!me.ok) warn(`Slack rechazó el token (${me.error || 'sin respuesta'})`);
    else {
      ok(`Slack: ${me.user} en ${me.team}`);
      cfg.slack.userId = me.user_id;
      if (token) ok(`Token guardado en ${await storeSecret('slack', token)}`);
    }
  }
}

// ------------------------------------------------------------------ deploy check
title('6. Verificación de deploy (opcional)');
console.log(dim('  Un comando tuyo que diga si un PR está en prod. {url} = URL del PR.'));
console.log(dim('  Códigos de salida: 0 en prod · 2 sin mergear · 3 sin tag de release · 4 falta deploy.'));
cfg.deployCheck.command = await ask('Comando (vacío = desactivado)', cfg.deployCheck.command);
if (cfg.deployCheck.command) {
  cfg.deployCheck.repos = list(await ask('Repos que puede verificar (owner/repo, coma)', cfg.deployCheck.repos.join(', ') || (cfg.github.org && cfg.github.coreRepos[0] ? `${cfg.github.org}/${cfg.github.coreRepos[0]}` : '')));
}

// ------------------------------------------------------------------ save
title('7. Guardar');
console.log(dim(`  Accesos rápidos (⌘K): ${cfg.links.length} configurados. Se editan en «links» del archivo de config.`));
delete cfg.configured;
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(CONFIG_FILE, 0o600);
ok(`Config guardada en ${CONFIG_FILE}`);

if (process.platform === 'darwin' && await yes('¿Iniciar devtower automáticamente al entrar a la sesión?', true)) {
  try { console.log(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'service.cjs'), 'autostart', 'on'], { encoding: 'utf8' }).trim()); }
  catch (error) { warn(String(error.stderr || error.message).trim()); }
} else console.log(`\n  Iniciar: ${bold('npm run up')} → http://localhost:4317`);
rl.close();
