import fs from 'fs';
import { getLibreOfficeCandidates } from './lookup';
import { managedLibreOfficePath, readyJsonPath, resolveLibreOfficeRoot } from './layout';
import { unsupportedError } from './errors';
import type {
  EnsureLibreOfficeResult,
  LibreOfficeLookupOptions,
  LibreOfficeReadyMarker,
  LibreOfficeRuntimeError,
  LibreOfficeState,
} from './types';

const inflight = new Map<string, Promise<EnsureLibreOfficeResult>>();
const progress = new Map<string, number>();
const lastError = new Map<string, LibreOfficeRuntimeError>();

export function getInflight(root: string): Promise<EnsureLibreOfficeResult> | undefined {
  return inflight.get(root);
}

export function setInflight(root: string, promise: Promise<EnsureLibreOfficeResult>): void {
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

export function rememberError(root: string, error: LibreOfficeRuntimeError): void {
  lastError.set(root, error);
}

export function forgetError(root: string): void {
  lastError.delete(root);
}

function readReady(root: string): LibreOfficeReadyMarker | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(readyJsonPath(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<LibreOfficeReadyMarker>;
    if (typeof marker.version !== 'string' || typeof marker.arch !== 'string') return null;
    if (typeof marker.sha256 !== 'string' || typeof marker.sourceUrl !== 'string') return null;
    if (typeof marker.installedAt !== 'string') return null;
    return marker as LibreOfficeReadyMarker;
  } catch {
    return null;
  }
}

export function isManagedLibreOfficeInstalled(root: string): boolean {
  return Boolean(readReady(root) && fs.existsSync(managedLibreOfficePath(root)));
}

export function getLibreOfficeState(options: LibreOfficeLookupOptions = {}): LibreOfficeState {
  const root = resolveLibreOfficeRoot(options.dataDir);
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { phase: 'unsupported', root, sofficePath: null, error: unsupportedError(root) };
  }
  const running = inflight.get(root);
  if (running) {
    return { phase: 'installing', root, sofficePath: null, percent: progress.get(root) ?? 0 };
  }
  if (isManagedLibreOfficeInstalled(root)) {
    return { phase: 'installed', root, sofficePath: managedLibreOfficePath(root) };
  }
  const systemPath = getLibreOfficeCandidates(options)[0];
  if (systemPath) return { phase: 'installed', root, sofficePath: systemPath };
  const error = lastError.get(root);
  if (error) return { phase: 'failed', root, sofficePath: null, error };
  return { phase: 'missing', root, sofficePath: null };
}
