import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../platform';

const REVOCATION_FILE = 'plugin-package-revocations.json';

interface PluginPackageRevocationSnapshot {
  schemaVersion: 1;
  revokedIds: string[];
  sourceContentHash: string;
  updatedAt: string;
}

let currentSnapshot: PluginPackageRevocationSnapshot | undefined;

function defaultRevocationFile(): string {
  return path.join(app.getPath('userData'), REVOCATION_FILE);
}

function parseSnapshot(value: unknown): PluginPackageRevocationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || !Array.isArray(record.revokedIds)
    || !record.revokedIds.every((item) => typeof item === 'string' && item.trim().length > 0)
    || typeof record.sourceContentHash !== 'string'
    || typeof record.updatedAt !== 'string'
  ) return null;
  return {
    schemaVersion: 1,
    revokedIds: [...new Set(record.revokedIds)].sort(),
    sourceContentHash: record.sourceContentHash,
    updatedAt: record.updatedAt,
  };
}

export async function updatePluginPackageRevocations(
  revokedIds: readonly string[],
  sourceContentHash: string,
  options: { filePath?: string; now?: number } = {},
): Promise<void> {
  const snapshot: PluginPackageRevocationSnapshot = {
    schemaVersion: 1,
    revokedIds: [...new Set(revokedIds.filter((item) => item.trim().length > 0))].sort(),
    sourceContentHash,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  currentSnapshot = snapshot;
  const filePath = options.filePath ?? defaultRevocationFile();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

export async function readPluginPackageRevocations(filePath?: string): Promise<ReadonlySet<string>> {
  if (currentSnapshot && !filePath) return new Set(currentSnapshot.revokedIds);
  try {
    const parsed = parseSnapshot(JSON.parse(await fs.readFile(filePath ?? defaultRevocationFile(), 'utf8')) as unknown);
    if (!parsed) return new Set();
    if (!filePath) currentSnapshot = parsed;
    return new Set(parsed.revokedIds);
  } catch {
    return new Set();
  }
}
