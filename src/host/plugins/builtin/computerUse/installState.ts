import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NEW } from '../../../../shared/constants/configDir';

export const COMPUTER_USE_CAPABILITY_ID = 'builtin.computerUse';

export type ComputerUseCapabilityExplicitState = 'installed' | 'removed' | 'missing' | 'invalid';

interface ComputerUseCapabilityStateFile {
  schemaVersion: 1;
  state: 'installed' | 'removed';
  updatedAt: number;
  migration?: 'legacy-env';
}

function statePath(
  dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), CONFIG_DIR_NEW),
): string {
  return path.join(dataDir, 'capabilities', 'computer-use.json');
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

function readComputerUseCapabilityStateSync(
  dataDir?: string,
): ComputerUseCapabilityExplicitState {
  try {
    return parseState(fs.readFileSync(statePath(dataDir), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

export async function readComputerUseCapabilityState(
  dataDir?: string,
): Promise<ComputerUseCapabilityExplicitState> {
  try {
    return parseState(await fsPromises.readFile(statePath(dataDir), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

export function isComputerUseCapabilityInstalledSync(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): boolean {
  const explicit = readComputerUseCapabilityStateSync(dataDir ?? (env.CODE_AGENT_DATA_DIR?.trim() || undefined));
  if (explicit === 'installed') return true;
  if (explicit !== 'missing') return false;
  return env.CODE_AGENT_ENABLE_CUA === '1';
}

export async function writeComputerUseCapabilityState(
  next: 'installed' | 'removed' | 'missing',
  options: { dataDir?: string; migration?: 'legacy-env' } = {},
): Promise<void> {
  const target = statePath(options.dataDir);
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
