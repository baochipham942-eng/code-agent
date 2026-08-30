import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginApprovalReceipt, PluginPermission } from './types';

const PLUGIN_APPROVAL_RECEIPT_FILE = '.neo-capability-approval.json';

const RECEIPT_SCHEMA_VERSION = 1;

async function collectFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === PLUGIN_APPROVAL_RECEIPT_FILE) continue;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`能力包包含符号链接，已拒绝：${path.relative(rootDir, absolutePath)}`);
    }
    if (entry.isDirectory()) files.push(...await collectFiles(rootDir, absolutePath));
    else if (entry.isFile()) files.push(path.relative(rootDir, absolutePath));
  }
  return files;
}

export async function hashPluginPackage(rootDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of await collectFiles(rootDir)) {
    hash.update(relativePath.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await fs.readFile(path.join(rootDir, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function writePluginApprovalReceipt(
  rootDir: string,
  input: Omit<PluginApprovalReceipt, 'schemaVersion'>,
): Promise<PluginApprovalReceipt> {
  const receipt: PluginApprovalReceipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, ...input };
  await fs.writeFile(
    path.join(rootDir, PLUGIN_APPROVAL_RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return receipt;
}

function isPermissionList(value: unknown): value is PluginPermission[] {
  return Array.isArray(value) && value.every((item) => (
    item === 'filesystem'
    || item === 'network'
    || item === 'shell'
    || item === 'clipboard'
    || item === 'notification'
    || item === 'storage'
  ));
}

function parseReceipt(value: unknown): PluginApprovalReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || typeof record.pluginId !== 'string'
    || typeof record.packageHash !== 'string'
    || !isPermissionList(record.permissions)
    || typeof record.sandboxValidatedAt !== 'number'
    || typeof record.approvedAt !== 'number'
  ) return null;
  return record as unknown as PluginApprovalReceipt;
}

export async function verifyPluginApprovalReceipt(
  rootDir: string,
  pluginId: string,
  permissions: readonly PluginPermission[],
): Promise<PluginApprovalReceipt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(rootDir, PLUGIN_APPROVAL_RECEIPT_FILE), 'utf8')) as unknown;
  } catch {
    throw new Error('能力包缺少安装审批凭据，请从能力中心导入');
  }
  const receipt = parseReceipt(parsed);
  if (receipt?.pluginId !== pluginId) {
    throw new Error('能力包安装审批凭据无效，请重新导入');
  }
  if (JSON.stringify([...permissions].sort()) !== JSON.stringify([...receipt.permissions].sort())) {
    throw new Error('能力包权限声明已变化，请重新导入并确认');
  }
  const currentHash = await hashPluginPackage(rootDir);
  if (currentHash !== receipt.packageHash) {
    throw new Error('能力包内容在审批后发生变化，请重新导入');
  }
  return receipt;
}
