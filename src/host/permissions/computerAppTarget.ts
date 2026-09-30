// ============================================================================
// computer_use 按应用授权的目标身份
// 只认 normalize 后的 computer_use。browser_action / gui_agent 不进这条授权。
// 匹配规则：两侧都有 bundleId 时只比 bundle（大小写保留，只 trim）；否则比
// trim 后的应用名并忽略大小写。不能只存 appKey 的 Set——请求侧缺 bundle 时
// 仍要能命中「按 bundle 记下、名字相同」的授权。
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
  if (storedBundle && requestedBundle) return storedBundle === requestedBundle;
  return stored.name.trim().toLowerCase() === requested.name.trim().toLowerCase();
}
