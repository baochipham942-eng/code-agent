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
import ipcService from '../../../../services/ipcService';
import { Button } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';

type Notice = { type: 'success' | 'error'; text: string };

export interface PluginVisibilityItem {
  spec: string;
  name: string;
  marketplace: string;
  kind: 'installed' | 'available';
  isEnabled: boolean;
  scope?: PluginScope;
  skills: string[];
  reason: string;
}

export interface PluginVisibilityAssessment {
  userVisible: PluginVisibilityItem[];
  adminOnly: PluginVisibilityItem[];
  installedTotal: number;
  enabledTotal: number;
  catalogTotal: number;
}

export const PLUGIN_COMPLETENESS_ROWS = [
  { area: '市场源', status: 'complete', detail: '可新增、刷新、移除 marketplace，并展示缓存位置与插件数量。' },
  { area: '发现', status: 'complete', detail: '可按市场源、关键词、标签、作者、skill、command 过滤插件目录。' },
  { area: '安装', status: 'complete', detail: '支持用户级和项目级安装；安装后保持禁用，需要管理员显式启用。' },
  { area: '生命周期', status: 'complete', detail: '已安装插件可启用、禁用、卸载，并回读最新状态。' },
  { area: '权限', status: 'complete', detail: '前端入口和后端 marketplace IPC 都只对管理员开放。' },
  { area: '治理', status: 'partial', detail: '已展示来源、路径、scope 和安装时间；签名校验、审核流、版本升级策略还没有前端闭环。' },
] as const;

export function getPluginSpec(plugin: Pick<MarketplacePluginEntry | InstalledPlugin, 'name' | 'marketplace'>): string {
  return `${plugin.name}@${plugin.marketplace}`;
}

export function getPluginTrustSummary(plugin: Pick<MarketplacePluginEntry | InstalledPlugin, 'skills'> & {
  commands?: string[];
  permissions?: string[];
  hooks?: string[];
}): string {
  const skills = normalizeList(plugin.skills).length;
  const commands = normalizeList(plugin.commands).length;
  const permissions = normalizeList(plugin.permissions).length;
  const hooks = normalizeList(plugin.hooks).length;
  return `Trust: ${skills} skills · ${commands} commands · ${permissions || '未声明'} permissions · ${hooks || '未声明'} hooks · 外部服务未声明时按未知风险处理`;
}

function normalizeList(values?: string[]): string[] {
  return values?.filter(Boolean) ?? [];
}

export function buildPluginVisibilityAssessment({
  catalog,
  installed,
}: {
  catalog: MarketplacePluginEntry[];
  installed: InstalledPlugin[];
}): PluginVisibilityAssessment {
  const installedBySpec = new Map(installed.map((plugin) => [getPluginSpec(plugin), plugin]));
  const userVisible: PluginVisibilityItem[] = [];
  const adminOnly: PluginVisibilityItem[] = [];

  for (const plugin of installed) {
    const item: PluginVisibilityItem = {
      spec: getPluginSpec(plugin),
      name: plugin.name,
      marketplace: plugin.marketplace,
      kind: 'installed',
      isEnabled: plugin.isEnabled,
      scope: plugin.scope,
      skills: normalizeList(plugin.skills),
      reason: plugin.isEnabled
        ? '已启用，普通用户能在能力/Skill/Command 运行面看到它暴露的能力。'
        : '已安装但未启用，只能由管理员在插件管理里看到和处理。',
    };

    if (plugin.isEnabled) {
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
      skills: normalizeList(plugin.skills),
      reason: '市场目录中的未安装插件，不进入普通用户运行面。',
    });
  }

  return {
    userVisible,
    adminOnly,
    installedTotal: installed.length,
    enabledTotal: userVisible.length,
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
      ...(plugin.tags ?? []),
      ...(plugin.skills ?? []),
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

function formatDate(value?: string): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getResultError(result?: MarketplaceResult<unknown> | PluginInstallResult): string {
  return result?.error || '操作失败';
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

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/35 px-4 py-6 text-center text-sm text-zinc-500">
    {text}
  </div>
);

export const PluginsSettings: React.FC = () => {
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
        '读取 marketplace 失败',
      );
      const catalogState = normalizeMarketplaceResult<MarketplacePluginEntry[]>(
        catalogResult,
        '读取插件市场失败',
      );
      const installedState = normalizeMarketplaceResult<InstalledPlugin[]>(
        installedResult,
        '读取已安装插件失败',
      );

      if (!marketplacesState.success) throw new Error(getResultError(marketplacesState));
      if (!catalogState.success) throw new Error(getResultError(catalogState));
      if (!installedState.success) throw new Error(getResultError(installedState));

      setMarketplaces(marketplacesState.data ?? []);
      setCatalog(catalogState.data ?? []);
      setInstalled(installedState.data ?? []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text });
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredCatalog = useMemo(
    () => filterMarketplacePlugins({ plugins: catalog, query, marketplace: selectedMarketplace }),
    [catalog, query, selectedMarketplace],
  );

  const visibility = useMemo(
    () => buildPluginVisibilityAssessment({ catalog, installed }),
    [catalog, installed],
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
      setNotice({ type: 'error', text: '先填 marketplace 源地址或本地目录。' });
      return;
    }

    void runAction('marketplace:add', async () => {
      const result = normalizeMarketplaceResult<MarketplaceInfo>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_ADD, source),
        '添加 marketplace 失败',
      );
      if (!result.success) throw new Error(getResultError(result));
      setNewMarketplaceSource('');
      return `已添加 marketplace：${result.data?.name || source}`;
    });
  }, [newMarketplaceSource, runAction]);

  const handleRefreshMarketplace = useCallback((name?: string) => {
    const key = name ? `marketplace:refresh:${name}` : 'marketplace:refresh:all';
    void runAction(key, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_REFRESH, name),
        '刷新 marketplace 失败',
      );
      if (!result.success) throw new Error(getResultError(result));
      return name ? `已刷新 marketplace：${name}` : '已刷新全部 marketplace';
    });
  }, [runAction]);

  const handleRemoveMarketplace = useCallback((name: string) => {
    if (!window.confirm(`移除 marketplace「${name}」？已安装插件不会自动卸载。`)) return;
    void runAction(`marketplace:remove:${name}`, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_REMOVE, name),
        '移除 marketplace 失败',
      );
      if (!result.success) throw new Error(getResultError(result));
      return `已移除 marketplace：${name}`;
    });
  }, [runAction]);

  const handleInstall = useCallback((plugin: MarketplacePluginEntry) => {
    const spec = getPluginSpec(plugin);
    void runAction(`plugin:install:${spec}`, async () => {
      const options = installScope === 'project'
        ? { scope: installScope, projectPath: projectPath.trim() || undefined }
        : { scope: installScope };
      const result = await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, spec, options);
      if (!result?.success) throw new Error(getResultError(result));
      return `已安装 ${spec}，默认保持禁用。`;
    });
  }, [installScope, projectPath, runAction]);

  const handleToggle = useCallback((plugin: InstalledPlugin) => {
    const spec = getPluginSpec(plugin);
    void runAction(`plugin:toggle:${spec}`, async () => {
      const result = plugin.isEnabled
        ? normalizeMarketplaceResult<void>(
          await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_DISABLE_PLUGIN, spec),
          '禁用插件失败',
        )
        : normalizeMarketplaceResult<void>(
          await ipcService.invoke(IPC_CHANNELS.MARKETPLACE_ENABLE_PLUGIN, spec),
          '启用插件失败',
        );
      if (!result.success) throw new Error(getResultError(result));
      return plugin.isEnabled ? `已禁用 ${spec}` : `已启用 ${spec}`;
    });
  }, [runAction]);

  const handleUninstall = useCallback((plugin: InstalledPlugin) => {
    const spec = getPluginSpec(plugin);
    if (!window.confirm(`卸载插件「${spec}」？这会移除它安装的 skills 和 commands。`)) return;
    void runAction(`plugin:uninstall:${spec}`, async () => {
      const result = normalizeMarketplaceResult<void>(
        await ipcService.invoke(
          IPC_CHANNELS.MARKETPLACE_UNINSTALL_PLUGIN,
          spec,
          plugin.scope,
        ),
        '卸载插件失败',
      );
      if (!result.success) throw new Error(getResultError(result));
      return `已卸载 ${spec}`;
    });
  }, [runAction]);

  if (!isAdmin) {
    return (
      <SettingsPage
        title="插件管理"
        description="插件市场和生命周期管理需要管理员权限。"
      >
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          当前用户不能查看 marketplace 插件目录，也不能安装、启用或卸载插件。
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="插件管理"
      description="管理 marketplace、插件安装和启停状态；普通用户只会接触启用后暴露出来的能力。"
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
        title="已安装插件"
        description="禁用状态下只对管理员可见；启用后才进入普通用户运行面。"
        actions={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        {loading ? (
          <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40 py-8 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取插件状态
          </div>
        ) : installed.length === 0 ? (
          <EmptyState text="还没有安装任何 marketplace 插件。" />
        ) : (
          <div className="space-y-3">
            {installed.map((plugin) => {
              const spec = getPluginSpec(plugin);
              const busy = busyKey === `plugin:toggle:${spec}` || busyKey === `plugin:uninstall:${spec}`;
              return (
                <div key={spec} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
                        <Pill>{plugin.marketplace}</Pill>
                        <Pill>{plugin.scope}</Pill>
                        <Pill tone={plugin.isEnabled ? 'success' : 'warning'}>
                          {plugin.isEnabled ? '普通用户可见' : '仅管理员可见'}
                        </Pill>
                      </div>
                      <div className="mt-2 text-xs leading-5 text-zinc-500">
                        安装时间 {formatDate(plugin.installedAt)}
                        {plugin.projectPath ? ` · 项目 ${plugin.projectPath}` : ''}
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
                        {plugin.isEnabled ? '禁用' : '启用'}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={busyKey === `plugin:uninstall:${spec}`}
                        disabled={busy}
                        onClick={() => handleUninstall(plugin)}
                        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                      >
                        卸载
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs text-zinc-500">
                      <span className="text-zinc-300">Skills</span>
                      <span className="ml-2">{plugin.skills.length ? plugin.skills.join(' · ') : '无'}</span>
                    </div>
                    <div className="rounded-md bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-500">
                      <span className="text-zinc-300">Trust</span>
                      <span className="ml-2">{getPluginTrustSummary(plugin)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="插件市场"
        description="安装只复制插件资源，不自动启用；启用前普通用户不可见。"
      >
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_160px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索插件、skill、command、标签"
                className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
              />
            </label>
            <select
              value={selectedMarketplace}
              onChange={(event) => setSelectedMarketplace(event.target.value)}
              className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden focus:border-zinc-500"
              aria-label="选择 marketplace"
            >
              <option value="all">全部市场</option>
              {marketplaces.map((marketplace) => (
                <option key={marketplace.name} value={marketplace.name}>{marketplace.name}</option>
              ))}
            </select>
            <select
              value={installScope}
              onChange={(event) => setInstallScope(event.target.value as PluginScope)}
              className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden focus:border-zinc-500"
              aria-label="安装 scope"
            >
              <option value="user">用户级安装</option>
              <option value="project">项目级安装</option>
            </select>
          </div>
          {installScope === 'project' && (
            <input
              type="text"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="项目路径，留空时使用当前工作目录"
              className="mt-3 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
            />
          )}
        </div>

        {filteredCatalog.length === 0 ? (
          <EmptyState text={catalog.length === 0 ? '当前 marketplace 目录为空。' : '没有匹配的插件。'} />
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
                        {plugin.version && <Pill>v{plugin.version}</Pill>}
                        {installedPlugin ? (
                          <Pill tone={installedPlugin.isEnabled ? 'success' : 'warning'}>
                            {installedPlugin.isEnabled ? '已启用' : '已安装未启用'}
                          </Pill>
                        ) : (
                          <Pill tone="warning">仅管理员可见</Pill>
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
                        安装
                      </Button>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(plugin.tags ?? []).slice(0, 6).map((tag) => (
                      <Pill key={tag}>{tag}</Pill>
                    ))}
                    {(plugin.skills ?? []).length > 0 && <Pill>{plugin.skills?.length} skills</Pill>}
                  </div>
                  <div className="mt-3 rounded-md bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-500">
                    <span className="text-zinc-300">Trust</span>
                    <span className="ml-2">{getPluginTrustSummary(plugin)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsDetails
        title="管理概览"
        description="插件规模统计与角色可见性说明，默认收起。"
      >
        <div className="grid gap-3 md:grid-cols-5">
          <SummaryTile label="Marketplace" value={marketplaces.length} />
          <SummaryTile label="市场插件" value={catalog.length} />
          <SummaryTile label="已安装" value={visibility.installedTotal} />
          <SummaryTile label="已启用" value={visibility.enabledTotal} tone="success" />
          <SummaryTile label="仅管理员可见" value={visibility.adminOnly.length} tone="warning" />
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Shield className="h-4 w-4 text-amber-300" />
            角色可见性
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">管理员</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                可见 marketplace、未安装插件、禁用插件和全部生命周期操作。
              </p>
            </div>
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">普通用户</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                不显示插件管理面板；只在运行面看到已启用插件提供的 skills、commands 或能力。
              </p>
            </div>
            <div className="rounded-lg bg-zinc-950/60 p-3">
              <div className="text-xs font-medium text-zinc-300">安装策略</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                安装后保持禁用，由管理员复核后再启用。
              </p>
            </div>
          </div>
        </div>
      </SettingsDetails>

      <SettingsDetails
        title="完整性评估"
        description="前端插件管理闭环的开放状态，默认收起。"
      >
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">模块</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/30">
              {PLUGIN_COMPLETENESS_ROWS.map((row) => (
                <tr key={row.area}>
                  <td className="px-3 py-2 text-zinc-300">{row.area}</td>
                  <td className="px-3 py-2">
                    <Pill tone={row.status === 'complete' ? 'success' : 'warning'}>
                      {row.status === 'complete' ? '已开放' : '部分'}
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
        title="Marketplace 源"
        description="新增支持本地目录、GitHub repo、URL、npm 包等后端已支持的源格式。"
      >
        <div className="flex flex-col gap-3 md:flex-row">
          <input
            type="text"
            value={newMarketplaceSource}
            onChange={(event) => setNewMarketplaceSource(event.target.value)}
            placeholder="dir:/path/to/plugins 或 owner/repo"
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
            添加
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleRefreshMarketplace()}
            loading={busyKey === 'marketplace:refresh:all'}
            disabled={busyKey !== null}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            全部刷新
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {marketplaces.length === 0 ? (
            <EmptyState text="还没有配置 marketplace 源。" />
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
                      缓存 {marketplace.installLocation} · 更新 {formatDate(marketplace.lastUpdated)}
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
                      刷新
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleRemoveMarketplace(marketplace.name)}
                      loading={busyKey === `marketplace:remove:${marketplace.name}`}
                      disabled={busyKey !== null}
                      leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsDetails>

      <SettingsDetails
        title="可见插件清单"
        description="按当前安装与启用状态拆分管理员可见和普通用户可见，默认收起。"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium text-emerald-300">普通用户可见</h4>
            {visibility.userVisible.length === 0 ? (
              <EmptyState text="当前没有启用插件进入普通用户运行面。" />
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
            <h4 className="mb-2 text-xs font-medium text-amber-300">仅管理员可见</h4>
            {visibility.adminOnly.length === 0 ? (
              <EmptyState text="没有仅管理员可见的插件记录。" />
            ) : (
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {visibility.adminOnly.map((item) => (
                  <div key={`${item.kind}:${item.spec}`} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{item.spec}</span>
                      <Pill tone="warning">{item.kind === 'installed' ? '已安装未启用' : '未安装'}</Pill>
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
