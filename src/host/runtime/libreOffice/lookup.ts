import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { LIBREOFFICE_PATH_ENV, LIBREOFFICE_SEARCH_PATHS } from '../../tools/media/ppt/constants';
import { managedLibreOfficePath, resolveLibreOfficeRoot } from './layout';
import type { LibreOfficeLookupOptions } from './types';

function whichSync(binary: string): string | null {
  try {
    const resolved = execFileSync('which', [binary], { encoding: 'utf8' }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function getManagedLibreOfficePath(dataDir?: string): string {
  return managedLibreOfficePath(resolveLibreOfficeRoot(dataDir));
}

/** One ordered list shared by availability and path resolution. */
export function getLibreOfficeCandidates(options: LibreOfficeLookupOptions = {}): string[] {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const which = options.which ?? whichSync;
  const candidates: string[] = [];
  const envPath = env[LIBREOFFICE_PATH_ENV]?.trim();
  if (envPath && existsSync(envPath)) candidates.push(path.resolve(envPath));
  const managed = getManagedLibreOfficePath(options.dataDir);
  if (existsSync(managed)) candidates.push(managed);
  for (const candidate of LIBREOFFICE_SEARCH_PATHS) {
    if (existsSync(candidate)) candidates.push(candidate);
  }
  const soffice = which('soffice');
  if (soffice) candidates.push(soffice);
  const libreoffice = which('libreoffice');
  if (libreoffice) candidates.push(libreoffice);
  return [...new Set(candidates)];
}

export function findLibreOfficePath(options: LibreOfficeLookupOptions = {}): string | null {
  return getLibreOfficeCandidates(options)[0] ?? null;
}
