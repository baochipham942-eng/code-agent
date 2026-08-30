import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BundledHostCapabilityId,
  BundledHostCapabilityState,
} from '../../../shared/contract/bundledHostCapability';

export type BundledHostCapabilityInstallPhase = 'staged' | 'installed' | 'removed';

export interface BundledHostCapabilityInstallRecord {
  schemaVersion: 1;
  state: BundledHostCapabilityInstallPhase;
  version: string;
  revision: number;
  updatedAt: number;
}

export interface BundledHostCapabilityInstallSnapshot {
  record: BundledHostCapabilityInstallRecord | null;
}

const FILE_NAMES: Record<BundledHostCapabilityId, string> = {
  'builtin.voice-live': 'voice-live.json',
  'builtin.voice-input': 'voice-input.json',
};

function statePath(dataDir: string, id: BundledHostCapabilityId): string {
  return path.join(dataDir, 'capabilities', FILE_NAMES[id]);
}

function parseRecord(raw: string): BundledHostCapabilityInstallRecord {
  const parsed = JSON.parse(raw) as Partial<BundledHostCapabilityInstallRecord>;
  if (
    parsed.schemaVersion !== 1
    || !['staged', 'installed', 'removed'].includes(parsed.state ?? '')
    || typeof parsed.version !== 'string'
    || !Number.isSafeInteger(parsed.revision)
    || (parsed.revision ?? -1) < 0
    || typeof parsed.updatedAt !== 'number'
  ) {
    throw new Error('invalid bundled host capability install state');
  }
  return parsed as BundledHostCapabilityInstallRecord;
}

export async function readBundledHostCapabilityInstallSnapshot(
  dataDir: string,
  id: BundledHostCapabilityId,
): Promise<BundledHostCapabilityInstallSnapshot> {
  try {
    return { record: parseRecord(await fs.readFile(statePath(dataDir, id), 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null };
    throw error;
  }
}

export async function writeBundledHostCapabilityInstallState(
  dataDir: string,
  id: BundledHostCapabilityId,
  state: BundledHostCapabilityInstallPhase,
  version: string,
  revision: number,
): Promise<BundledHostCapabilityInstallRecord> {
  const target = statePath(dataDir, id);
  const record: BundledHostCapabilityInstallRecord = {
    schemaVersion: 1,
    state,
    version,
    revision,
    updatedAt: Date.now(),
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  return record;
}

export async function restoreBundledHostCapabilityInstallSnapshot(
  dataDir: string,
  id: BundledHostCapabilityId,
  snapshot: BundledHostCapabilityInstallSnapshot,
): Promise<void> {
  const target = statePath(dataDir, id);
  if (!snapshot.record) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.restore.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(snapshot.record, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export function projectBundledHostCapabilityState(
  id: BundledHostCapabilityId,
  version: string,
  snapshot: BundledHostCapabilityInstallSnapshot,
): BundledHostCapabilityState {
  return {
    id,
    installed: snapshot.record?.state === 'installed' || snapshot.record === null,
    version: snapshot.record?.version ?? version,
    revision: snapshot.record?.revision ?? 0,
  };
}
