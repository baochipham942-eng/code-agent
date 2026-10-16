// ============================================================================
// computer_use 按应用授权的目标身份
// 只认 normalize 后的 computer_use。browser_action / gui_agent 不进这条授权。
// 匹配规则：应用名（trim + 忽略大小写）永远必须相等——名字是 Host 在 handler
// 里对照 list_roots appName 校验过的锚点；bundleId 只能收紧不能放宽：两侧都
// 有 bundle 时还须相等，但 bundle 永远不能越过名字差异命中（N-COMPUTERUSE-
// GRANT-TARGETAPP rework r1：模型可伪造 bundleId，bundle 优先匹配曾可铸出跨
// app 便携授权）。不能只存 appKey 的 Set——请求侧缺 bundle 时仍要能命中
// 「按 bundle 记下、名字相同」的授权。
// ============================================================================

import { normalizeBrowserComputerCatalogToolName } from '../../shared/utils/browserComputerActionCatalog';

export interface ComputerTargetApp {
  bundleId?: string;
  name: string;
}

function cleanBundle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractComputerTargetApp(
  toolName: string,
  params: Record<string, unknown> | null | undefined,
): ComputerTargetApp | null {
  if (normalizeBrowserComputerCatalogToolName(toolName) !== 'computer_use') return null;
  const name = cleanName(params?.targetApp);
  if (!name) return null;
  const bundleId = cleanBundle(params?.bundleId);
  return bundleId ? { name, bundleId } : { name };
}

/** bundle 存在 → `bundle:<trimmed>`（大小写保留）；否则 `name:<trim+lower>`。 */
export function appGrantKey(app: ComputerTargetApp): string {
  const bundleId = cleanBundle(app.bundleId);
  if (bundleId) return `bundle:${bundleId}`;
  return `name:${app.name.trim().toLowerCase()}`;
}

export function computerAppsMatch(stored: ComputerTargetApp, requested: ComputerTargetApp): boolean {
  const storedBundle = cleanBundle(stored.bundleId);
  const requestedBundle = cleanBundle(requested.bundleId);
  if (storedBundle && requestedBundle && storedBundle !== requestedBundle) return false;
  return stored.name.trim().toLowerCase() === requested.name.trim().toLowerCase();
}
