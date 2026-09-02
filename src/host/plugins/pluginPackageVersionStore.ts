import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PluginActivationMode,
  PluginPackageApprovalState,
} from '../../shared/contract/capabilityPackage';
import { hashPluginPackage } from './pluginApprovalReceipt';
import type { PluginPackageSourceTrust } from './pluginPackageTrust';
import type { PluginManifest } from './types';

const STATE_FILE = '.neo-plugin-versions.json';
const PACKAGES_DIR = 'packages';
const STATE_SCHEMA_VERSION = 1;

interface StoredPluginPackage {
  packageId: string;
  version: string;
  packageHash: string;
  approval: PluginPackageApprovalState;
  addedAt: number;
  sourceTrust: PluginPackageSourceTrust;
}

interface PluginPackageRunRecord {
  pluginRunId: string;
  packageId: string;
  mode: PluginActivationMode;
  status: 'activating' | 'awaiting-client' | 'succeeded' | 'failed';
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface PluginVersionState {
  schemaVersion: 1;
  pluginId: string;
  packages: Record<string, StoredPluginPackage>;
  currentPackageId?: string;
  nextPackageId?: string;
  runningPackageId?: string;
  approveFutureVersions: boolean;
  lastRun?: PluginPackageRunRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredPackage(value: unknown): value is StoredPluginPackage {
  if (!isRecord(value)) return false;
  return typeof value.packageId === 'string'
    && typeof value.version === 'string'
    && typeof value.packageHash === 'string'
    && (value.approval === 'pending' || value.approval === 'approved' || value.approval === 'denied')
    && typeof value.addedAt === 'number'
    && isRecord(value.sourceTrust)
    && (value.sourceTrust.level === 'signed' || value.sourceTrust.level === 'unsigned')
    && typeof value.sourceTrust.reason === 'string';
}

function parseState(value: unknown, pluginId: string): PluginVersionState | null {
  if (!isRecord(value)
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || value.pluginId !== pluginId
    || !isRecord(value.packages)
    || typeof value.approveFutureVersions !== 'boolean') return null;
  if (!Object.values(value.packages).every(isStoredPackage)) return null;
  return value as unknown as PluginVersionState;
}

function pluginPackageId(version: string, packageHash: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/gu, '_');
  return `${safeVersion}-${packageHash.slice(0, 16).toLowerCase()}`;
}

export function pluginPackageRoot(pluginRoot: string, packageId: string): string {
  return path.join(pluginRoot, PACKAGES_DIR, packageId);
}

export function activationMode(
  currentPackageId: string | undefined,
  targetPackageId: string,
): PluginActivationMode {
  return !currentPackageId || currentPackageId === targetPackageId ? 'run' : 'update';
}

export async function readPluginVersionState(pluginRoot: string): Promise<PluginVersionState | null> {
  const pluginId = path.basename(pluginRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(pluginRoot, STATE_FILE), 'utf8')) as unknown;
    const state = parseState(parsed, pluginId);
    if (!state) throw new Error('插件版本记录无效');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writePluginVersionState(
  pluginRoot: string,
  state: PluginVersionState,
): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  const temporary = path.join(pluginRoot, `${STATE_FILE}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, path.join(pluginRoot, STATE_FILE));
}

async function createPluginVersionState(
  pluginRoot: string,
  pluginId: string,
): Promise<PluginVersionState> {
  const existing = await readPluginVersionState(pluginRoot);
  if (existing) return existing;
  const state: PluginVersionState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    pluginId,
    packages: {},
    approveFutureVersions: false,
  };
  await writePluginVersionState(pluginRoot, state);
  return state;
}

export async function storeImmutablePluginPackage(
  pluginRoot: string,
  sourceRoot: string,
  input: {
    manifest: PluginManifest;
    packageHash: string;
    sourceTrust: PluginPackageSourceTrust;
    approval: PluginPackageApprovalState;
    now: number;
  },
): Promise<{ packageId: string; packageRoot: string; state: PluginVersionState }> {
  const state = await createPluginVersionState(pluginRoot, input.manifest.id);
  const packageId = pluginPackageId(input.manifest.version, input.packageHash);
  const packageRoot = pluginPackageRoot(pluginRoot, packageId);
  const existing = state.packages[packageId];
  if (existing) {
    const existingHash = await hashPluginPackage(packageRoot);
    if (existingHash !== input.packageHash) {
      throw new Error('已有版本的内容与记录不一致，已拒绝覆盖');
    }
    return { packageId, packageRoot, state };
  }

  const packagesRoot = path.join(pluginRoot, PACKAGES_DIR);
  await fs.mkdir(packagesRoot, { recursive: true });
  const temporary = path.join(packagesRoot, `.install-${packageId}-${randomUUID()}`);
  try {
    await fs.cp(sourceRoot, temporary, { recursive: true, errorOnExist: true, force: false });
    const copiedHash = await hashPluginPackage(temporary);
    if (copiedHash !== input.packageHash) throw new Error('插件在保存前发生变化，请重新导入');
    await fs.rename(temporary, packageRoot);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  state.packages[packageId] = {
    packageId,
    version: input.manifest.version,
    packageHash: input.packageHash,
    approval: input.approval,
    addedAt: input.now,
    sourceTrust: input.sourceTrust,
  };
  await writePluginVersionState(pluginRoot, state);
  return { packageId, packageRoot, state };
}

export async function migrateLegacyPluginDirectory(
  pluginRoot: string,
  manifest: PluginManifest,
  input: {
    packageHash: string;
    sourceTrust: PluginPackageSourceTrust;
    now: number;
  },
): Promise<PluginVersionState> {
  const existing = await readPluginVersionState(pluginRoot);
  if (existing) return existing;

  const parent = path.dirname(pluginRoot);
  const packageId = pluginPackageId(manifest.version, input.packageHash);
  const temporaryRoot = path.join(parent, `.migrate-${manifest.id}-${randomUUID()}`);
  const backupRoot = path.join(parent, `.legacy-${manifest.id}-${randomUUID()}`);
  const packageRoot = pluginPackageRoot(temporaryRoot, packageId);
  const state: PluginVersionState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    pluginId: manifest.id,
    packages: {
      [packageId]: {
        packageId,
        version: manifest.version,
        packageHash: input.packageHash,
        approval: 'approved',
        addedAt: input.now,
        sourceTrust: input.sourceTrust,
      },
    },
    currentPackageId: packageId,
    runningPackageId: packageId,
    approveFutureVersions: false,
  };

  let legacyMoved = false;
  try {
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.cp(pluginRoot, packageRoot, { recursive: true, errorOnExist: true, force: false });
    await writePluginVersionState(temporaryRoot, state);
    await fs.rename(pluginRoot, backupRoot);
    legacyMoved = true;
    await fs.rename(temporaryRoot, pluginRoot);
    await fs.rm(backupRoot, { recursive: true, force: true });
    return state;
  } catch (error) {
    if (legacyMoved) {
      await fs.rm(pluginRoot, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(backupRoot, pluginRoot).catch(() => undefined);
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('旧插件迁移失败，已保留原目录', { cause: error });
  }
}

export async function listPluginVersionStates(
  pluginsDir: string,
): Promise<Array<{ pluginRoot: string; state: PluginVersionState }>> {
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true }).catch(() => []);
  const result: Array<{ pluginRoot: string; state: PluginVersionState }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginRoot = path.join(pluginsDir, entry.name);
    const state = await readPluginVersionState(pluginRoot);
    if (state) result.push({ pluginRoot, state });
  }
  return result;
}

export async function resolveStoredPluginRunDirectory(pluginRoot: string): Promise<string | null> {
  const state = await readPluginVersionState(pluginRoot);
  if (!state) return pluginRoot;
  const packageId = state.runningPackageId;
  return packageId ? pluginPackageRoot(pluginRoot, packageId) : null;
}
