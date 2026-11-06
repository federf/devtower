import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, CONFIG_DIR } from './config.js';

// Tokens (Jira, Slack…) never live in the repo or in config.json. Lookup order:
//   1. env DEVTOWER_<NAME>_TOKEN (and DEVTOWER_<NAME>_ACCOUNT)
//   2. macOS Keychain, service "devtower-<name>" (legacy "trama-<name>")
//   3. Linux Secret Service via secret-tool (service "devtower-<name>")
//   4. ~/.config/devtower/secrets.json with 0600 permissions
// Values: { account, password }.

const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json');
const run = (cmd, args, input) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout: 10_000 }, (err, out, errOut) => resolve(err ? null : { out, errOut }));
  if (input !== undefined) { child.stdin.end(input); }
});

const fromKeychain = async (service) => {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', service, '-g']);
  const password = r && /^password: "(.*)"$/m.exec(r.errOut)?.[1];
  return password ? { account: /"acct"<blob>="([^"]*)"/.exec(r.out)?.[1] || '', password } : null;
};
const fromSecretTool = async (service) => {
  const r = await run('secret-tool', ['lookup', 'service', service]);
  return r?.out ? { account: '', password: r.out.trim() } : null;
};
const fromFile = () => {
  try {
    if ((fs.statSync(SECRETS_FILE).mode & 0o077) !== 0) return {}; // ignore a world/group readable file
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch { return {}; }
};

export const readSecret = async (name) => {
  const key = name.toUpperCase();
  if (process.env[`DEVTOWER_${key}_TOKEN`]) return { account: process.env[`DEVTOWER_${key}_ACCOUNT`] || '', password: process.env[`DEVTOWER_${key}_TOKEN`] };
  if (process.platform === 'darwin') {
    for (const service of [`${APP}-${name}`, `trama-${name}`]) {
      const hit = await fromKeychain(service);
      if (hit) return hit;
    }
  } else {
    const hit = await fromSecretTool(`${APP}-${name}`);
    if (hit) return hit;
  }
  const file = fromFile()[name];
  return file ? { account: '', password: String(file) } : null;
};

// Used by setup. On macOS the token goes through the Keychain CLI; elsewhere secret-tool reads
// it from stdin, falling back to the 0600 file.
export const storeSecret = async (name, password, account = process.env.USER || APP) => {
  const service = `${APP}-${name}`;
  if (process.platform === 'darwin') {
    const ok = await run('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', password]);
    if (ok) return `Llavero de macOS (${service})`;
  } else {
    const ok = await run('secret-tool', ['store', '--label', service, 'service', service], password);
    if (ok) return `Secret Service (${service})`;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const all = fromFile();
  all[name] = password;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
  return SECRETS_FILE;
};
