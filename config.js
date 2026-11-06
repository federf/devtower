import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-developer settings live outside the repo: ~/.config/devtower/config.json
// (DEVTOWER_CONFIG overrides the path). `npm run setup` writes it. Secrets never go here.

export const APP = 'devtower';
export const CONFIG_DIR = process.env.DEVTOWER_CONFIG_DIR || path.join(os.homedir(), '.config', APP);
export const CONFIG_FILE = process.env.DEVTOWER_CONFIG || path.join(CONFIG_DIR, 'config.json');

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export const DEFAULTS = {
  user: { name: '' },
  reposDir: '~/Projects',
  github: {
    org: '',            // GitHub org for ticket → PR search and master health
    coreRepos: [],      // repos whose default branch is watched ("Master y métricas")
  },
  jira: {
    site: '',           // https://your-company.atlassian.net
    email: '',          // account email for the API token
    cloudId: '',        // only for the Claude fallback (setup fills it)
    ticketPattern: '[A-Z][A-Z0-9]{1,9}-\\d{1,7}',
    supportLabels: [],  // labels of customer-reported issues (close flow asks for impersonate validation)
  },
  slack: { userId: '' }, // fallback mode (Claude) only; the API token resolves it automatically
  deployCheck: {
    command: '',        // e.g. "~/scripts/is-on-prod.sh {url}" — exit 0 prod, 2 not merged, 3 no tag, 4 pending
    repos: [],          // owner/repo list the command can verify
  },
  links: [],            // ⌘K quick access: [{ name, url, icon, group }]
  logs: { hint: '' },
  clockify: { workspaceId: '' }, // filled when the API key is linked   // how Claude should search production logs (e.g. which skills/MCP to use)
};

const merge = (base, extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
};

export const loadConfig = (file = CONFIG_FILE) => {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') console.error(`No se pudo leer ${file}: ${error.message}`);
  }
  const config = merge(DEFAULTS, raw);
  config.reposDir = expandHome(config.reposDir);
  config.jira.site = String(config.jira.site || '').replace(/\/+$/, '');
  config.deployCheck.command = expandHome(config.deployCheck.command);
  config.configured = fs.existsSync(file);
  return config;
};

// what the browser may see: no emails, ids or commands
export const publicConfig = (c) => ({
  app: APP, configured: c.configured, userName: c.user.name, jiraSite: c.jira.site,
  ticketPattern: c.jira.ticketPattern, githubOrg: c.github.org, deployCheck: Boolean(c.deployCheck.command), logsHint: c.logs.hint,
});
