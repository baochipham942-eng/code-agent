// ============================================================================
// PluginsSettings.helpers - 插件设置纯函数/类型层
// 从 PluginsSettings.tsx 纯平移拆出（god-file 债务门 1024/1000）。
// ============================================================================

import { zh } from '../../../../i18n/zh';
import type {
  InstalledPlugin,
  MarketplacePluginEntry,
  MarketplaceResult,
  MarketplaceSource,
  PluginInstallResult,
  PluginScope,
} from '@shared/contract/marketplace';

export type PluginsSettingsText = typeof zh.settings.plugins;
export type PluginTrustSummaryLabels = PluginsSettingsText['trustSummary'];
export type PluginRuntimeLabels = PluginsSettingsText['runtimeLabels'];
export type PluginRuntimeReasonLabels = PluginsSettingsText['runtimeReasons'];
export type PluginDateLabels = PluginsSettingsText['date'];
export type PluginErrorLabels = PluginsSettingsText['errors'];

export type PluginCompletenessStatus = 'complete' | 'partial';

export interface PluginCompletenessRow {
  area: string;
  status: PluginCompletenessStatus;
  detail: string;
}

export interface PluginVisibilityItem {
  spec: string;
  name: string;
  marketplace: string;
  kind: 'installed' | 'available';
  isEnabled: boolean;
  scope?: PluginScope;
  types: string[];
  skills: string[];
  commands: string[];
  reason: string;
}

export interface PluginVisibilityAssessment {
  userVisible: PluginVisibilityItem[];
  adminOnly: PluginVisibilityItem[];
  installedTotal: number;
  enabledTotal: number;
  catalogTotal: number;
}

export type PluginRuntimeReadiness =
  | 'disabled'
  | 'runtime_ready'
  | 'adapter_pending'
  | 'asset_only';

export const PLUGIN_COMPLETENESS_ROWS: PluginCompletenessRow[] =
  zh.settings.plugins.completeness.rows as PluginCompletenessRow[];

export function getPluginSpec(plugin: Pick<MarketplacePluginEntry | InstalledPlugin, 'name' | 'marketplace'>): string {
  return `${plugin.name}@${plugin.marketplace}`;
}

export function getPluginTrustSummary(plugin: Pick<MarketplacePluginEntry | InstalledPlugin, 'skills'> & {
  commands?: string[];
  permissions?: string[];
  hooks?: string[];
}, labels: PluginTrustSummaryLabels = zh.settings.plugins.trustSummary): string {
  const skills = normalizeList(plugin.skills).length;
  const commands = normalizeList(plugin.commands).length;
  const permissions = normalizeList(plugin.permissions).length;
  const hooks = normalizeList(plugin.hooks).length;
  return `${labels.prefix}${skills} ${labels.skillsUnit} · ${commands} ${labels.commandsUnit} · ${permissions || labels.undeclared} ${labels.permissionsUnit} · ${hooks || labels.undeclared} ${labels.hooksUnit} · ${labels.unknownRiskNotice}`;
}

export function normalizeList(values?: string[]): string[] {
  return values?.filter(Boolean) ?? [];
}

export function hasPluginRuntimeSurface(plugin: Pick<InstalledPlugin, 'skills' | 'commands'>): boolean {
  return normalizeList(plugin.skills).length > 0 || normalizeList(plugin.commands).length > 0;
}

export function hasAdapterPendingSurface(plugin: Pick<InstalledPlugin, 'types'>): boolean {
  const types = normalizeList(plugin.types);
  return types.includes('provider') || types.includes('theme') || types.includes('ui');
}

export function getPluginRuntimeReadiness(
  plugin: Pick<InstalledPlugin, 'isEnabled' | 'skills' | 'commands' | 'types'>,
): PluginRuntimeReadiness {
  if (!plugin.isEnabled) return 'disabled';
  if (hasPluginRuntimeSurface(plugin)) return 'runtime_ready';
  if (hasAdapterPendingSurface(plugin)) return 'adapter_pending';
  return 'asset_only';
}

export function isPluginRuntimeVisible(
  plugin: Pick<InstalledPlugin, 'isEnabled' | 'skills' | 'commands' | 'types'>,
): boolean {
  return getPluginRuntimeReadiness(plugin) === 'runtime_ready';
}

export function getPluginRuntimeLabel(
  readiness: PluginRuntimeReadiness,
  labels: PluginRuntimeLabels = zh.settings.plugins.runtimeLabels,
): string {
  switch (readiness) {
    case 'runtime_ready':
      return labels.runtimeReady;
    case 'adapter_pending':
      return labels.adapterPending;
    case 'asset_only':
      return labels.assetOnly;
    case 'disabled':
    default:
      return labels.disabled;
  }
}

export function getPluginRuntimeTone(readiness: PluginRuntimeReadiness): 'default' | 'success' | 'warning' | 'danger' {
  switch (readiness) {
    case 'runtime_ready':
      return 'success';
    case 'adapter_pending':
    case 'asset_only':
    case 'disabled':
    default:
      return 'warning';
  }
}

export function getPluginRuntimeReason(
  plugin: Pick<InstalledPlugin, 'isEnabled' | 'skills' | 'commands' | 'types'>,
  labels: PluginRuntimeReasonLabels = zh.settings.plugins.runtimeReasons,
): string {
  const readiness = getPluginRuntimeReadiness(plugin);
  switch (readiness) {
    case 'runtime_ready':
      return labels.runtimeReady;
    case 'adapter_pending':
      return labels.adapterPending;
    case 'asset_only':
      return labels.assetOnly;
    case 'disabled':
    default:
      return labels.disabled;
  }
}

export function buildPluginVisibilityAssessment({
  catalog,
  installed,
  labels = zh.settings.plugins,
}: {
  catalog: MarketplacePluginEntry[];
  installed: InstalledPlugin[];
  labels?: PluginsSettingsText;
}): PluginVisibilityAssessment {
  const installedBySpec = new Map(installed.map((plugin) => [getPluginSpec(plugin), plugin]));
  const userVisible: PluginVisibilityItem[] = [];
  const adminOnly: PluginVisibilityItem[] = [];

  for (const plugin of installed) {
    const runtimeVisible = isPluginRuntimeVisible(plugin);
    const item: PluginVisibilityItem = {
      spec: getPluginSpec(plugin),
      name: plugin.name,
      marketplace: plugin.marketplace,
      kind: 'installed',
      isEnabled: plugin.isEnabled,
      scope: plugin.scope,
      types: normalizeList(plugin.types),
      skills: normalizeList(plugin.skills),
      commands: normalizeList(plugin.commands),
      reason: getPluginRuntimeReason(plugin, labels.runtimeReasons),
    };

    if (runtimeVisible) {
      userVisible.push(item);
    } else {
      adminOnly.push(item);
    }
  }

  for (const plugin of catalog) {
    const spec = getPluginSpec(plugin);
    if (installedBySpec.has(spec)) continue;

    adminOnly.push({
      spec,
      name: plugin.name,
      marketplace: plugin.marketplace,
      kind: 'available',
      isEnabled: false,
      types: normalizeList(plugin.types),
      skills: normalizeList(plugin.skills),
      commands: normalizeList(plugin.commands),
      reason: labels.visibilityReasons.marketAvailable,
    });
  }

  return {
    userVisible,
    adminOnly,
    installedTotal: installed.length,
    enabledTotal: installed.filter((plugin) => plugin.isEnabled).length,
    catalogTotal: catalog.length,
  };
}

export function filterMarketplacePlugins({
  plugins,
  query,
  marketplace,
}: {
  plugins: MarketplacePluginEntry[];
  query: string;
  marketplace: string;
}): MarketplacePluginEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    const matchesMarketplace = marketplace === 'all' || plugin.marketplace === marketplace;
    if (!matchesMarketplace) return false;
    if (!normalizedQuery) return true;

    const haystack = [
      plugin.name,
      plugin.description,
      plugin.marketplace,
      plugin.source,
      plugin.author,
      plugin.version,
      ...(plugin.types ?? []),
      ...(plugin.tags ?? []),
      ...(plugin.skills ?? []),
      ...(plugin.commands ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function formatMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return `github:${source.repo}${source.ref ? `@${source.ref}` : ''}${source.path ? `#${source.path}` : ''}`;
    case 'url':
      return source.url;
    case 'npm':
      return `npm:${source.package}`;
    case 'directory':
      return source.path;
    default:
      return 'unknown';
  }
}

export function formatDate(value?: string, labels: PluginDateLabels = zh.settings.plugins.date): string {
  if (!value) return labels.unknown;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function getResultError(
  result?: MarketplaceResult<unknown> | PluginInstallResult,
  labels: PluginErrorLabels = zh.settings.plugins.errors,
): string {
  return result?.error || labels.operationFailed;
}

export function normalizeMarketplaceResult<T>(
  result: MarketplaceResult<T> | T | undefined,
  fallbackError: string,
): MarketplaceResult<T> {
  if (result && typeof result === 'object' && 'success' in result && typeof result.success === 'boolean') {
    return result as MarketplaceResult<T>;
  }
  if (result === undefined) {
    return { success: false, error: fallbackError };
  }
  return { success: true, data: result as T };
}
