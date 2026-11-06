const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const port = Number(process.env.PORT || 4317);
const server = path.join(root, 'server.js');
const log = path.join(root, 'data', `server-${port}.log`);
const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
const label = `local.devtower.${port}`;
const agents = process.env.DEVTOWER_AGENTS_DIR || path.join(require('node:os').homedir(), 'Library', 'LaunchAgents');
const plist = path.join(agents, `${label}.plist`);
const launchctl = process.env.DEVTOWER_LAUNCHCTL || '/bin/launchctl';
const domain = `gui/${process.getuid()}`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const read = (command, args, emptyIsValid = false) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) {
    if (emptyIsValid && error.status === 1 && !String(error.stdout || '').trim()
      && !String(error.stderr || '').trim()) return '';
    throw new Error(`No se pudo verificar el proceso con ${command}. No se detuvo ningún servicio.`);
  }
};
const instance = () => {
  const ids = [...new Set(read(lsof, ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], true).split(/\s+/).filter(Boolean))];
  if (!ids.length) return null;
  if (ids.length !== 1) throw new Error(`Hay varios procesos en el puerto ${port}. No se modificó ninguno.`);
  const pid = Number(ids[0]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('PID de servidor inválido.');
  const command = read('ps', ['-p', String(pid), '-o', 'command=']);
  const suffix = command.endsWith(` ${server}`) ? ` ${server}`
    : command.endsWith(' server.js') ? ' server.js' : null;
  const executable = suffix ? command.slice(0, -suffix.length) : '';
  if (path.basename(executable) !== 'node') throw new Error(`Puerto ${port} ocupado por otro programa. No se modificó.`);
  if (suffix === ' server.js') {
    const cwd = read(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((line) => line.startsWith('n'))?.slice(1);
    if (!cwd || fs.realpathSync(cwd) !== root) throw new Error(`Puerto ${port} ocupado por otro proyecto. No se modificó.`);
  }
  return { pid };
};

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const agentPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(server)}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>${port}</string>
    <key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
const agentInstalled = () => fs.existsSync(plist);
const agentLoaded = () => {
  try { execFileSync(launchctl, ['print', `${domain}/${label}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const launch = (args) => {
  try { execFileSync(launchctl, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`launchctl ${args[0]} falló: ${String(error.stderr || error.message).trim()}`); }
};
const waitFor = async (check, failure) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await pause();
    const result = check();
    if (result) return result;
  }
  throw new Error(failure);
};
const autostart = async (mode) => {
  if (mode === 'on') {
    const current = instance();
    if (current && !agentLoaded()) throw new Error('devtower está iniciada fuera del autoarranque. Ejecutá down y repetí.');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    if (agentLoaded()) {
      launch(['bootout', `${domain}/${label}`]);
      await waitFor(() => !agentLoaded() && !instance(), 'launchd no liberó el servicio anterior. Repetí autostart:on.');
    }
    fs.writeFileSync(plist, agentPlist(), { mode: 0o644 });
    // right after a bootout launchd may still answer "Input/output error": retry a few times
    for (let attempt = 1; ; attempt += 1) {
      try { launch(['bootstrap', domain, plist]); break; }
      catch (error) { if (attempt >= 4) throw error; await new Promise((r) => setTimeout(r, 750 * attempt)); }
    }
    const started = await waitFor(instance, `Autoarranque instalado, pero devtower no respondió. Revisá ${log}`);
    console.log(`Autoarranque activado: devtower inicia al entrar a la sesión → http://localhost:${port} (PID ${started.pid})`);
    return;
  }
  if (mode === 'off') {
    if (agentLoaded()) launch(['bootout', `${domain}/${label}`]);
    fs.rmSync(plist, { force: true });
    await waitFor(() => !instance(), `El servidor todavía está terminando. Revisá ${log}`);
    console.log('Autoarranque desactivado y devtower detenida.');
    return;
  }
  throw new Error('Uso: npm run autostart:on | npm run autostart:off');
};

const up = async () => {
  const current = instance();
  if (current) { console.log(`devtower ya está iniciada → http://localhost:${port}`); return; }
  if (agentInstalled()) {
    launch(agentLoaded() ? ['kickstart', `${domain}/${label}`] : ['bootstrap', domain, plist]);
    const started = await waitFor(instance, `devtower no pudo iniciarse. Revisá ${log}`);
    console.log(`devtower iniciada → http://localhost:${port} (autoarranque, PID ${started.pid})`);
    return;
  }
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const output = fs.openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [server], { cwd: root, detached: true, stdio: ['ignore', output, output],
      env: { ...process.env, PORT: String(port) } });
  } finally { fs.closeSync(output); }
  let failure = null;
  child.on('error', (error) => { failure = error; });
  child.unref();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await pause();
      if (failure || child.exitCode !== null || child.signalCode !== null) break;
      const started = instance();
      if (started?.pid === child.pid) {
        console.log(`devtower iniciada → http://localhost:${port}\nLog: ${log}`);
        return;
      }
      if (started) throw new Error('Otra instancia arrancó al mismo tiempo. Volvé a ejecutar up.');
    }
    throw new Error(`devtower no pudo iniciarse. Revisá ${log}`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw error;
  }
};
const down = async () => {
  const current = instance();
  if (!current) { console.log('devtower ya está detenida.'); return; }
  if (read('pgrep', ['-P', String(current.pid)], true)) {
    throw new Error('devtower tiene tareas en curso. Esperá a que terminen o detenelas desde el chat y repetí down.');
  }
  if (instance()?.pid !== current.pid) throw new Error('La instancia cambió. Repetí down.');
  if (agentLoaded()) {
    launch(['bootout', `${domain}/${label}`]);
    await waitFor(() => !instance(), `El servidor todavía está terminando. Revisá ${log}`);
    console.log('devtower detenida hasta el próximo inicio de sesión (autoarranque sigue activo).');
    return;
  }
  process.kill(current.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await pause();
    const remaining = instance();
    if (!remaining) { console.log('devtower detenida.'); return; }
    if (remaining.pid !== current.pid) throw new Error('Se inició otra instancia. No se detuvo esa instancia.');
  }
  throw new Error(`El servidor todavía está terminando. Revisá ${log}`);
};
const main = async () => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe estar entre 1 y 65535.');
  const action = process.argv[2];
  if (action === 'up') return up();
  if (action === 'down') return down();
  if (action === 'autostart') return autostart(process.argv[3]);
  if (action === 'status') {
    const current = instance();
    const auto = agentInstalled() ? ' · autoarranque activo' : '';
    console.log(current ? `devtower iniciada → http://localhost:${port} (PID ${current.pid})${auto}` : `devtower detenida.${auto}`);
    return;
  }
  throw new Error('Uso: npm run up | npm run down | npm run status');
};
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
