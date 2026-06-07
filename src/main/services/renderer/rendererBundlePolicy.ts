// ============================================================================
// 前端热更：bundle 应用决策（契约门 + 兜底）
// ============================================================================
// 纯决策逻辑：给定云端 manifest + 当前壳状态，判断是否应用该 renderer bundle。
// 兜底铁律：manifest 畸形 / 壳版本不满足 / 已是当前 → 不应用，保持当前前端。
// 契约门 minShellVersion 防「新前端配旧壳」崩溃（IPC 契约当前无版本号）。

import { compareUpdateVersions } from '../cloud/updateService';
import { missingShellCapabilities } from '../../../shared/contract/shellCapabilities';

export interface RendererBundleManifest {
  /** bundle 版本（一般等于产出它的 app 版本） */
  version: string;
  /** bundle.tar.gz 的 sha256，用于完整性校验 + 与本地 active 比对 */
  contentHash?: string;
  /** 应用该前端所需的最低壳版本（前端用新 IPC 时调高，旧壳据此拒绝） */
  minShellVersion: string;
  /** bundle.tar.gz 下载地址（OSS） */
  bundleUrl?: string;
  /** 前端运行所需的壳能力；旧壳缺任一能力时拒绝应用该 bundle。 */
  requiredShellCapabilities?: string[];
  /** 前端运行期依赖的可下载 runtime asset ID；本机缺失时拒绝应用。 */
  requiredRuntimeAssets?: string[];
  /** 前端运行期依赖的包内资源路径或资源 ID；本机缺失时拒绝应用。 */
  requiredResources?: string[];
  /** signed rollback command: remove active overlay and serve bundled renderer. */
  rollbackToBuiltin?: boolean;
  rollbackReason?: string;
}

export interface BundleApplyContext {
  /** 当前 app（壳）版本 */
  currentShellVersion: string;
  /** 本地已应用 bundle 的 contentHash，无则 null */
  activeContentHash: string | null;
  /** 当前壳可提供的本地能力 ID。 */
  shellCapabilities?: readonly string[];
  /** 本机当前可用的 runtime asset ID（installed 或 bundledFallback）。 */
  availableRuntimeAssets?: readonly string[];
  /** 本机当前可用的资源依赖 ID/path。 */
  availableResources?: readonly string[];
}

export type BundleApplyDecision =
  | { apply: true }
  | { apply: false; reason: 'invalid-manifest' | 'shell-too-old' | 'already-current' | 'rollback-to-builtin' }
  | { apply: false; reason: 'missing-shell-capability'; missingShellCapabilities: string[] }
  | { apply: false; reason: 'missing-runtime-asset'; missingRuntimeAssets: string[] }
  | { apply: false; reason: 'missing-resource'; missingResources: string[] };

function missingStringDependencies(
  available: readonly string[] | undefined,
  required: readonly string[] | undefined,
): string[] {
  if (!required || required.length === 0) return [];
  const availableSet = new Set(available ?? []);
  return [...new Set(required)].filter((entry) => !availableSet.has(entry));
}

function isValidManifest(value: unknown): value is RendererBundleManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const requiredShellCapabilities = m.requiredShellCapabilities;
  const requiredRuntimeAssets = m.requiredRuntimeAssets;
  const requiredResources = m.requiredResources;
  const rollbackToBuiltin = m.rollbackToBuiltin === true;
  return (
    typeof m.version === 'string' && m.version.length > 0 &&
    typeof m.minShellVersion === 'string' && m.minShellVersion.length > 0 &&
    (
      rollbackToBuiltin ||
      (
        typeof m.contentHash === 'string' && m.contentHash.length > 0 &&
        typeof m.bundleUrl === 'string' && m.bundleUrl.length > 0
      )
    ) &&
    (
      requiredShellCapabilities === undefined ||
      (
        Array.isArray(requiredShellCapabilities) &&
        requiredShellCapabilities.every((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ) &&
    (
      requiredRuntimeAssets === undefined ||
      (
        Array.isArray(requiredRuntimeAssets) &&
        requiredRuntimeAssets.every((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ) &&
    (
      requiredResources === undefined ||
      (
        Array.isArray(requiredResources) &&
        requiredResources.every((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ) &&
    (m.rollbackToBuiltin === undefined || typeof m.rollbackToBuiltin === 'boolean') &&
    (m.rollbackReason === undefined || typeof m.rollbackReason === 'string')
  );
}

export function shouldApplyRendererBundle(
  manifest: unknown,
  ctx: BundleApplyContext,
): BundleApplyDecision {
  if (!isValidManifest(manifest)) {
    return { apply: false, reason: 'invalid-manifest' };
  }
  // 已是当前 active：无需任何操作
  if (ctx.activeContentHash && manifest.contentHash === ctx.activeContentHash) {
    return { apply: false, reason: 'already-current' };
  }
  // 契约门：当前壳 < minShellVersion → 拒绝（防新前端配旧壳崩）
  if (compareUpdateVersions(ctx.currentShellVersion, manifest.minShellVersion) < 0) {
    return { apply: false, reason: 'shell-too-old' };
  }
  const missing = missingShellCapabilities(
    ctx.shellCapabilities ?? [],
    manifest.requiredShellCapabilities,
  );
  if (missing.length > 0) {
    return {
      apply: false,
      reason: 'missing-shell-capability',
      missingShellCapabilities: missing,
    };
  }
  const missingRuntimeAssets = missingStringDependencies(
    ctx.availableRuntimeAssets,
    manifest.requiredRuntimeAssets,
  );
  if (missingRuntimeAssets.length > 0) {
    return {
      apply: false,
      reason: 'missing-runtime-asset',
      missingRuntimeAssets,
    };
  }
  const missingResources = missingStringDependencies(
    ctx.availableResources,
    manifest.requiredResources,
  );
  if (missingResources.length > 0) {
    return {
      apply: false,
      reason: 'missing-resource',
      missingResources,
    };
  }
  if (manifest.rollbackToBuiltin) {
    return { apply: false, reason: 'rollback-to-builtin' };
  }
  if (!manifest.contentHash || !manifest.bundleUrl) {
    return { apply: false, reason: 'invalid-manifest' };
  }
  return { apply: true };
}
