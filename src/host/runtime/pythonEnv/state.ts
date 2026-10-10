import fs from 'fs';
import { unsupportedError } from './errors';
import {
  bundledRequirementsPath,
  hashFile,
  readyJsonPath,
  resolvePythonRoot,
  resolveResourceDir,
  venvPythonPath,
} from './layout';
import type {
  EnsurePythonEnvResult,
  PythonEnvLookupOptions,
  PythonEnvState,
  PythonRuntimeError,
  ReadyMarker,
} from './types';

const inflight = new Map<string, Promise<EnsurePythonEnvResult>>();
const progress = new Map<string, number>();
const lastError = new Map<string, PythonRuntimeError>();

export function getInflight(root: string): Promise<EnsurePythonEnvResult> | undefined {
  return inflight.get(root);
}

export function setInflight(root: string, promise: Promise<EnsurePythonEnvResult>): void {
  inflight.set(root, promise);
}

export function clearInflight(root: string): void {
  inflight.delete(root);
}

export function setInstallPercent(root: string, percent: number): void {
  progress.set(root, percent);
}

export function clearInstallPercent(root: string): void {
  progress.delete(root);
}

export function rememberError(root: string, error: PythonRuntimeError): void {
  lastError.set(root, error);
}

export function forgetError(root: string): void {
  lastError.delete(root);
}

function readReady(root: string): ReadyMarker | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(readyJsonPath(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<ReadyMarker>;
    if (typeof marker.pythonVersion !== 'string') return null;
    if (typeof marker.lockSha256 !== 'string') return null;
    if (typeof marker.indexUrl !== 'string') return null;
    if (typeof marker.installedAt !== 'string') return null;
    if (marker.pythonMirror !== null && typeof marker.pythonMirror !== 'string') return null;
    return {
      pythonVersion: marker.pythonVersion,
      lockSha256: marker.lockSha256,
      indexUrl: marker.indexUrl,
      pythonMirror: marker.pythonMirror ?? null,
      installedAt: marker.installedAt,
    };
  } catch {
    return null;
  }
}

function isInstalled(root: string, resourceDir?: string): boolean {
  if (!fs.existsSync(venvPythonPath(root))) return false;
  const ready = readReady(root);
  if (!ready) return false;
  try {
    const dir = resourceDir ?? resolveResourceDir();
    return ready.lockSha256 === hashFile(bundledRequirementsPath(dir));
  } catch {
    return false;
  }
}

export function getPythonEnvState(options: PythonEnvLookupOptions = {}): PythonEnvState {
  const root = resolvePythonRoot(options.dataDir);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return { phase: 'unsupported', root, pythonPath: null, error: unsupportedError(root) };
  }
  if (inflight.has(root)) {
    return { phase: 'installing', root, pythonPath: null, percent: progress.get(root) ?? 0 };
  }
  if (isInstalled(root, options.resourceDir)) {
    return { phase: 'installed', root, pythonPath: venvPythonPath(root) };
  }
  const error = lastError.get(root);
  if (error) return { phase: 'failed', root, pythonPath: null, error };
  return { phase: 'missing', root, pythonPath: null };
}

export function getManagedPythonPath(options: PythonEnvLookupOptions = {}): string | null {
  const state = getPythonEnvState(options);
  if (state.phase !== 'installed' || !state.pythonPath) return null;
  return state.pythonPath;
}
