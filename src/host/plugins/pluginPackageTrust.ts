import fs from 'node:fs/promises';
import path from 'node:path';
import type { ControlPlanePublicKeys } from '../services/cloud/controlPlaneTrust';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from '../services/cloud/controlPlaneTrust';
import {
  hashPluginPackage,
  PLUGIN_PACKAGE_SIGNATURE_FILE,
  verifyPluginApprovalReceipt,
} from './pluginApprovalReceipt';
import { readPluginPackageRevocations } from './pluginPackageRevocationStore';
import type { UiSlotName } from '../../shared/contract/uiSlots';
import type { PluginManifest } from './types';

interface PluginPackageSignaturePayload {
  schemaVersion: 1;
  pluginId: string;
  packageHash: string;
}

export interface PluginPackageSourceTrust {
  level: 'signed' | 'unsigned';
  reason: string;
  keyId?: string;
}

interface PluginPackageTrustOptions {
  packageHash?: string;
  publicKeys?: ControlPlanePublicKeys;
  now?: number;
  revokedIds?: ReadonlySet<string>;
  revocationFile?: string;
}

const UNSIGNED_UI_SLOTS = new Set<UiSlotName>([
  'workspace.page',
  'settings.section',
]);

function isSignaturePayload(value: unknown): value is PluginPackageSignaturePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.pluginId === 'string'
    && typeof record.packageHash === 'string'
    && /^[a-f0-9]{64}$/i.test(record.packageHash);
}

function assertUiSlotAdmission(slots: readonly UiSlotName[], source: 'signed' | 'unsigned'): void {
  if (source === 'signed') return;
  const denied = slots.find((slot) => !UNSIGNED_UI_SLOTS.has(slot));
  if (denied) {
    throw new Error(
      `这个插件的来源未经验证，不能挂到 ${denied}；手工导入的未签名插件只能使用 workspace.page 或 settings.section`,
    );
  }
}

function isRevoked(revokedIds: ReadonlySet<string>, pluginId: string, keyId: string): boolean {
  return revokedIds.has(pluginId)
    || revokedIds.has(`plugin:${pluginId}`)
    || revokedIds.has(`plugin-key:${keyId}`);
}

export async function assessPluginPackageTrust(
  rootDir: string,
  manifest: Pick<PluginManifest, 'id' | 'uiSlots'>,
  options: PluginPackageTrustOptions = {},
): Promise<PluginPackageSourceTrust> {
  const packageHash = options.packageHash ?? await hashPluginPackage(rootDir);
  let envelope: unknown;
  try {
    envelope = JSON.parse(
      await fs.readFile(path.join(rootDir, PLUGIN_PACKAGE_SIGNATURE_FILE), 'utf8'),
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('插件签名文件无效，无法确认发布来源，请从插件市场重新下载', { cause: error });
    }
    assertUiSlotAdmission(manifest.uiSlots ?? [], 'unsigned');
    return {
      level: 'unsigned',
      reason: '插件包没有签名，来源未经验证',
    };
  }

  const trust = verifyControlPlaneEnvelope<PluginPackageSignaturePayload>(envelope, {
    kind: 'plugin_package',
    publicKeys: options.publicKeys ?? getControlPlanePublicKeysFromEnv(),
    requireSignature: true,
    now: options.now,
  });
  if (!trust.trusted || !isSignaturePayload(trust.payload) || !trust.keyId) {
    throw new Error('插件签名无效，无法确认发布来源，请从插件市场重新下载', {
      cause: new Error(trust.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')),
    });
  }
  if (trust.payload.pluginId !== manifest.id) {
    throw new Error('插件签名与插件身份不一致，请从插件市场重新下载');
  }
  if (trust.payload.packageHash.toLowerCase() !== packageHash.toLowerCase()) {
    throw new Error('插件内容与签名不一致，可能已被篡改，请从插件市场重新下载');
  }
  const revokedIds = options.revokedIds
    ?? await readPluginPackageRevocations(options.revocationFile);
  if (isRevoked(revokedIds, manifest.id, trust.keyId)) {
    throw new Error('这个插件的发布者已被吊销，插件已停止装载，请联系管理员');
  }
  assertUiSlotAdmission(manifest.uiSlots ?? [], 'signed');
  return {
    level: 'signed',
    reason: '插件包签名已验证，发布来源可追溯并可通过控制面吊销',
    keyId: trust.keyId,
  };
}

export async function verifyInstalledPluginTrust(
  rootDir: string,
  manifest: Pick<PluginManifest, 'id' | 'permissions' | 'uiSlots'>,
  options: PluginPackageTrustOptions = {},
): Promise<{ packageHash: string; sourceTrust: PluginPackageSourceTrust }> {
  const [receiptResult, signatureResult] = await Promise.allSettled([
    verifyPluginApprovalReceipt(rootDir, manifest.id, manifest.permissions ?? []),
    assessPluginPackageTrust(rootDir, manifest, options),
  ]);
  const failures: string[] = [];
  if (receiptResult.status === 'rejected') {
    failures.push(`插件内容哈希校验未通过：${receiptResult.reason instanceof Error ? receiptResult.reason.message : String(receiptResult.reason)}`);
  }
  if (signatureResult.status === 'rejected') {
    failures.push(signatureResult.reason instanceof Error ? signatureResult.reason.message : String(signatureResult.reason));
  }
  if (failures.length > 0) {
    throw new Error(failures.join('；'));
  }
  if (receiptResult.status !== 'fulfilled' || signatureResult.status !== 'fulfilled') {
    throw new Error('插件信任校验没有返回结果');
  }
  return {
    packageHash: receiptResult.value.packageHash,
    sourceTrust: signatureResult.value,
  };
}
