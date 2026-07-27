// ============================================================================
// MCPSettings - MCP Server Status and Configuration Tab
// （能力中心连接器 tab；默认落「发现连接」（新用户「已连接」是空的，先给推荐视角）。
// 已连接列表每行头部带连接状态点：
// 绿 = connected，灰 = 其他态，扫一眼就知道哪路连接器是活的）
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  KeyRound,
  Loader2,
  Plug,
  PlugZap,
  Cloud,
  Plus,
} from 'lucide-react';
import { useMcpStatus } from '../../../../hooks/useMcpStatus';
import { useStaleGuardedLoadingSet } from '../../../../hooks/useStaleGuardedLoadingSet';
import { useWorkbenchInsights } from '../../../../hooks/useWorkbenchInsights';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useAuthStore } from '../../../../stores/authStore';
import { useAppStore } from '../../../../stores/appStore';
import { Button, Toggle } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import { IPC_DOMAINS } from '@shared/ipc';
import { WebModeBanner } from '../WebModeBanner';
import { LocalBridgeSection } from '../sections/localBridge';
import { NativeConnectorsSection } from '../sections';
import {
  McpServerEditor,
  type McpServerConfig,
  type McpServerSaveSecrets,
} from '../McpServerEditor';
import { McpDiscoverTab } from './McpDiscoverTab';
import type { McpCatalogPayload, RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import {
  getBuiltinMcpCatalogPayload,
  mergeMcpCatalogWithBuiltinOfficialFeatured,
} from '@shared/constants/mcpCatalog';
import { WorkbenchCapabilityDetailButton } from '../../../workbench/WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../../../workbench/WorkbenchCapabilitySheetLite';
import {
  getMcpTrustSummary,
  getWorkbenchCapabilityStatusPresentation,
  getWorkbenchCapabilityTitle,
} from '../../../../utils/workbenchPresentation';
import type { WorkbenchMcpRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../../../utils/workbenchCapabilitySheet';
import {
  getMcpAuthenticationRecoveryShortHint,
  isMcpAuthenticationFailure,
} from '../../../../utils/mcpRecovery';
import { useI18n } from '../../../../hooks/useI18n';

const logger = createLogger('MCPSettings');

type McpViewTab = 'connected' | 'discover';

// getMcpTrustSummary 已上移到 workbenchPresentation（防御空值版本），
// 这里 re-export 保持既有引用/测试入口不变。
export { getMcpTrustSummary };

export const MCPSettings: React.FC = () => {
  const { t, language } = useI18n();
  const mcpText = t.settings.mcp;
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
  const setShowComputerUsePanel = useAppStore((s) => s.setShowComputerUsePanel);
  const settingsCapabilityFocus = useAppStore((s) => s.settingsCapabilityFocus);
  const clearSettingsCapabilityFocus = useAppStore((s) => s.clearSettingsCapabilityFocus);
  const canManageMcp = true;
  const [activeTab, setActiveTab] = useState<McpViewTab>('discover');
  const {
    status: mcpStatus,
    isLoading,
    reload: reloadMcpStatus,
  } = useMcpStatus();
  const { mcpServers } = useWorkbenchCapabilityRegistry();
  const { history } = useWorkbenchInsights();
  const {
    runningActionKey,
    actionErrors,
    completedActions,
    runQuickAction,
  } = useWorkbenchCapabilityQuickActionRunner();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorInitialConfig, setEditorInitialConfig] = useState<Partial<McpServerConfig> | undefined>(undefined);
  // 每个 entry 独立 loading + 代际防陈旧覆盖（A5 stale-promise 修复，见 hook 注释）
  const {
    loading: discoverActionLoading,
    begin: beginDiscoverAction,
    end: endDiscoverAction,
    isStale: isStaleDiscoverAction,
  } = useStaleGuardedLoadingSet();
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  // 推荐目录：内置数据为初始值，云端下发到达后覆盖
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogPayload>(getBuiltinMcpCatalogPayload);

  useEffect(() => {
    if (settingsCapabilityFocus?.kind === 'mcp' || settingsCapabilityFocus?.kind === 'connector') {
      setActiveTab('connected');
    }
  }, [settingsCapabilityFocus?.kind, settingsCapabilityFocus?.nonce]);

  // 加载云端 MCP 推荐目录（失败时保持内置兜底）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.domainAPI?.invoke<McpCatalogPayload>(IPC_DOMAINS.MCP, 'getCatalog');
        if (!cancelled && result?.success && result.data) {
          setMcpCatalog(mergeMcpCatalogWithBuiltinOfficialFeatured(result.data));
        }
      } catch (error) {
        logger.warn('Failed to load MCP catalog from cloud, using builtin fallback', { error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeSheetCapability = useMemo(
    () => resolveWorkbenchCapabilityFromSources({
      target: activeSheetTarget,
      primaryItems: mcpServers,
    }),
    [activeSheetTarget, mcpServers],
  );
  const activeSheetHistory = useMemo(
    () => activeSheetTarget ? findWorkbenchCapabilityHistoryItem(history, activeSheetTarget) : null,
    [activeSheetTarget, history],
  );
  const serverSummary = useMemo(() => {
    const connectedCount = mcpStatus?.connectedServers.length
      ?? mcpServers.filter((server) => server.lifecycle.connectionState === 'connected').length;
    const toolCount = mcpStatus?.toolCount
      ?? mcpServers.reduce((sum, server) => sum + server.toolCount, 0);
    const resourceCount = mcpStatus?.resourceCount
      ?? mcpServers.reduce((sum, server) => sum + server.resourceCount, 0);
    const attentionCount = mcpServers.filter((server) => (
      server.lifecycle.connectionState === 'error'
      || (server.enabled && server.lifecycle.connectionState === 'disconnected')
    )).length;

    return {
      total: mcpServers.length,
      connected: connectedCount,
      enabled: mcpServers.filter((server) => server.enabled).length,
      attention: attentionCount,
      tools: toolCount,
      resources: resourceCount,
    };
  }, [mcpServers, mcpStatus]);

  // 自动清除成功消息
  useEffect(() => {
    if (message?.type === 'success') {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleRefreshFromCloud = async () => {
    if (!canManageMcp) return;
    setIsRefreshing(true);
    setMessage(null);
    try {
      const result = await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'refreshFromCloud');
      if (result?.success) {
        setMessage({ type: 'success', text: mcpText.toast.refreshSuccess });
        await reloadMcpStatus();
      } else {
        setMessage({ type: 'error', text: result?.error?.message || mcpText.toast.refreshFailed });
      }
    } catch {
      setMessage({ type: 'error', text: mcpText.toast.refreshFailed });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleToggleServer = async (serverName: string, enabled: boolean) => {
    if (!canManageMcp) return;
    try {
      const result = await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'setServerEnabled', {
        serverName,
        enabled,
      });
      if (result?.success) {
        await reloadMcpStatus();
      }
    } catch (error) {
      logger.error('Failed to toggle server', error);
    }
  };

  const handleAddServer = useCallback(async (
    config: McpServerConfig,
    secrets?: McpServerSaveSecrets,
  ) => {
    if (!canManageMcp) return;
    try {
      const result = await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'addServer', {
        config,
        scope: 'user',
        ...(secrets?.secretEnvKeys.length ? { secretEnvKeys: secrets.secretEnvKeys } : {}),
        ...(secrets?.secretHeaderKeys.length ? { secretHeaderKeys: secrets.secretHeaderKeys } : {}),
      });
      if (result?.success) {
        setMessage({
          type: 'success',
          text: `${mcpText.toast.addServerSuccessPrefix}${config.name}${mcpText.toast.addServerSuccessSuffix}`,
        });
        await reloadMcpStatus();
      } else {
        setMessage({ type: 'error', text: result?.error?.message || mcpText.toast.addServerFailed });
      }
    } catch (error) {
      logger.error('Failed to add MCP server', error);
      setMessage({ type: 'error', text: mcpText.toast.addServerFailed });
    }
  }, [mcpText, reloadMcpStatus]);

  // ---- 发现连接：推荐 MCP 的三类动作 ----

  /** 免配置 server 一键连接 */
  const handleQuickConnect = useCallback(async (entry: RecommendedMcpServerEntry) => {
    if (!canManageMcp || !entry.connection) return;
    const generation = beginDiscoverAction(entry.id);
    try {
      await handleAddServer({
        name: entry.id,
        type: entry.connection.type,
        command: entry.connection.command,
        args: entry.connection.args,
        env: entry.connection.env,
        url: entry.connection.url,
        headers: entry.connection.headers,
      });
      if (isStaleDiscoverAction(entry.id, generation)) {
        // 这条 add 在同一 entry 的新一轮操作已经取代它之后才成功落地——
        // 静默完成的写入会变成幽灵 server，主动撤销（A5 stale-promise 回滚）。
        await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'removeServer', { serverName: entry.id }).catch(() => {});
        return;
      }
      await reloadMcpStatus();
    } finally {
      endDiscoverAction(entry.id, generation);
    }
  }, [handleAddServer, reloadMcpStatus, beginDiscoverAction, endDiscoverAction, isStaleDiscoverAction]);

  /** 需要凭证的 server：打开预填编辑器让用户补凭证 */
  const handleConnectWithConfig = useCallback((entry: RecommendedMcpServerEntry) => {
    if (!canManageMcp || !entry.connection) return;
    setEditorInitialConfig({
      name: entry.id,
      type: entry.connection.type,
      command: entry.connection.command,
      args: entry.connection.args,
      env: entry.connection.env,
      url: entry.connection.url,
      headers: entry.connection.headers,
    });
    setIsEditorOpen(true);
  }, []);

  /** 内置 server 启用 */
  const handleEnableBuiltin = useCallback(async (serverId: string) => {
    if (!canManageMcp) return;
    const generation = beginDiscoverAction(serverId);
    try {
      await handleToggleServer(serverId, true);
    } finally {
      endDiscoverAction(serverId, generation);
    }
  }, [handleToggleServer, beginDiscoverAction, endDiscoverAction]);

  const openCapabilitySheet = useCallback((server: WorkbenchMcpRegistryItem) => {
    setActiveSheetTarget({
      kind: server.kind,
      id: server.id,
    });
  }, []);

  const getStatusIcon = (status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'lazy' | 'not_applicable') => {
    switch (status) {
      case 'connected':
        return <PlugZap className="w-4 h-4 text-green-400" />;
      case 'connecting':
        return <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      case 'lazy':
        return <Plug className="w-4 h-4 text-sky-400" />;
      default:
        return <Plug className="w-4 h-4 text-zinc-400" />;
    }
  };

  const getStatusBadgeClass = (status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'lazy' | 'not_applicable') => {
    switch (status) {
      case 'connected':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
      case 'connecting':
        return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
      case 'error':
        return 'border-red-500/30 bg-red-500/10 text-red-300';
      case 'lazy':
        return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
      default:
        return 'border-zinc-700 bg-zinc-800 text-zinc-400';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <SettingsPage
      title={mcpText.title}
      description={mcpText.description}
    >
      <WebModeBanner />

      {(settingsCapabilityFocus?.kind === 'mcp' || settingsCapabilityFocus?.kind === 'connector') && (
        <div className="flex flex-col gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2 text-sm text-sky-100 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {mcpText.focusPromptPrefix}
            {settingsCapabilityFocus.kind === 'mcp' ? mcpText.focusPromptKindMcp : mcpText.focusPromptKindConnector}
            {' '}
            <span className="font-mono">{settingsCapabilityFocus.id}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSettingsCapabilityFocus}
          >
            {mcpText.closeFocusPrompt}
          </Button>
        </div>
      )}

      {/* Tab 切换：已连接 / 发现连接 */}
      <div className="flex w-fit items-center gap-1 rounded-lg bg-zinc-800/80 p-1">
        {([
          ['connected', `${mcpText.tabs.connectedPrefix}${serverSummary.total}${mcpText.tabs.connectedSuffix}`],
          ['discover', mcpText.tabs.discover],
        ] as Array<[McpViewTab, string]>).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'discover' && (
        <McpDiscoverTab
          catalog={mcpCatalog}
          existingServerIds={new Set(mcpServers.map((server) => server.id))}
          enabledServerIds={new Set(mcpServers.filter((server) => server.enabled).map((server) => server.id))}
          canManageMcp={canManageMcp}
          actionLoading={discoverActionLoading}
          onQuickConnect={handleQuickConnect}
          onConnectWithConfig={handleConnectWithConfig}
          onEnableBuiltin={handleEnableBuiltin}
          onOpenComputerUsePanel={() => setShowComputerUsePanel(true)}
        />
      )}

      {activeTab === 'connected' && (<>
      <SettingsSection
        title={mcpText.management.title}
        description={mcpText.management.description}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="flex flex-col gap-3 border-b border-zinc-700/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-200">{mcpText.management.serverConfig}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {serverSummary.total > 0
                  ? `${serverSummary.enabled}/${serverSummary.total}${mcpText.management.enabledCountSuffix}${serverSummary.attention}${mcpText.management.attentionCountSuffix}`
                  : mcpText.management.noServersConfigured}
              </div>
            </div>
            {canManageMcp && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleRefreshFromCloud}
                  loading={isRefreshing}
                  leftIcon={!isRefreshing ? <Cloud className="w-3 h-3" /> : undefined}
                >
                  {isRefreshing ? mcpText.management.refreshing : mcpText.management.refreshFromCloud}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setIsEditorOpen(true)}
                  leftIcon={<Plus className="w-3 h-3" />}
                >
                  {mcpText.management.addServer}
                </Button>
              </div>
            )}
          </div>

          {/* 页面级安全说明：审批/凭证 mask 是所有 server 的共同事实，只在列表标题下放一行，
              不再逐行重复；每台 server 的差异信息仍在详情弹层可见 */}
          <div
            data-testid="mcp-trust-summary-note"
            className="border-b border-zinc-700/60 px-3 py-2 text-[11px] text-zinc-500"
          >
            {mcpText.trustSummary.approvalNotice} · {mcpText.trustSummary.authMaskedHint}
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 sm:grid-cols-5">
            {[
              [
                mcpText.management.stats.overview.label,
                `${serverSummary.connected}/${serverSummary.total}`,
                mcpText.management.stats.overview.caption,
              ],
              [mcpText.management.stats.tools.label, String(serverSummary.tools), mcpText.management.stats.tools.caption],
              [mcpText.management.stats.resources.label, String(serverSummary.resources), mcpText.management.stats.resources.caption],
              [mcpText.management.stats.enabled.label, String(serverSummary.enabled), mcpText.management.stats.enabled.caption],
              [mcpText.management.stats.attention.label, String(serverSummary.attention), mcpText.management.stats.attention.caption],
            ].map(([label, value, caption]) => (
              <div
                key={label}
                className="bg-zinc-900/80 px-3 py-3"
              >
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          {message && (
            <div
              className={`mx-3 mt-3 flex items-center gap-2 rounded-md px-3 py-2 ${
                message.type === 'success'
                  ? 'bg-green-500/10 text-green-400'
                  : message.type === 'info'
                    ? 'bg-sky-500/10 text-sky-300'
                    : 'bg-red-500/10 text-red-400'
              }`}
            >
              {message.type === 'success' ? (
                <CheckCircle className="w-4 h-4" />
              ) : message.type === 'info' ? (
                <KeyRound className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              <span className="text-sm">{message.text}</span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{mcpText.management.table.server}</th>
                  <th className="px-3 py-2 font-medium">{mcpText.management.table.status}</th>
                  <th className="px-3 py-2 font-medium">{mcpText.management.table.protocol}</th>
                  <th className="px-3 py-2 font-medium">{mcpText.management.table.toolsResources}</th>
                  <th className="px-3 py-2 font-medium">{mcpText.management.table.errorInfo}</th>
                  <th className="px-3 py-2 text-right font-medium">{mcpText.management.table.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {mcpServers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center">
                      <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800">
                          <Plug className="h-5 w-5 text-zinc-500" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-zinc-200">{mcpText.management.empty.title}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {canManageMcp
                              ? mcpText.management.empty.manageDescription
                              : mcpText.management.empty.readonlyDescription}
                          </div>
                        </div>
                        {canManageMcp && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setIsEditorOpen(true)}
                            leftIcon={<Plus className="w-3 h-3" />}
                          >
                            {mcpText.management.addServer}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  mcpServers.map((server) => {
                    const serverStatus = getWorkbenchCapabilityStatusPresentation(server, { locale: language });
                    const statusClass = getStatusBadgeClass(server.lifecycle.connectionState);
                    const requiresReauthorization = isMcpAuthenticationFailure(server);
                    const isOAuthServer = server.authMode === 'oauth';
                    // 计数只在真正加载过（connected）后展示；未连接/懒加载未触发时没有计数这回事
                    const hasLoadedCounts = server.lifecycle.connectionState === 'connected'
                      && Number.isFinite(server.toolCount)
                      && Number.isFinite(server.resourceCount);

                    return (
                      <tr
                        key={server.id}
                        className="bg-zinc-900/40 hover:bg-zinc-800/60"
                        title={getWorkbenchCapabilityTitle(server, { locale: language })}
                      >
                        <td className="px-3 py-3 align-middle">
                          <div className="flex min-w-0 items-center gap-3">
                            {/* 连接状态点：绿=connected，灰=其他态；细节仍由状态列的徽章文案承担 */}
                            <span
                              data-testid={`mcp-server-status-dot-${server.id}`}
                              aria-hidden="true"
                              className={`h-2 w-2 flex-shrink-0 rounded-full ${server.lifecycle.connectionState === 'connected' ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                            />
                            {getStatusIcon(server.lifecycle.connectionState)}
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-zinc-200">{server.label}</div>
                              <div className="mt-0.5 truncate text-[11px] text-zinc-500">{server.id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span className={`inline-flex items-center rounded border px-2 py-1 ${statusClass}`}>
                            {serverStatus.label}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {server.transport ? (
                            <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                              {server.transport}
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-300">
                          {hasLoadedCounts ? (
                            <>
                              <span>{server.toolCount}{mcpText.management.countToolSuffix}</span>
                              <span className="mx-2 text-zinc-600">/</span>
                              <span>{server.resourceCount}{mcpText.management.countResourceSuffix}</span>
                            </>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                          {isOAuthServer && (
                            <div className="mt-1 text-[11px] leading-snug text-zinc-400">
                              {mcpText.management.oauthStatusLabel}
                              <span className={server.hasOAuthTokens ? 'text-emerald-300' : 'text-amber-300'}>
                                {server.hasOAuthTokens
                                  ? mcpText.management.oauthAuthorized
                                  : mcpText.management.oauthNotAuthorized}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="max-w-[220px] px-3 py-3 align-middle">
                          {server.error ? (
                            <div>
                              <span className="block truncate text-red-400" title={server.error}>
                                {server.error}
                              </span>
                              {requiresReauthorization && (
                                <span className="mt-1 block text-[11px] text-amber-300">
                                  {getMcpAuthenticationRecoveryShortHint(server)}
                                </span>
                              )}
                            </div>
                          ) : server.blockedReason ? (
                            <div>
                              <span className="block truncate text-yellow-300" title={server.blockedReason.detail}>
                                {server.blockedReason.detail}
                              </span>
                              {requiresReauthorization && (
                                <span className="mt-1 block text-[11px] text-amber-300">
                                  {getMcpAuthenticationRecoveryShortHint(server)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-zinc-600">-</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {/* 行尾操作全列表统一：启用/禁用开关 + 详情入口；
                              重连/重新授权/退出授权收进详情弹层的 quick actions */}
                          <div className="flex items-center justify-end gap-2">
                            {canManageMcp && (
                              <Toggle
                                checked={server.enabled}
                                onChange={(enabled) => handleToggleServer(server.id, enabled)}
                                aria-label={`${server.enabled ? mcpText.management.disable : mcpText.management.enable} ${server.label}`}
                                title={`${server.enabled ? mcpText.management.disable : mcpText.management.enable} ${server.label}`}
                              />
                            )}
                            <WorkbenchCapabilityDetailButton
                              label={server.label}
                              onClick={() => openCapabilitySheet(server)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      {isAdmin && (
        <SettingsDetails
          title={mcpText.diagnostics.title}
          description={mcpText.diagnostics.description}
        >
          <div className="space-y-4">
            <LocalBridgeSection />
            <NativeConnectorsSection />
            {mcpStatus && (
              <div className="rounded-lg bg-zinc-800 p-4">
                <h4 className="text-sm font-medium text-zinc-200 mb-3">{mcpText.diagnostics.overview}</h4>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-semibold text-zinc-200">
                      {mcpStatus.connectedServers.length}
                    </div>
                    <div className="text-xs text-zinc-400">{mcpText.diagnostics.connectedServers}</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-indigo-400">{mcpStatus.toolCount}</div>
                    <div className="text-xs text-zinc-400">{mcpText.diagnostics.availableTools}</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-cyan-400">{mcpStatus.resourceCount}</div>
                    <div className="text-xs text-zinc-400">{mcpText.diagnostics.availableResources}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SettingsDetails>
      )}

      <SettingsDetails
        title={mcpText.protocol.title}
        description={mcpText.protocol.description}
      >
        <p className="text-xs text-zinc-400 leading-relaxed">
          {mcpText.protocol.body}
        </p>
      </SettingsDetails>
      </>)}

      {/* Add Server Editor Modal */}
      <McpServerEditor
        isOpen={isEditorOpen}
        onClose={() => {
          setIsEditorOpen(false);
          setEditorInitialConfig(undefined);
        }}
        onSave={handleAddServer}
        initialConfig={editorInitialConfig}
      />

      <WorkbenchCapabilitySheetLite
        isOpen={Boolean(activeSheetCapability)}
        capability={activeSheetCapability}
        historyItem={activeSheetHistory}
        runningActionKey={runningActionKey}
        actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
        completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
        onQuickAction={runQuickAction}
        onClose={() => setActiveSheetTarget(null)}
      />
    </SettingsPage>
  );
};
