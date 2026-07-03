// ============================================================================
// PluginsSettings - Marketplace plugin management
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Download,
  Loader2,
  PackageCheck,
  PackagePlus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Shield,
  Trash2,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  ALMA_FEATURED_PLUGIN_REGISTRY,
  adaptAlmaPluginToCodeAgentSpec,
  type AlmaFeaturedPluginEntry,
} from '@shared/constants/almaPluginRegistry';
import { ALMA_PLUGIN_REGISTRY_URL } from '@shared/constants/almaRegistryAudit';
import {
  getAlmaPluginRecommendationPolicy,
  type AlmaRecommendationPolicyTier,
} from '@shared/constants/almaRecommendationPolicy';
import type {
  InstalledPlugin,
  MarketplaceInfo,
  MarketplacePluginEntry,
  MarketplaceResult,
  MarketplaceSource,
  PluginInstallResult,
  PluginScope,
} from '@shared/contract/marketplace';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import ipcService from '../../../../services/ipcService';
import { Button } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { AlmaRegistryAuditPanel } from './AlmaRegistryAuditPanel';

type Notice = { type: 'success' | 'error'; text: string };
type PluginsSettingsText = typeof zh.settings.plugins;
type PluginTrustSummaryLabels = PluginsSettingsText['trustSummary'];
type PluginRuntimeLabels = PluginsSettingsText['runtimeLabels'];
type PluginRuntimeReasonLabels = PluginsSettingsText['runtimeReasons'];
type PluginDateLabels = PluginsSettingsText['date'];
type PluginErrorLabels = PluginsSettingsText['errors'];

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

function normalizeList(values?: string[]): string[] {
  return values?.filter(Boolean) ?? [];
}

function hasPluginRuntimeSurface(plugin: Pick<InstalledPlugin, 'skills' | 'commands'>): boolean {
  return normalizeList(plugin.skills).length > 0 || normalizeList(plugin.commands).length > 0;
}

function hasAdapterPendingSurface(plugin: Pick<InstalledPlugin, 'types'>): boolean {
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

function getPluginRuntimeLabel(
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

function getPluginRuntimeTone(readiness: PluginRuntimeReadiness): 'default' | 'success' | 'warning' | 'danger' {
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

function getPluginRuntimeReason(
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

function formatMarketplaceSource(source: MarketplaceSource): string {
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

function formatDate(value?: string, labels: PluginDateLabels = zh.settings.plugins.date): string {
  if (!value) return labels.unknown;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getResultError(
  result?: MarketplaceResult<unknown> | PluginInstallResult,
  labels: PluginErrorLabels = zh.settings.plugins.errors,
): string {
  return result?.error || labels.operationFailed;
}

function normalizeMarketplaceResult<T>(
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

const SummaryTile: React.FC<{
  label: string;
  value: number | string;
  tone?: 'default' | 'success' | 'warning';
}> = ({ label, value, tone = 'default' }) => {
  const valueClass = tone === 'success'
    ? 'text-emerald-300'
    : tone === 'warning'
      ? 'text-amber-300'
      : 'text-zinc-100';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className={`text-lg font-semibold ${valueClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
};

const Pill: React.FC<{
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}> = ({ children, tone = 'default' }) => {
  const toneClass = tone === 'success'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : tone === 'warning'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10 text-red-300'
        : 'border-zinc-700 bg-zinc-800 text-zinc-300';

  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
};

function getAlmaPluginTierTone(tier: AlmaRecommendationPolicyTier): 'default' | 'success' | 'warning' | 'danger' {
  switch (tier) {
    case 'default_visible':
      return 'success';
    case 'conditional':
      return 'warning';
    case 'not_default':
      return 'default';
    case 'unsupported':
      return 'danger';
    default:
      return 'default';
  }
}

const AlmaFeaturedPluginCard: React.FC<{
  plugin: AlmaFeaturedPluginEntry;
  labels: PluginsSettingsText['almaFeatured']['card'];
}> = ({ plugin, labels }) => {
  const policy = getAlmaPluginRecommendationPolicy(plugin);
  const adapter = adaptAlmaPluginToCodeAgentSpec(plugin);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
            <Pill>{plugin.id}</Pill>
            <Pill>{plugin.kind}</Pill>
            <Pill tone={getAlmaPluginTierTone(policy.tier)}>
              {policy.label}
            </Pill>
            <Pill tone={adapter.canInstall ? 'success' : 'warning'}>
              {adapter.canInstall ? labels.installable : labels.displayOnly}
            </Pill>
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-500">{policy.reason}</p>
        </div>
        <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
      </div>
      <div className="mt-3 rounded-md bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-500">
        <div><span className="text-zinc-300">{labels.author}</span> {plugin.author}</div>
        <div><span className="text-zinc-300">{labels.boundary}</span> {policy.riskNote}</div>
        <div><span className="text-zinc-300">{labels.surface}</span> {adapter.surface} · {adapter.installability}</div>
        <div><span className="text-zinc-300">{labels.missing}</span> {adapter.requiredRuntimeCapabilities.join(', ') || labels.none}</div>
        <div><span className="text-zinc-300">{labels.reason}</span> {adapter.unsupportedReason}</div>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/35 px-4 py-6 text-center text-sm text-zinc-500">
    {text}
  </div>
);

export const PluginsSettings: React.FC = () => {
  const { t } = useI18n();
  const pluginsText = t.settings.plugins;
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [catalog, setCatalog] = useState<MarketplacePluginEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [selectedMarketplace, setSelectedMarketplace] = useState('all');
  const [query, setQuery] = useState('');
  const [newMarketplaceSource, setNewMarketplaceSource] = useState('');
  const [installScope, setInstallScope] = useState<PluginScope>('user');
  const [projectPath, setProjectPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setNotice(null);
    try {
      const [marketplaceResult, catalogResult, installedResult] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST),
        ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS),
        ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED, 'all'),
      ]);

      const marketplacesState = normalizeMarketplaceResult<MarketplaceInfo[]>(
        marketplaceResult,
        pluginsText.loadErrors.marketplaces,
      );
      const catalogState = normalizeMarketplaceResult<MarketplacePluginEntry[]>(
        catalogResult,
        pluginsText.loadErrors.catalog,
      );
      const installedState = normalizeMarketplaceResult<InstalledPlugin[]>(
        installedResult,
        pluginsText.loadErrors.installed,
      );

      if (!marketplacesState.success) throw new Error(getResultError(marketplacesState, pluginsText.errors));
      if (!catalogState.success) throw new Error(getResultError(catalogState, pluginsText.errors));
      if (!installedState.success) throw new Error(getResultError(installedState, pluginsText.errors));

      setMarketplaces(marketplacesState.data ?? []);
      setCatalog(catalogState.data ?? []);
      setInstalled(installedState.data ?? []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text });
    } finally {
      setLoading(false);
    }
  }, [isAdmin, pluginsText]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredCatalog = useMemo(
    () => filterMarketplacePlugins({ plugins: catalog, query, marketplace: selectedMarketplace }),
    [catalog, query, selectedMarketplace],
  );

  const visibility = useMemo(
    () => buildPluginVisibilityAssessment({ catalog, installed, labels: pluginsText }),
    [catalog, installed, pluginsText],
  );

  const installedBySpec = useMemo(
    () => new Map(installed.map((plugin) => [getPluginSpec(plugin), plugin])),
    [installed],
  );

  const runAction = useCallback(async (key: string, action: () => Promise<string>) => {
    setBusyKey(key);
    setNotice(null);
    try {
      const text = await action();
      setNotice({ type: 'success', text });
      await reload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text });
    } finally {
      setBusyKey(null);
    }
  }, [reload]);

  const handleAddMarketplace = useCallback(() => {
    const source = newMarketplaceSource.trim();
    if (!source) {
      setNotice({ type: 'error', text: pluginsText.toast.fillMarketplaceSource });
      return;
    }

    void runAction('marketplace:add', async () => {
      const result = normalizeMarketplaceResult<MarketplaceInfo>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_ADD, source),
        pluginsText.toast.addMarketplaceFailed,
      );
      if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
      setNewMarketplaceSource('');
      return `${pluginsText.toast.addMarketplaceSuccessPrefix}${result.data?.name || source}`;
    });
  }, [newMarketplaceSource, pluginsText, runAction]);

  const handleRefreshMarketplace = useCallback((name?: string) => {
    const key = name ? `marketplace:refresh:${name}` : 'marketplace:refresh:all';
    void runAction(key, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_REFRESH, name),
        pluginsText.toast.refreshMarketplaceFailed,
      );
      if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
      return name
        ? `${pluginsText.toast.refreshMarketplaceSuccessPrefix}${name}`
        : pluginsText.toast.refreshAllMarketplaceSuccess;
    });
  }, [pluginsText, runAction]);

  const handleRemoveMarketplace = useCallback((name: string) => {
    if (!window.confirm(`${pluginsText.toast.removeMarketplaceConfirmPrefix}${name}${pluginsText.toast.removeMarketplaceConfirmSuffix}`)) return;
    void runAction(`marketplace:remove:${name}`, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_REMOVE, name),
        pluginsText.toast.removeMarketplaceFailed,
      );
      if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
      return `${pluginsText.toast.removeMarketplaceSuccessPrefix}${name}`;
    });
  }, [pluginsText, runAction]);

  const handleInstall = useCallback((plugin: MarketplacePluginEntry) => {
    const spec = getPluginSpec(plugin);
    void runAction(`plugin:install:${spec}`, async () => {
      const options = installScope === 'project'
        ? { scope: installScope, projectPath: projectPath.trim() || undefined }
        : { scope: installScope };
      const result = await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, spec, options);
      if (!result?.success) throw new Error(getResultError(result, pluginsText.errors));
      return `${pluginsText.toast.installSuccessPrefix}${spec}${pluginsText.toast.installSuccessSuffix}`;
    });
  }, [installScope, pluginsText, projectPath, runAction]);

  const handleToggle = useCallback((plugin: InstalledPlugin) => {
    const spec = getPluginSpec(plugin);
    void runAction(`plugin:toggle:${spec}`, async () => {
      const result = plugin.isEnabled
        ? normalizeMarketplaceResult<void>(
          await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_DISABLE_PLUGIN, spec),
          pluginsText.toast.disablePluginFailed,
        )
        : normalizeMarketplaceResult<void>(
          await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_ENABLE_PLUGIN, spec),
          pluginsText.toast.enablePluginFailed,
        );
      if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
      return plugin.isEnabled
        ? `${pluginsText.toast.disablePluginSuccessPrefix}${spec}`
        : `${pluginsText.toast.enablePluginSuccessPrefix}${spec}`;
    });
  }, [pluginsText, runAction]);

  const handleUninstall = useCallback((plugin: InstalledPlugin) => {
    const spec = getPluginSpec(plugin);
    if (!window.confirm(`${pluginsText.toast.uninstallConfirmPrefix}${spec}${pluginsText.toast.uninstallConfirmSuffix}`)) return;
    void runAction(`plugin:uninstall:${spec}`, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(
          IPC_CHANNELS.MARKETPLACE_UNINSTALL_PLUGIN,
          spec,
          plugin.scope,
        ),
        pluginsText.toast.uninstallFailed,
      );
      if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
      return `${pluginsText.toast.uninstallSuccessPrefix}${spec}`;
    });
  }, [pluginsText, runAction]);

  if (!isAdmin) {
    return (
      <SettingsPage
        title={pluginsText.title}
        description={pluginsText.adminRequiredDescription}
      >
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {pluginsText.adminRequiredNotice}
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={pluginsText.title}
      description={pluginsText.description}
    >
      {/* 操作结果通知（页面级，所有 section 的操作都在这里反馈） */}
      {notice && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
          notice.type === 'success'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
            : 'border-red-500/30 bg-red-500/10 text-red-200'
        }`}
        >
          {notice.type === 'success' ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      <SettingsSection
        title={pluginsText.almaFeatured.title}
        description={pluginsText.almaFeatured.description}
        actions={(
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void runAction('marketplace:add:alma-plugins', async () => {
                const result = normalizeMarketplaceResult<MarketplaceInfo>(
                  await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_ADD, ALMA_PLUGIN_REGISTRY_URL),
                  pluginsText.toast.addAlmaSourceFailed,
                );
                if (!result.success) throw new Error(getResultError(result, pluginsText.errors));
                return `${pluginsText.toast.addAlmaSourceSuccessPrefix}${result.data?.name || pluginsText.toast.almaFallbackName}`;
              });
            }}
            loading={busyKey === 'marketplace:add:alma-plugins'}
            disabled={busyKey !== null}
            leftIcon={<PackagePlus className="h-3.5 w-3.5" />}
          >
            {pluginsText.almaFeatured.addOfficialSource}
          </Button>
        )}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {ALMA_FEATURED_PLUGIN_REGISTRY.map((plugin) => (
            <AlmaFeaturedPluginCard
              key={plugin.id}
              plugin={plugin}
              labels={pluginsText.almaFeatured.card}
            />
          ))}
        </div>
        <AlmaRegistryAuditPanel />
      </SettingsSection>

      <SettingsSection
        title={pluginsText.installed.title}
        description={pluginsText.installed.description}
        actions={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {pluginsText.installed.refresh}
          </Button>
        )}
      >
        {loading ? (
          <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40 py-8 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {pluginsText.installed.loading}
          </div>
        ) : installed.length === 0 ? (
          <EmptyState text={pluginsText.installed.empty} />
        ) : (
          <div className="space-y-3">
            {installed.map((plugin) => {
              const spec = getPluginSpec(plugin);
              const busy = busyKey === `plugin:toggle:${spec}` || busyKey === `plugin:uninstall:${spec}`;
              const runtimeReadiness = getPluginRuntimeReadiness(plugin);
              return (
                <div key={spec} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
                        <Pill>{plugin.marketplace}</Pill>
                        <Pill>{plugin.scope}</Pill>
                        {(plugin.types ?? []).map((type) => (
                          <Pill key={type}>{type}</Pill>
                        ))}
                        <Pill tone={plugin.isEnabled ? 'success' : 'warning'}>
                          {plugin.isEnabled ? pluginsText.installed.enabled : pluginsText.installed.disabled}
                        </Pill>
                        <Pill tone={getPluginRuntimeTone(runtimeReadiness)}>
                          {getPluginRuntimeLabel(runtimeReadiness, pluginsText.runtimeLabels)}
                        </Pill>
                      </div>
                      <div className="mt-2 text-xs leading-5 text-zinc-500">
                        {pluginsText.installed.installedAtPrefix}{formatDate(plugin.installedAt, pluginsText.date)}
                        {plugin.projectPath ? `${pluginsText.installed.projectPrefix}${plugin.projectPath}` : ''}
                      </div>
                      {plugin.pluginRoot && (
                        <div className="mt-1 break-all text-xs text-zinc-600">{plugin.pluginRoot}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant={plugin.isEnabled ? 'ghost' : 'secondary'}
                        size="sm"
                        loading={busyKey === `plugin:toggle:${spec}`}
                        disabled={busy}
                        onClick={() => handleToggle(plugin)}
                        leftIcon={plugin.isEnabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                      >
                        {plugin.isEnabled ? pluginsText.installed.disable : pluginsText.installed.enable}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={busyKey === `plugin:uninstall:${spec}`}
                        disabled={busy}
                        onClick={() => handleUninstall(plugin)}
                        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                      >
                        {pluginsText.installed.uninstall}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs text-zinc-500 md:col-span-2">
                      <span className="text-zinc-300">{pluginsText.installed.runtime}</span>
                      <span className="ml-2">{getPluginRuntimeReason(plugin, pluginsText.runtimeReasons)}</span>
                    </div>
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs text-zinc-500">
                      <span className="text-zinc-300">{pluginsText.installed.skills}</span>
                      <span className="ml-2">{plugin.skills.length ? plugin.skills.join(' · ') : pluginsText.installed.none}</span>
                    </div>
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs text-zinc-500">
                      <span className="text-zinc-300">{pluginsText.installed.commands}</span>
                      <span className="ml-2">{(plugin.commands ?? []).length ? plugin.commands?.join(' · ') : pluginsText.installed.none}</span>
                    </div>
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs text-zinc-500 md:col-span-2">
                      <span className="text-zinc-300">{pluginsText.installed.pluginAsset}</span>
                      <span className="ml-2 break-all">{plugin.pluginRoot || pluginsText.installed.none}</span>
                    </div>
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-500">
                      <span className="text-zinc-300">{pluginsText.installed.trust}</span>
                      <span className="ml-2">{getPluginTrustSummary(plugin, pluginsText.trustSummary)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={pluginsText.marketplace.title}
        description={pluginsText.marketplace.description}
      >
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_160px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={pluginsText.marketplace.searchPlaceholder}
                className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
              />
            </label>
            <select
              value={selectedMarketplace}
              onChange={(event) => setSelectedMarketplace(event.target.value)}
              className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden focus:border-zinc-500"
              aria-label={pluginsText.marketplace.marketplaceAria}
            >
              <option value="all">{pluginsText.marketplace.allMarketplaces}</option>
              {marketplaces.map((marketplace) => (
                <option key={marketplace.name} value={marketplace.name}>{marketplace.name}</option>
              ))}
            </select>
            <select
              value={installScope}
              onChange={(event) => setInstallScope(event.target.value as PluginScope)}
              className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden focus:border-zinc-500"
              aria-label={pluginsText.marketplace.installScopeAria}
            >
              <option value="user">{pluginsText.marketplace.userScope}</option>
              <option value="project">{pluginsText.marketplace.projectScope}</option>
            </select>
          </div>
          {installScope === 'project' && (
            <input
              type="text"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder={pluginsText.marketplace.projectPathPlaceholder}
              className="mt-3 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
            />
          )}
        </div>

        {filteredCatalog.length === 0 ? (
          <EmptyState text={catalog.length === 0 ? pluginsText.marketplace.emptyCatalog : pluginsText.marketplace.noMatches} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {filteredCatalog.map((plugin) => {
              const spec = getPluginSpec(plugin);
              const installedPlugin = installedBySpec.get(spec);
              return (
                <div key={spec} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
                        <Pill>{plugin.marketplace}</Pill>
                        {(plugin.types ?? []).slice(0, 3).map((type) => (
                          <Pill key={type}>{type}</Pill>
                        ))}
                        {plugin.version && <Pill>v{plugin.version}</Pill>}
                        {installedPlugin ? (
                          <Pill tone={installedPlugin.isEnabled ? 'success' : 'warning'}>
                            {installedPlugin.isEnabled ? pluginsText.marketplace.enabled : pluginsText.marketplace.installedDisabled}
                          </Pill>
                        ) : (
                          <Pill tone="warning">{pluginsText.marketplace.adminOnly}</Pill>
                        )}
                        {installedPlugin && (
                          <Pill tone={getPluginRuntimeTone(getPluginRuntimeReadiness(installedPlugin))}>
                            {getPluginRuntimeLabel(getPluginRuntimeReadiness(installedPlugin), pluginsText.runtimeLabels)}
                          </Pill>
                        )}
                      </div>
                      {plugin.description && (
                        <p className="mt-2 text-xs leading-5 text-zinc-500">{plugin.description}</p>
                      )}
                      <div className="mt-2 break-all text-xs text-zinc-600">{plugin.source}</div>
                    </div>
                    {installedPlugin ? (
                      <PackageCheck className="h-5 w-5 shrink-0 text-emerald-300" />
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyKey === `plugin:install:${spec}`}
                        disabled={busyKey !== null}
                        onClick={() => handleInstall(plugin)}
                        leftIcon={<Download className="h-3.5 w-3.5" />}
                      >
                        {pluginsText.marketplace.install}
                      </Button>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(plugin.tags ?? []).slice(0, 6).map((tag) => (
                      <Pill key={tag}>{tag}</Pill>
                    ))}
                    {(plugin.types ?? []).length > 0 && <Pill>{plugin.types?.join(' · ')}</Pill>}
                    {(plugin.skills ?? []).length > 0 && <Pill>{plugin.skills?.length}{pluginsText.marketplace.skillsCountSuffix}</Pill>}
                    {(plugin.commands ?? []).length > 0 && <Pill>{plugin.commands?.length}{pluginsText.marketplace.commandsCountSuffix}</Pill>}
                  </div>
                  <div className="mt-3 rounded-md bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-500">
                    <span className="text-zinc-300">{pluginsText.installed.trust}</span>
                    <span className="ml-2">{getPluginTrustSummary(plugin, pluginsText.trustSummary)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsDetails
        title={pluginsText.overview.title}
        description={pluginsText.overview.description}
      >
        <div className="grid gap-3 md:grid-cols-6">
          <SummaryTile label={pluginsText.overview.marketplace} value={marketplaces.length} />
          <SummaryTile label={pluginsText.overview.marketPlugins} value={catalog.length} />
          <SummaryTile label={pluginsText.overview.installed} value={visibility.installedTotal} />
          <SummaryTile label={pluginsText.overview.enabled} value={visibility.enabledTotal} tone="success" />
          <SummaryTile label={pluginsText.overview.runtimeVisible} value={visibility.userVisible.length} tone="success" />
          <SummaryTile label={pluginsText.overview.adminOnly} value={visibility.adminOnly.length} tone="warning" />
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Shield className="h-4 w-4 text-amber-300" />
            {pluginsText.overview.roleVisibility}
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">{pluginsText.overview.adminTitle}</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {pluginsText.overview.adminDescription}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">{pluginsText.overview.userTitle}</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {pluginsText.overview.userDescription}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">{pluginsText.overview.installPolicyTitle}</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {pluginsText.overview.installPolicyDescription}
              </p>
            </div>
          </div>
        </div>
      </SettingsDetails>

      <SettingsDetails
        title={pluginsText.completeness.title}
        description={pluginsText.completeness.description}
      >
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">{pluginsText.completeness.moduleColumn}</th>
                <th className="px-3 py-2 font-medium">{pluginsText.completeness.statusColumn}</th>
                <th className="px-3 py-2 font-medium">{pluginsText.completeness.descriptionColumn}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/30">
              {(pluginsText.completeness.rows as PluginCompletenessRow[]).map((row) => (
                <tr key={row.area}>
                  <td className="px-3 py-2 text-zinc-300">{row.area}</td>
                  <td className="px-3 py-2">
                    <Pill tone={row.status === 'complete' ? 'success' : 'warning'}>
                      {row.status === 'complete' ? pluginsText.completeness.complete : pluginsText.completeness.partial}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 text-xs leading-5 text-zinc-500">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsDetails>

      <SettingsDetails
        title={pluginsText.marketplaceSources.title}
        description={pluginsText.marketplaceSources.description}
      >
        <div className="flex flex-col gap-3 md:flex-row">
          <input
            type="text"
            value={newMarketplaceSource}
            onChange={(event) => setNewMarketplaceSource(event.target.value)}
            placeholder={pluginsText.marketplaceSources.placeholder}
            className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAddMarketplace}
            loading={busyKey === 'marketplace:add'}
            disabled={busyKey !== null}
            leftIcon={<PackagePlus className="h-3.5 w-3.5" />}
          >
            {pluginsText.marketplaceSources.add}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleRefreshMarketplace()}
            loading={busyKey === 'marketplace:refresh:all'}
            disabled={busyKey !== null}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {pluginsText.marketplaceSources.refreshAll}
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {marketplaces.length === 0 ? (
            <EmptyState text={pluginsText.marketplaceSources.empty} />
          ) : (
            marketplaces.map((marketplace) => (
              <div key={marketplace.name} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-medium text-zinc-100">{marketplace.name}</h4>
                      <Pill>{marketplace.pluginCount} plugins</Pill>
                      {marketplace.autoUpdate && <Pill tone="success">auto update</Pill>}
                    </div>
                    {marketplace.description && (
                      <p className="mt-1 text-xs text-zinc-500">{marketplace.description}</p>
                    )}
                    <div className="mt-2 break-all text-xs text-zinc-600">
                      {formatMarketplaceSource(marketplace.source)}
                    </div>
                    <div className="mt-1 break-all text-xs text-zinc-600">
                      {pluginsText.marketplaceSources.cachePrefix}{marketplace.installLocation}
                      {pluginsText.marketplaceSources.updatePrefix}{formatDate(marketplace.lastUpdated, pluginsText.date)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRefreshMarketplace(marketplace.name)}
                      loading={busyKey === `marketplace:refresh:${marketplace.name}`}
                      disabled={busyKey !== null}
                      leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                    >
                      {pluginsText.marketplaceSources.refresh}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleRemoveMarketplace(marketplace.name)}
                      loading={busyKey === `marketplace:remove:${marketplace.name}`}
                      disabled={busyKey !== null}
                      leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    >
                      {pluginsText.marketplaceSources.remove}
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsDetails>

      <SettingsDetails
        title={pluginsText.visibleList.title}
        description={pluginsText.visibleList.description}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium text-emerald-300">{pluginsText.visibleList.userVisibleTitle}</h4>
            {visibility.userVisible.length === 0 ? (
              <EmptyState text={pluginsText.visibleList.userVisibleEmpty} />
            ) : (
              <div className="space-y-2">
                {visibility.userVisible.map((item) => (
                  <div key={item.spec} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{item.spec}</span>
                      {item.scope && <Pill tone="success">{item.scope}</Pill>}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{item.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-medium text-amber-300">{pluginsText.visibleList.adminOnlyTitle}</h4>
            {visibility.adminOnly.length === 0 ? (
              <EmptyState text={pluginsText.visibleList.adminOnlyEmpty} />
            ) : (
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {visibility.adminOnly.map((item) => (
                  <div key={`${item.kind}:${item.spec}`} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{item.spec}</span>
                      <Pill tone="warning">{item.kind === 'installed' ? pluginsText.visibleList.installedDisabled : pluginsText.visibleList.notInstalled}</Pill>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{item.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};
