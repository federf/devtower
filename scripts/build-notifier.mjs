// Builds build/devtower-notifier.app from native/notifier/main.swift with the tools macOS already
// has (swiftc from the Command Line Tools, codesign, iconutil, lsregister). No packages.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const NOTIFIER_APP = path.join(ROOT, 'build', 'devtower-notifier.app');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.devtower.notifier</string>
  <key>CFBundleName</key><string>devtower</string>
  <key>CFBundleDisplayName</key><string>devtower</string>
  <key>CFBundleExecutable</key><string>devtower-notifier</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;

// app icon from public/devtower.svg via Quick Look thumbnails; skipped if it fails (generic icon)
const buildIcon = (resources) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devtower-icon-'));
  try {
    execFileSync('qlmanage', ['-t', '-s', '1024', '-o', tmp, path.join(ROOT, 'public', 'devtower.svg')], { stdio: 'ignore' });
    const png = path.join(tmp, 'devtower.svg.png');
    const set = path.join(tmp, 'AppIcon.iconset');
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
      execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(resources, 'AppIcon.icns')], { stdio: 'ignore' });
  } catch { /* generic icon */ } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
};

export const buildNotifier = () => {
  if (process.platform !== 'darwin') throw new Error('El notificador nativo solo existe en macOS');
  const contents = path.join(NOTIFIER_APP, 'Contents');
  fs.rmSync(NOTIFIER_APP, { recursive: true, force: true });
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  buildIcon(path.join(contents, 'Resources'));
  try {
    // explicit target: the toolchain default can be newer than the running macOS (LaunchServices refuses it)
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos11.0`;
    execFileSync('xcrun', ['swiftc', '-O', '-target', target, path.join(ROOT, 'native', 'notifier', 'main.swift'), '-o', path.join(contents, 'MacOS', 'devtower-notifier')], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`No se pudo compilar (¿faltan las Command Line Tools? xcode-select --install)\n${String(error.stderr || error.message).trim()}`);
  }
  // ad-hoc signature: notifications need a signed bundle; lsregister lets a click relaunch it
  execFileSync('codesign', ['--force', '--sign', '-', NOTIFIER_APP], { stdio: 'ignore' });
  try { execFileSync(LSREGISTER, ['-f', NOTIFIER_APP], { stdio: 'ignore' }); } catch { /* registered on first run anyway */ }
  return NOTIFIER_APP;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(`devtower-notifier → ${buildNotifier()}`); } catch (error) { console.error(error.message); process.exit(1); }
}
