#!/usr/bin/env node
// Claude Code statusLine wrapper: saves the documented statusline JSON (plan rate limits,
// model, session cost, context) for devtower and then runs your usual statusline unchanged.
//   "statusLine": { "type": "command", "command": "node <devtower>/scripts/claude-statusline.mjs npx -y ccstatusline@latest" }
// Without a command after the script it prints a compact line itself.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(process.env.DEVTOWER_CONFIG_DIR || path.join(os.homedir(), '.config', 'devtower'), 'claude-status');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  let data = null;
  try { data = JSON.parse(raw.toString('utf8')); } catch { /* not JSON: just pass it on */ }
  if (data?.session_id) {
    try {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const snap = {
        at: Date.now(), session: String(data.session_id), cwd: data.workspace?.current_dir || data.cwd || '',
        model: data.model?.display_name || data.model?.id || '', version: data.version || '',
        rateLimits: data.rate_limits || null, cost: data.cost || null, context: data.context_window || null,
      };
      const file = path.join(DIR, `${snap.session.replace(/[^\w-]/g, '')}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* never break the status line */ }
  }
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    const five = data?.rate_limits?.five_hour?.used_percentage;
    process.stdout.write(`${data?.model?.display_name || 'Claude'}${five != null ? ` · 5h ${Math.round(five)}%` : ''}`);
    return;
  }
  const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => process.exit(0));
  child.on('exit', (code) => process.exit(code ?? 0));
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
});
