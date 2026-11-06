import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const freePort = async () => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
const fixture = async (t, code = '') => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devtower service '));
  const port = await freePort();
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(path.join(source, 'scripts', 'service.cjs'), path.join(root, 'scripts', 'service.cjs'));
  await fs.writeFile(path.join(root, 'server.js'), code || `
    const http = require('node:http');
    const fs = require('node:fs');
    http.createServer((req, res) => res.end('fixture')).listen(Number(process.env.PORT), '127.0.0.1', () => {
      fs.writeFileSync(__dirname + '/server.pid', String(process.pid));
      console.log('fixture ready');
    });
  `);
  const control = (action, env = {}) => {
    try {
      return { status: 0, output: execFileSync(process.execPath,
        [path.join(root, 'scripts', 'service.cjs'), ...action.split(' ')], {
          cwd: os.tmpdir(), env: { ...process.env, PORT: String(port),
            DEVTOWER_AGENTS_DIR: path.join(root, 'agents'), ...env },
          encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
        }) };
    } catch (error) { return { status: error.status, output: `${error.stdout || ''}${error.stderr || ''}` }; }
  };
  t.after(async () => {
    const pid = Number(await fs.readFile(path.join(root, 'server.pid'), 'utf8').catch(() => '0'));
    if (pid > 1) {
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
        if (command.endsWith(` ${path.join(root, 'server.js')}`)) process.kill(pid, 'SIGTERM');
      } catch { /* Fixture was already stopped. */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, port, control };
};

test('service starts detached, detects repeated starts, stops and starts again without fixed PID', async (t) => {
  const f = await fixture(t);
  assert.match(f.control('status').output, /detenida/);
  assert.match(f.control('down').output, /ya está detenida/);
  const started = f.control('up');
  assert.equal(started.status, 0, started.output);
  assert.match(started.output, /devtower iniciada/);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
  const pid = await fs.readFile(path.join(f.root, 'server.pid'), 'utf8');
  assert.match(f.control('up').output, /ya está iniciada/);
  assert.equal(await fs.readFile(path.join(f.root, 'server.pid'), 'utf8'), pid);
  assert.match(f.control('status').output, new RegExp(`PID ${pid}`));
  assert.match(await fs.readFile(path.join(f.root, 'data', `server-${f.port}.log`), 'utf8'), /fixture ready/);
  assert.match(f.control('down').output, /devtower detenida/);
  assert.match(f.control('status').output, /detenida/);
  const restarted = f.control('up');
  assert.equal(restarted.status, 0, restarted.output);
  assert.notEqual(await fs.readFile(path.join(f.root, 'server.pid'), 'utf8'), pid);
  assert.match(f.control('down').output, /devtower detenida/);
});

test('service refuses to start over or stop a listener from another project', async (t) => {
  const f = await fixture(t);
  const foreign = await fixture(t);
  const child = spawn(process.execPath, [path.join(foreign.root, 'server.js')], {
    env: { ...process.env, PORT: String(f.port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  for (const action of ['up', 'down', 'status']) {
    const result = f.control(action);
    assert.equal(result.status, 1);
    assert.match(result.output, /ocupado por otro/);
  }
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
});

test('service recognizes a foreground node server.js launched in the project directory', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: f.root, env: { ...process.env, PORT: String(f.port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  assert.match(f.control('status').output, /devtower iniciada/);
  assert.match(f.control('down').output, /devtower detenida/);
});

test('service reports invalid arguments and startup failure without pretending success', async (t) => {
  const f = await fixture(t, 'process.exit(1);');
  assert.equal(f.control('invalid').status, 1);
  assert.equal(f.control('up', { PORT: 'invalid' }).status, 1);
  const result = f.control('up');
  assert.equal(result.status, 1);
  assert.match(result.output, /no pudo iniciarse/);
  assert.match(f.control('status').output, /detenida/);
});

test('service refuses to stop a server while it has child tasks', async (t) => {
  const f = await fixture(t, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const task = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => { task.kill(); process.exit(0); });
    require('node:http').createServer((req, res) => res.end('fixture')).listen(Number(process.env.PORT), '127.0.0.1', () => {
      fs.writeFileSync(__dirname + '/server.pid', String(process.pid));
    });
  `);
  const started = f.control('up');
  assert.equal(started.status, 0, started.output);
  const result = f.control('down');
  assert.equal(result.status, 1);
  assert.match(result.output, /tareas en curso/);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
});

const fakeLaunchctl = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const state = process.env.FAKE_LAUNCHD;
const loaded = state + '/loaded.json';
const [action, , target] = process.argv.slice(2);
fs.appendFileSync(state + '/calls.log', process.argv.slice(2).join(' ') + '\\n');
const start = (plist) => {
  const xml = fs.readFileSync(plist, 'utf8');
  const args = [...xml.match(/<array>(.*)<\\/array>/)[1].matchAll(/<string>(.*?)<\\/string>/g)].map((m) => m[1]);
  const port = xml.match(/<key>PORT<\\/key><string>(\\d+)/)[1];
  const child = spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, PORT: port } });
  child.unref();
  fs.writeFileSync(loaded, JSON.stringify({ plist, pid: child.pid }));
};
if (action === 'print') process.exit(fs.existsSync(loaded) ? 0 : 1);
if (action === 'bootstrap') start(target);
if (action === 'kickstart') start(JSON.parse(fs.readFileSync(loaded, 'utf8')).plist);
if (action === 'bootout') {
  try { process.kill(JSON.parse(fs.readFileSync(loaded, 'utf8')).pid, 'SIGTERM'); } catch {}
  fs.rmSync(loaded, { force: true });
}
`;

test('autostart installs a LaunchAgent, survives down/up and uninstalls cleanly', async (t) => {
  const f = await fixture(t);
  const launchd = path.join(f.root, 'launchd');
  await fs.mkdir(launchd);
  const bin = path.join(f.root, 'launchctl');
  await fs.writeFile(bin, fakeLaunchctl, { mode: 0o755 });
  const env = { DEVTOWER_LAUNCHCTL: bin, FAKE_LAUNCHD: launchd };
  const plist = path.join(f.root, 'agents', `local.devtower.${f.port}.plist`);
  t.after(() => f.control('autostart off', env));

  assert.equal(f.control('autostart', env).status, 1);
  const enabled = f.control('autostart on', env);
  assert.equal(enabled.status, 0, enabled.output);
  assert.match(enabled.output, /Autoarranque activado/);
  const xml = await fs.readFile(plist, 'utf8');
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, new RegExp(`<key>PORT</key><string>${f.port}</string>`));
  assert.ok(xml.includes(`<string>${path.join(await fs.realpath(f.root), 'server.js')}</string>`));
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
  assert.match(f.control('status', env).output, /autoarranque activo/);

  assert.match(f.control('down', env).output, /próximo inicio de sesión/);
  assert.match(f.control('status', env).output, /detenida\. · autoarranque activo/);
  const up = f.control('up', env);
  assert.equal(up.status, 0, up.output);
  assert.match(up.output, /autoarranque/);
  assert.match(await fs.readFile(path.join(launchd, 'calls.log'), 'utf8'), /^bootstrap gui\/\d+ /m);

  const off = f.control('autostart off', env);
  assert.equal(off.status, 0, off.output);
  assert.match(off.output, /Autoarranque desactivado/);
  await assert.rejects(fs.access(plist));
  assert.match(f.control('status', env).output, /^devtower detenida\.$/m);
});
