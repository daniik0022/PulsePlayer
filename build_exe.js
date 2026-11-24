const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const ELECTRON_DIST = path.join(ROOT_DIR, 'node_modules', 'electron', 'dist');
const targetFolder = process.argv[2] || (fs.existsSync(path.join(ROOT_DIR, 'build', 'PulsePlayer', 'PulsePlayer.exe')) ? 'PulsePlayer_Standalone' : 'PulsePlayer');
const OUTPUT_DIR = path.join(ROOT_DIR, 'build', targetFolder);
const APP_DEST = path.join(OUTPUT_DIR, 'resources', 'app');

console.log('[BUILD] Starting packaging for PulsePlayer Windows x64...');

if (!fs.existsSync(ELECTRON_DIST)) {
  console.error('[BUILD ERROR] Electron dist not found at:', ELECTRON_DIST);
  process.exit(1);
}

// 1. Clean or create output directory
if (fs.existsSync(OUTPUT_DIR)) {
  console.log('[BUILD] Cleaning previous build...');
  try {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn('[BUILD] Could not clean full output dir (app may be running), updating files in-place...');
  }
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 2. Copy Electron runtime files
console.log('[BUILD] Copying Electron binaries...');
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

for (const item of fs.readdirSync(ELECTRON_DIST)) {
  const srcPath = path.join(ELECTRON_DIST, item);
  const destPath = path.join(OUTPUT_DIR, item);
  copyRecursive(srcPath, destPath);
}

// 3. Rename executable
const oldExe = path.join(OUTPUT_DIR, 'electron.exe');
const newExe = path.join(OUTPUT_DIR, 'PulsePlayer.exe');
if (fs.existsSync(oldExe)) {
  fs.renameSync(oldExe, newExe);
  console.log('[BUILD] Renamed executable -> PulsePlayer.exe');
}

// 4. Remove default_app.asar
const defaultAsar = path.join(OUTPUT_DIR, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) {
  fs.unlinkSync(defaultAsar);
}

// 5. Copy app bundle into resources/app
console.log('[BUILD] Copying application assets into resources/app...');
fs.mkdirSync(APP_DEST, { recursive: true });

const filesToCopy = ['package.json', 'main.js', 'preload.js', 'discordRpc.js', 'lastFm.js', 'favorites_backup.json'];
for (const file of filesToCopy) {
  const src = path.join(ROOT_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(APP_DEST, file));
  }
}

// Copy src folder
copyRecursive(path.join(ROOT_DIR, 'src'), path.join(APP_DEST, 'src'));

// Copy node_modules (excluding electron)
console.log('[BUILD] Copying runtime node_modules...');
const srcNodeModules = path.join(ROOT_DIR, 'node_modules');
const destNodeModules = path.join(APP_DEST, 'node_modules');
fs.mkdirSync(destNodeModules, { recursive: true });

for (const mod of fs.readdirSync(srcNodeModules)) {
  if (mod === 'electron' || mod === '.bin' || mod === '.package-lock.json') continue;
  copyRecursive(path.join(srcNodeModules, mod), path.join(destNodeModules, mod));
}

// 6. Create quick launcher .bat for convenience
const batContent = `@echo off\r\nstart "" "%~dp0PulsePlayer.exe"\r\nexit\r\n`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'Запустить PulsePlayer.bat'), batContent, 'utf8');

console.log('[BUILD SUCCESS]');
console.log('[OUTPUT DIRECTORY]:', OUTPUT_DIR);
console.log('[EXECUTABLE]:', newExe);
