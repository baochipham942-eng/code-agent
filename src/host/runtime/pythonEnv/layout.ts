import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUserConfigDir } from '../../config/configPaths';
import { resolveExistingResource } from '../runtimeAssetResolver';
import { PROJECT_FILES } from './constants';

const moduleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

export function resolvePythonRoot(dataDir?: string): string {
  // getUserConfigDir reads CODE_AGENT_DATA_DIR on every call. getUserDataPath caches
  // the first value, so a later test dir would stick. The manifest asset store is
  // `<dataDir>/runtime`; this tree is `<dataDir>/runtimes/python` on purpose.
  const explicit = dataDir?.trim();
  const base = explicit ? explicit : getUserConfigDir();
  return path.resolve(base, 'runtimes', 'python');
}

export function resolveResourceDir(explicit?: string): string {
  const given = explicit?.trim();
  if (given) return path.resolve(given);
  const bundled = resolveExistingResource('python-runtime');
  if (bundled) return bundled;
  return path.resolve(moduleDir, '../../../../resources/python-runtime');
}

export function venvDir(root: string): string {
  return path.join(root, 'venv');
}

export function venvPythonPath(root: string): string {
  return path.join(venvDir(root), 'bin', 'python');
}

export function projectDir(root: string): string {
  return path.join(root, 'project');
}

export function readyJsonPath(root: string): string {
  return path.join(root, 'ready.json');
}

export function installLogPath(root: string): string {
  return path.join(root, 'install.log');
}

export function bundledRequirementsPath(resourceDir: string): string {
  return path.join(resourceDir, 'requirements.lock.txt');
}

export function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function copyProjectFiles(resourceDir: string, root: string): void {
  const destination = projectDir(root);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of PROJECT_FILES) {
    fs.copyFileSync(path.join(resourceDir, name), path.join(destination, name));
  }
}
