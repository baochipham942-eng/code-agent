#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const tauriRoot = path.join(repoRoot, 'src-tauri');
const defaultApp = path.join(
  tauriRoot,
  'target/release/bundle/macos/Agent Neo Dev.app',
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function mergedDevResources() {
  const base = readJson('src-tauri/tauri.conf.json').bundle?.resources ?? {};
  const overlay = readJson('src-tauri/tauri.dev.conf.json').bundle?.resources ?? {};
  const merged = { ...base };
  for (const [source, target] of Object.entries(overlay)) {
    if (target === null) delete merged[source];
    else merged[source] = target;
  }
  return merged;
}

function copyResource(sourcePattern, target, resourcesRoot) {
  if (sourcePattern.includes('*')) {
    const matches = globSync(sourcePattern, { cwd: tauriRoot, dot: true, nodir: true });
    if (matches.length === 0) throw new Error(`Dev resource glob matched nothing: ${sourcePattern}`);
    for (const relativeSource of matches) {
      const source = path.resolve(tauriRoot, relativeSource);
      const destination = path.join(resourcesRoot, target, path.basename(source));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    return matches.length;
  }

  const source = path.resolve(tauriRoot, sourcePattern);
  if (!fs.existsSync(source)) throw new Error(`Dev resource source is missing: ${sourcePattern}`);
  const destination = path.join(resourcesRoot, target);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: true });
  return 1;
}

function resign(appPath) {
  const identity = process.env.SIGNING_IDENTITY || 'Code Agent Dev';
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const selectedIdentity = identities.includes(`\"${identity}\"`) ? identity : '-';
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--entitlements',
    path.join(tauriRoot, 'Entitlements.plist'),
    '--sign',
    selectedIdentity,
    appPath,
  ], { stdio: 'inherit' });
}

const appPath = path.resolve(process.argv[2] || defaultApp);
if (process.platform !== 'darwin') {
  console.log('[tauri-finalize-dev-bundle] skipped: macOS only');
  process.exit(0);
}
if (!fs.existsSync(appPath)) throw new Error(`Dev app bundle is missing: ${appPath}`);

const resourcesRoot = path.join(appPath, 'Contents/Resources');
let copied = 0;
for (const [source, target] of Object.entries(mergedDevResources())) {
  copied += copyResource(source, target, resourcesRoot);
}
resign(appPath);
console.log(`[tauri-finalize-dev-bundle] synchronized ${copied} declared resources and resigned ${appPath}`);
