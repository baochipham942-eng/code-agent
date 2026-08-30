import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NEW } from '../../../../shared/constants/configDir';
import {
  COMPUTER_USE_CAPABILITY_ID,
  type BuiltinCapabilityId,
} from '../builtinCapabilityIds';

export type ComputerUseCapabilityExplicitState = 'installed' | 'removed' | 'missing' | 'invalid';

interface ComputerUseCapabilityStateFile {
  schemaVersion: 1;
  state: 'installed' | 'removed';
  updatedAt: number;
  migration?: 'legacy-env';
}

const STATE_FILENAMES: Record<BuiltinCapabilityId, string> = {
  'builtin.imageProcess': 'image-process.json',
  'builtin.audioProcessing': 'audio-processing.json',
  'builtin.videoGeneration': 'video-generation.json',
  'builtin.imageCreation': 'image-creation.json',
  'builtin.musicGeneration': 'music-generation.json',
  'builtin.browserControl': 'browser-control.json',
  'builtin.computerUse': 'computer-use.json',
  'builtin.photoArchive': 'photo-archive.json',
};

function statePath(
  pluginId: BuiltinCapabilityId,
  dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), CONFIG_DIR_NEW),
): string {
  return path.join(dataDir, 'capabilities', STATE_FILENAMES[pluginId]);
}

function parseState(raw: string): ComputerUseCapabilityExplicitState {
  try {
    const parsed = JSON.parse(raw) as Partial<ComputerUseCapabilityStateFile>;
    if (parsed.schemaVersion !== 1) return 'invalid';
    return parsed.state === 'installed' || parsed.state === 'removed' ? parsed.state : 'invalid';
  } catch {
    return 'invalid';
  }
}

function readBuiltinCapabilityStateSync(
  pluginId: BuiltinCapabilityId,
  dataDir?: string,
): ComputerUseCapabilityExplicitState {
  try {
    return parseState(fs.readFileSync(statePath(pluginId, dataDir), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

async function readComputerUseCapabilityState(
  dataDir?: string,
): Promise<ComputerUseCapabilityExplicitState> {
  return readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, dataDir);
}

export async function readBuiltinCapabilityState(
  pluginId: BuiltinCapabilityId,
  dataDir?: string,
): Promise<ComputerUseCapabilityExplicitState> {
  try {
    return parseState(await fsPromises.readFile(statePath(pluginId, dataDir), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

export function isComputerUseCapabilityInstalledSync(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): boolean {
  return isBuiltinCapabilityInstalledSync(COMPUTER_USE_CAPABILITY_ID, env, dataDir);
}

export function isBuiltinCapabilityInstalledSync(
  pluginId: BuiltinCapabilityId,
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): boolean {
  const explicit = readBuiltinCapabilityStateSync(
    pluginId,
    dataDir ?? (env.CODE_AGENT_DATA_DIR?.trim() || undefined),
  );
  if (explicit === 'installed') return true;
  if (explicit !== 'missing') return false;
  if (pluginId === COMPUTER_USE_CAPABILITY_ID) return env.CODE_AGENT_ENABLE_CUA === '1';
  return true;
}

async function writeComputerUseCapabilityState(
  next: 'installed' | 'removed' | 'missing',
  options: { dataDir?: string; migration?: 'legacy-env' } = {},
): Promise<void> {
  return writeBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, next, options);
}

export async function writeBuiltinCapabilityState(
  pluginId: BuiltinCapabilityId,
  next: 'installed' | 'removed' | 'missing',
  options: { dataDir?: string; migration?: 'legacy-env' } = {},
): Promise<void> {
  const target = statePath(pluginId, options.dataDir);
  if (next === 'missing') {
    await fsPromises.rm(target, { force: true });
    return;
  }

  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  const payload: ComputerUseCapabilityStateFile = {
    schemaVersion: 1,
    state: next,
    updatedAt: Date.now(),
    ...(options.migration ? { migration: options.migration } : {}),
  };
  try {
    await fsPromises.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsPromises.rename(temp, target);
  } finally {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function migrateLegacyComputerUseEnv(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): Promise<boolean> {
  const resolvedDataDir = dataDir ?? (env.CODE_AGENT_DATA_DIR?.trim() || undefined);
  const explicit = await readComputerUseCapabilityState(resolvedDataDir);
  if (explicit === 'installed') return true;
  if (explicit !== 'missing' || env.CODE_AGENT_ENABLE_CUA !== '1') return false;
  await writeComputerUseCapabilityState('installed', { dataDir: resolvedDataDir, migration: 'legacy-env' });
  return true;
}
