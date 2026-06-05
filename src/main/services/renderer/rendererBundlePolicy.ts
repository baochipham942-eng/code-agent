// ============================================================================
// 前端热更：bundle 应用决策（契约门 + 兜底）
// ============================================================================
// 纯决策逻辑：给定云端 manifest + 当前壳状态，判断是否应用该 renderer bundle。
// 兜底铁律：manifest 畸形 / 壳版本不满足 / 已是当前 → 不应用，保持当前前端。
// 契约门 minShellVersion 防「新前端配旧壳」崩溃（IPC 契约当前无版本号）。

import { compareUpdateVersions } from '../cloud/updateService';

export interface RendererBundleManifest {
  /** bundle 版本（一般等于产出它的 app 版本） */
  version: string;
  /** bundle.tar.gz 的 sha256，用于完整性校验 + 与本地 active 比对 */
  contentHash: string;
  /** 应用该前端所需的最低壳版本（前端用新 IPC 时调高，旧壳据此拒绝） */
  minShellVersion: string;
  /** bundle.tar.gz 下载地址（OSS） */
  bundleUrl: string;
}

export interface BundleApplyContext {
  /** 当前 app（壳）版本 */
  currentShellVersion: string;
  /** 本地已应用 bundle 的 contentHash，无则 null */
  activeContentHash: string | null;
}

export type BundleApplyDecision =
  | { apply: true }
  | { apply: false; reason: 'invalid-manifest' | 'shell-too-old' | 'already-current' };

function isValidManifest(value: unknown): value is RendererBundleManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.version === 'string' && m.version.length > 0 &&
    typeof m.contentHash === 'string' && m.contentHash.length > 0 &&
    typeof m.minShellVersion === 'string' && m.minShellVersion.length > 0 &&
    typeof m.bundleUrl === 'string' && m.bundleUrl.length > 0
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
  return { apply: true };
}
