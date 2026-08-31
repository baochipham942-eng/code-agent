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
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  InstalledPlugin,
  MarketplaceInfo,
  MarketplacePluginEntry,
  PluginScope,
} from '@shared/contract/marketplace';
import type {
  CapabilityPackagePermission,
  CapabilityPackagePreview,
  InstalledCapabilityPackage,
} from '@shared/contract/capabilityPackage';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n } from '../../../../hooks/useI18n';
import ipcService from '../../../../services/ipcService';
import { canAccessFeature, createAccessSubject } from '../../../../utils/accessControl';
import { Button, EmptyState, Modal, ModalFooter } from '../../../primitives';
import { SettingsDetails, SettingsSection } from '../SettingsLayout';
import { BundledCapabilitiesTab } from '../../capabilityHub/BundledCapabilitiesTab';
import { HubTabHeader } from '../../capabilityHub/HubTabHeader';

type Notice = { type: 'success' | 'error'; text: string };
export * from './PluginsSettings.helpers';
import {
  type PluginCompletenessRow,
  getPluginSpec,
  getPluginTrustSummary,
  getPluginRuntimeReadiness,
  getPluginRuntimeLabel,
  getPluginRuntimeTone,
  getPluginRuntimeReason,
  buildPluginVisibilityAssessment,
  filterMarketplacePlugins,
  formatMarketplaceSource,
  formatDate,
  getResultError,
  normalizeMarketplaceResult,
  toDisplayPath,
} from './PluginsSettings.helpers';

const PLUGIN_RELOAD_RETRY_DELAYS_MS = [25, 75, 150] as const;

async function waitForPluginBridge(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function invokePluginReloadBatch() {
  for (let attempt = 0; attempt <= PLUGIN_RELOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    const results = await Promise.all([
      ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST),
      ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS),
      ipcService.invoke(IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED, 'all'),
      ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST),
    ]);

    if (results.every((result) => result !== undefined)) return results;
    if (attempt === PLUGIN_RELOAD_RETRY_DELAYS_MS.length) return undefined;
    await waitForPluginBridge(PLUGIN_RELOAD_RETRY_DELAYS_MS[attempt]);
  }

  return undefined;
}

const SummaryTile: React.FC<{
  label: string;
  value: number | string;
  tone?: 'default' | 'success' | 'warning';
}> = ({ label, value, tone = 'default' }) => {
  const valueClass = tone === 'success'
    ? 'text-badge-success'
    : tone === 'warning'
      ? 'text-badge-warning'
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
    ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
    : tone === 'warning'
      ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
      : tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10 text-badge-danger'
        : 'border-zinc-700 bg-zinc-800 text-zinc-300';

  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
};

export const PluginsSettings: React.FC = () => {
  const { t } = useI18n();
  const pluginsText = t.settings.plugins;
  const currentUser = useAuthStore((state) => state.user);
  const canAccessPluginAdmin = canAccessFeature(
    'settings.plugins',
    createAccessSubject(currentUser),
  );
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [catalog, setCatalog] = useState<MarketplacePluginEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [capabilityPackages, setCapabilityPackages] = useState<InstalledCapabilityPackage[]>([]);
  const [packagePreview, setPackagePreview] = useState<CapabilityPackagePreview | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState('all');
  const [query, setQuery] = useState('');
  const [newMarketplaceSource, setNewMarketplaceSource] = useState('');
  const [installScope, setInstallScope] = useState<PluginScope>('user');
  const [projectPath, setProjectPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installStates, setInstallStates] = useState<Record<string, 'installing' | 'cancelling'>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const results = await invokePluginReloadBatch();
      if (!results) return;
      const [marketplaceResult, catalogResult, installedResult, capabilityPackageResult] = results;

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
      if (!capabilityPackageResult.success) throw new Error(capabilityPackageResult.error);

      setMarketplaces(marketplacesState.data ?? []);
      setCatalog(catalogState.data ?? []);
      setInstalled(installedState.data ?? []);
      setCapabilityPackages(capabilityPackageResult.data);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text });
    } finally {
      setLoading(false);
    }
  }, [pluginsText]);

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
    setInstallStates((current) => ({ ...current, [spec]: 'installing' }));
    setNotice(null);
    void (async () => {
      const options = installScope === 'project'
        ? { scope: installScope, projectPath: projectPath.trim() || undefined }
        : { scope: installScope };
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, spec, options);
        if (result?.cancelled) return;
        if (!result?.success) throw new Error(getResultError(result, pluginsText.errors));
        setNotice({
          type: 'success',
          text: `${pluginsText.toast.installSuccessPrefix}${spec}${pluginsText.toast.installSuccessSuffix}`,
        });
        await reload();
      } catch (error) {
        setNotice({
          type: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setInstallStates((current) => {
          const next = { ...current };
          delete next[spec];
          return next;
        });
      }
    })();
  }, [installScope, pluginsText, projectPath, reload]);

  const handleCancelInstall = useCallback((spec: string) => {
    setInstallStates((current) => (
      current[spec] ? { ...current, [spec]: 'cancelling' } : current
    ));
    void ipcService.invoke(IPC_CHANNELS.MARKETPLACE_CANCEL_INSTALL, spec);
  }, []);

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

  const handleSelectCapabilityPackage = useCallback(() => {
    setPackageBusy(true);
    setNotice(null);
    void (async () => {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE);
        if (!result.success) throw new Error(result.error);
        if (result.data) setPackagePreview(result.data);
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPackageBusy(false);
      }
    })();
  }, []);

  const closePackagePreview = useCallback(() => {
    const token = packagePreview?.token;
    setPackagePreview(null);
    if (token) void ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_CANCEL, token);
  }, [packagePreview]);

  const handleConfirmCapabilityPackage = useCallback(() => {
    if (!packagePreview) return;
    const packageName = packagePreview.name;
    setPackageBusy(true);
    setNotice(null);
    void (async () => {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, packagePreview.token);
        if (!result.success) throw new Error(result.error);
        setPackagePreview(null);
        setNotice({
          type: 'success',
          text: `${pluginsText.manualImport.installedPrefix}${packageName}`,
        });
        await reload();
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
        setPackagePreview(null);
      } finally {
        setPackageBusy(false);
      }
    })();
  }, [packagePreview, pluginsText.manualImport.installedPrefix, reload]);

  const handleUninstallCapabilityPackage = useCallback((plugin: InstalledCapabilityPackage) => {
    if (!window.confirm(`${pluginsText.manualImport.uninstallConfirmPrefix}${plugin.name}${pluginsText.manualImport.uninstallConfirmSuffix}`)) return;
    void runAction(`capability-package:uninstall:${plugin.id}`, async () => {
      const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL, plugin.id);
      if (!result.success) throw new Error(result.error);
      return `${pluginsText.manualImport.uninstalledPrefix}${plugin.name}`;
    });
  }, [pluginsText.manualImport, runAction]);

  const handleInstallBundledCapabilityPackage = useCallback((plugin: InstalledCapabilityPackage) => {
    setPackageBusy(true);
    setNotice(null);
    void (async () => {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_BUNDLED, plugin.id);
        if (!result.success) throw new Error(result.error);
        setPackagePreview(result.data);
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPackageBusy(false);
      }
    })();
  }, []);

  const permissionLabel = useCallback((permission: CapabilityPackagePermission): string => (
    pluginsText.manualImport.permissions[permission]
  ), [pluginsText.manualImport.permissions]);

  // 页头走能力中心共用的 HubTabHeader：大标题「插件」+ 刷新同一行
  // （刷新原是「已安装」section 的 actions，提进页头操作簇与其余 tab 口径一致）。
  return (
    <div className="space-y-6">
      <HubTabHeader
        testId="plugins-hub-header"
        title={t.capabilityHub.tabPlugins}
        actions={(
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSelectCapabilityPackage}
              loading={packageBusy}
              disabled={loading || packageBusy}
              leftIcon={<Upload className="h-3.5 w-3.5" />}
            >
              {pluginsText.manualImport.action}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void reload()}
              loading={loading}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              {pluginsText.installed.refresh}
            </Button>
          </div>
        )}
      />
      {/* 操作结果通知（页面级，所有 section 的操作都在这里反馈） */}
      {notice && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
          notice.type === 'success'
            ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
            : 'border-red-500/30 bg-red-500/10 text-badge-danger'
        }`}
        >
          {notice.type === 'success' ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      <BundledCapabilitiesTab showHeader={false} />

      <SettingsSection
        title={pluginsText.manualImport.title}
        description={pluginsText.manualImport.description}
      >
        {capabilityPackages.length === 0 ? (
          <EmptyState text={pluginsText.manualImport.empty} />
        ) : (
          <div className="space-y-3">
            {capabilityPackages.map((plugin) => {
              const busy = busyKey === `capability-package:uninstall:${plugin.id}`;
              return (
                <div
                  key={plugin.id}
                  data-testid={`capability-package-${plugin.id}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
                        <Pill>{plugin.version}</Pill>
                        <Pill tone={plugin.state === 'active' ? 'success' : plugin.state === 'available' ? 'warning' : 'danger'}>
                          {plugin.state === 'active'
                            ? pluginsText.manualImport.active
                            : plugin.state === 'available'
                              ? pluginsText.manualImport.available
                              : pluginsText.manualImport.inactive}
                        </Pill>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-zinc-500">{plugin.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {plugin.permissions.map((permission) => <Pill key={permission}>{permissionLabel(permission)}</Pill>)}
                        {plugin.surface === 'internal-feature' ? (
                          <Pill tone="warning">{pluginsText.manualImport.internalFeature}</Pill>
                        ) : (
                          <Pill>{plugin.toolNames.length}{pluginsText.manualImport.toolsSuffix}</Pill>
                        )}
                      </div>
                      {plugin.error && <p className="mt-2 text-xs text-badge-danger">{plugin.error}</p>}
                    </div>
                    {plugin.state === 'available' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleInstallBundledCapabilityPackage(plugin)}
                        loading={packageBusy}
                        disabled={busyKey !== null || packageBusy}
                        leftIcon={<Download className="h-3.5 w-3.5" />}
                      >
                        {pluginsText.manualImport.install}
                      </Button>
                    ) : (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleUninstallCapabilityPackage(plugin)}
                        loading={busy}
                        disabled={busyKey !== null}
                        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                      >
                        {pluginsText.manualImport.uninstall}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {canAccessPluginAdmin && (
        <SettingsSection
          title={pluginsText.installed.title}
          description={pluginsText.installed.description}
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
                        {plugin.projectPath ? `${pluginsText.installed.projectPrefix}${toDisplayPath(plugin.projectPath)}` : ''}
                      </div>
                      {/* 安装目录只在下面「Plugin asset」格里出现一次：卡片名下再渲染一遍是重复外泄 */}
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
                      <span className="ml-2 break-all">{plugin.pluginRoot ? toDisplayPath(plugin.pluginRoot) : pluginsText.installed.none}</span>
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
      )}

      {canAccessPluginAdmin && (
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
                    <div
                      data-testid={`plugin-install-state-${spec}`}
                      data-state={installedPlugin ? 'installed' : installStates[spec] ?? 'idle'}
                      className="shrink-0"
                    >
                      {installedPlugin ? (
                        <PackageCheck className="h-5 w-5 text-badge-success" />
                      ) : installStates[spec] === 'installing' ? (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCancelInstall(spec)}
                          >
                            {pluginsText.marketplace.cancelInstall}
                          </Button>
                          <Button variant="secondary" size="sm" disabled>
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            {pluginsText.marketplace.installing}
                          </Button>
                        </div>
                      ) : installStates[spec] === 'cancelling' ? (
                        <Button variant="secondary" size="sm" disabled>
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          {pluginsText.marketplace.cancelling}
                        </Button>
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
      )}

      {canAccessPluginAdmin && (
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
            <Shield className="h-4 w-4 text-badge-warning" />
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
      )}

      {canAccessPluginAdmin && (
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
      )}

      {canAccessPluginAdmin && (
        <div data-testid="marketplace-source-management">
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
        </div>
      )}

      {canAccessPluginAdmin && (
        <SettingsDetails
          title={pluginsText.visibleList.title}
          description={pluginsText.visibleList.description}
        >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium text-badge-success">{pluginsText.visibleList.userVisibleTitle}</h4>
            {visibility.userVisible.length === 0 ? (
              <EmptyState text={pluginsText.visibleList.userVisibleEmpty} />
            ) : (
              <div className="space-y-2">
                {visibility.userVisible.map((item) => (
                  <div key={item.spec} className="rounded-lg border border-badge-success/20 bg-emerald-500/5 p-3">
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
            <h4 className="mb-2 text-xs font-medium text-badge-warning">{pluginsText.visibleList.adminOnlyTitle}</h4>
            {visibility.adminOnly.length === 0 ? (
              <EmptyState text={pluginsText.visibleList.adminOnlyEmpty} />
            ) : (
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {visibility.adminOnly.map((item) => (
                  <div key={`${item.kind}:${item.spec}`} className="rounded-lg border border-badge-warning/20 bg-amber-500/5 p-3">
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
      )}

      <Modal
        isOpen={packagePreview !== null}
        onClose={packageBusy ? undefined : closePackagePreview}
        closeOnBackdropClick={false}
        closeOnEsc={!packageBusy}
        title={pluginsText.manualImport.confirmTitle}
        headerIcon={<ShieldCheck className="h-5 w-5 text-badge-warning" />}
        size="lg"
        footer={(
          <ModalFooter
            cancelText={pluginsText.manualImport.cancel}
            confirmText={pluginsText.manualImport.confirm}
            onCancel={closePackagePreview}
            onConfirm={handleConfirmCapabilityPackage}
            cancelDisabled={packageBusy}
            confirmDisabled={packageBusy}
          />
        )}
      >
        {packagePreview && (
          <div className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">{packagePreview.name}</h3>
                <Pill>{packagePreview.version}</Pill>
                {packagePreview.surface === 'internal-feature' && (
                  <Pill tone="warning">{pluginsText.manualImport.internalFeature}</Pill>
                )}
                {packagePreview.replacesInstalledVersion && (
                  <Pill tone="warning">{pluginsText.manualImport.replacePrefix}{packagePreview.replacesInstalledVersion}</Pill>
                )}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{packagePreview.description}</p>
            </div>
            <div className="rounded-lg border border-badge-success/25 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-badge-success">
                <ShieldCheck className="h-4 w-4" />
                {packagePreview.sourceKind === 'bundled'
                  ? pluginsText.manualImport.bundledVerified
                  : pluginsText.manualImport.sandboxPassed}
              </div>
              <p className="mt-1 text-xs text-zinc-500">{packagePreview.sandbox.summary}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-zinc-200">{pluginsText.manualImport.permissionTitle}</h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{pluginsText.manualImport.permissionDescription}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {packagePreview.permissions.length === 0 ? (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-500">
                    {pluginsText.manualImport.noPermissions}
                  </div>
                ) : packagePreview.permissions.map((permission) => (
                  <div key={permission} className="rounded-lg border border-badge-warning/20 bg-amber-500/5 p-3 text-sm text-zinc-300">
                    {permissionLabel(permission)}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-500">
              {pluginsText.manualImport.failureEffect}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
