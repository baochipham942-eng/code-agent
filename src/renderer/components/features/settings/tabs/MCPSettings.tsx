// ============================================================================
// MCPSettings - MCP Server Status and Configuration Tab
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
  KeyRound,
  Loader2,
  Plug,
  PlugZap,
  Power,
  PowerOff,
  Cloud,
  Plus,
} from 'lucide-react';
import { useMcpStatus } from '../../../../hooks/useMcpStatus';
import { useWorkbenchInsights } from '../../../../hooks/useWorkbenchInsights';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useAuthStore } from '../../../../stores/authStore';
import { useAppStore } from '../../../../stores/appStore';
import { Button } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import { IPC_DOMAINS } from '@shared/ipc';
import { WebModeBanner } from '../WebModeBanner';
import { LocalBridgeSection } from '../sections/localBridge';
import { NativeConnectorsSection } from '../sections';
import { McpServerEditor, type McpServerConfig } from '../McpServerEditor';
import { McpDiscoverTab } from './McpDiscoverTab';
import { AlmaRegistryAuditPanel } from './AlmaRegistryAuditPanel';
import type { McpCatalogPayload, RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import {
  getBuiltinMcpCatalogPayload,
  mergeMcpCatalogWithBuiltinOfficialFeatured,
} from '@shared/constants/mcpCatalog';
import { WorkbenchCapabilityDetailButton } from '../../../workbench/WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../../../workbench/WorkbenchCapabilitySheetLite';
import {
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
  getMcpAuthenticationRecoveryMessage,
  getMcpAuthenticationRecoveryShortHint,
  isMcpAuthenticationFailure,
} from '../../../../utils/mcpRecovery';

const logger = createLogger('MCPSettings');

type McpViewTab = 'connected' | 'discover';

export function getMcpTrustSummary(server: WorkbenchMcpRegistryItem): string {
  const authHint = isMcpAuthenticationFailure(server)
    ? 'OAuth/token 需要重新授权'
    : '凭证默认 masked，不在列表明文展示';
  return `${server.transport} · ${server.toolCount} 工具 / ${server.resourceCount} 资源 · destructive/openWorld 调用前仍需审批 · ${authHint}`;
}

export const MCPSettings: React.FC = () => {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
  const setShowComputerUsePanel = useAppStore((s) => s.setShowComputerUsePanel);
  const settingsCapabilityFocus = useAppStore((s) => s.settingsCapabilityFocus);
  const clearSettingsCapabilityFocus = useAppStore((s) => s.clearSettingsCapabilityFocus);
  const canManageMcp = true;
  const [activeTab, setActiveTab] = useState<McpViewTab>('connected');
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
  const [reconnectingServer, setReconnectingServer] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorInitialConfig, setEditorInitialConfig] = useState<Partial<McpServerConfig> | undefined>(undefined);
  const [discoverActionLoading, setDiscoverActionLoading] = useState<string | null>(null);
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
        setMessage({ type: 'success', text: 'MCP 配置已从云端刷新' });
        await reloadMcpStatus();
      } else {
        setMessage({ type: 'error', text: result?.error?.message || '刷新失败' });
      }
    } catch {
      setMessage({ type: 'error', text: '刷新失败' });
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

  const handleReconnect = async (serverName: string) => {
    if (!canManageMcp) return;
    setReconnectingServer(serverName);
    try {
      const result = await window.domainAPI?.invoke<{ success: boolean; error?: string }>(
        IPC_DOMAINS.MCP, 'reconnectServer', { serverName }
      );
      // result.success 是 IPC 调用成功，result.data 是实际重连结果
      if (result?.success && result?.data?.success) {
        setMessage({ type: 'success', text: `${serverName} 重连成功` });
      } else {
        const errorMsg = result?.data?.error || '未知错误';
        setMessage({ type: 'error', text: `${serverName} 重连失败: ${errorMsg}` });
      }
      await reloadMcpStatus();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      setMessage({ type: 'error', text: `${serverName} 重连失败: ${errorMsg}` });
    } finally {
      setReconnectingServer(null);
    }
  };

  const handleReauthorize = useCallback((server: WorkbenchMcpRegistryItem) => {
    setMessage({ type: 'info', text: getMcpAuthenticationRecoveryMessage(server) });
  }, []);

  const handleAddServer = useCallback(async (config: McpServerConfig) => {
    if (!canManageMcp) return;
    try {
      const result = await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'addServer', { config });
      if (result?.success) {
        setMessage({ type: 'success', text: `服务器 "${config.name}" 已添加` });
        await reloadMcpStatus();
      } else {
        setMessage({ type: 'error', text: result?.error?.message || '添加服务器失败' });
      }
    } catch (error) {
      logger.error('Failed to add MCP server', error);
      setMessage({ type: 'error', text: '添加服务器失败' });
    }
  }, [reloadMcpStatus]);

  // ---- 发现连接：推荐 MCP 的三类动作 ----

  /** 免配置 server 一键连接 */
  const handleQuickConnect = useCallback(async (entry: RecommendedMcpServerEntry) => {
    if (!canManageMcp || !entry.connection) return;
    setDiscoverActionLoading(entry.id);
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
      await reloadMcpStatus();
    } finally {
      setDiscoverActionLoading(null);
    }
  }, [handleAddServer, reloadMcpStatus]);

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
    setDiscoverActionLoading(serverId);
    try {
      await handleToggleServer(serverId, true);
    } finally {
      setDiscoverActionLoading(null);
    }
  }, [handleToggleServer]);

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
      title="MCP"
      description="配置 Agent 可调用的外部工具服务器。运行状态和桥接诊断收在下方，不占主要设置流。"
    >
      <WebModeBanner />

      {(settingsCapabilityFocus?.kind === 'mcp' || settingsCapabilityFocus?.kind === 'connector') && (
        <div className="flex flex-col gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2 text-sm text-sky-100 sm:flex-row sm:items-center sm:justify-between">
          <div>
            来自会话页：正在处理 {settingsCapabilityFocus.kind === 'mcp' ? 'MCP' : 'Connector'} <span className="font-mono">{settingsCapabilityFocus.id}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSettingsCapabilityFocus}
          >
            关闭提示
          </Button>
        </div>
      )}

      <AlmaRegistryAuditPanel />

      {/* Tab 切换：已连接 / 发现连接 */}
      <div className="flex w-fit items-center gap-1 rounded-lg bg-zinc-800/80 p-1">
        {([
          ['connected', `已连接 (${serverSummary.total})`],
          ['discover', '发现连接'],
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
        title="MCP 管理台"
        description="集中查看 server 可用性、工具资源数量和主操作入口。"
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="flex flex-col gap-3 border-b border-zinc-700/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-200">服务器配置</div>
              <div className="mt-1 text-xs text-zinc-500">
                {serverSummary.total > 0
                  ? `${serverSummary.enabled}/${serverSummary.total} 已启用 · ${serverSummary.attention} 个需要处理`
                  : '还没有配置任何 MCP 服务器'}
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
                  {isRefreshing ? '刷新中...' : '从云端刷新 MCP 配置'}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setIsEditorOpen(true)}
                  leftIcon={<Plus className="w-3 h-3" />}
                >
                  添加服务器
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 sm:grid-cols-5">
            {[
              ['总览', `${serverSummary.connected}/${serverSummary.total}`, '已连接 / 全部'],
              ['工具', String(serverSummary.tools), '可调用工具'],
              ['资源', String(serverSummary.resources), '可访问资源'],
              ['启用', String(serverSummary.enabled), '配置开启'],
              ['处理', String(serverSummary.attention), '错误或断开'],
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
                  <th className="px-3 py-2 font-medium">服务器</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">协议</th>
                  <th className="px-3 py-2 font-medium">工具 / 资源</th>
                  <th className="px-3 py-2 font-medium">异常信息</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
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
                          <div className="text-sm font-medium text-zinc-200">没有配置任何 MCP 服务器</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {canManageMcp
                              ? '添加 server 后会在这里显示连接状态、工具数量和可用操作。'
                              : '配置 MCP 后，这里会显示可用状态。'}
                          </div>
                        </div>
                        {canManageMcp && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setIsEditorOpen(true)}
                            leftIcon={<Plus className="w-3 h-3" />}
                          >
                            添加服务器
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  mcpServers.map((server) => {
                    const serverStatus = getWorkbenchCapabilityStatusPresentation(server, { locale: 'zh' });
                    const statusClass = getStatusBadgeClass(server.lifecycle.connectionState);
                    const requiresReauthorization = isMcpAuthenticationFailure(server);

                    return (
                      <tr
                        key={server.id}
                        className="bg-zinc-900/40 hover:bg-zinc-800/60"
                        title={getWorkbenchCapabilityTitle(server, { locale: 'zh' })}
                      >
                        <td className="px-3 py-3 align-middle">
                          <div className="flex min-w-0 items-center gap-3">
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
                          <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                            {server.transport}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-300">
                          <span>{server.toolCount} 工具</span>
                          <span className="mx-2 text-zinc-600">/</span>
                          <span>{server.resourceCount} 资源</span>
                          <div className="mt-1 max-w-[260px] text-[11px] leading-snug text-zinc-500">
                            {getMcpTrustSummary(server)}
                          </div>
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
                          <div className="flex items-center justify-end gap-2">
                            <WorkbenchCapabilityDetailButton
                              label={server.label}
                              onClick={() => openCapabilitySheet(server)}
                            />
                            {canManageMcp && server.enabled && !server.available && (
                              requiresReauthorization ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => handleReauthorize(server)}
                                  leftIcon={<KeyRound className="w-3 h-3" />}
                                >
                                  重新授权
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleReconnect(server.id)}
                                  loading={reconnectingServer === server.id}
                                  leftIcon={<RefreshCw className="w-3 h-3" />}
                                >
                                  重连
                                </Button>
                              )
                            )}
                            {canManageMcp && (
                              <Button
                                size="sm"
                                variant={server.enabled ? 'ghost' : 'primary'}
                                onClick={() => handleToggleServer(server.id, !server.enabled)}
                                leftIcon={
                                  server.enabled ? (
                                    <PowerOff className="w-3 h-3" />
                                  ) : (
                                    <Power className="w-3 h-3" />
                                  )
                                }
                              >
                                {server.enabled ? '禁用' : '启用'}
                              </Button>
                            )}
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
          title="运行状态与本地桥接"
          description="这里用于排查连接、桥接和本地 connector 状态，默认收起。"
        >
          <div className="space-y-4">
            <LocalBridgeSection />
            <NativeConnectorsSection />
            {mcpStatus && (
              <div className="rounded-lg bg-zinc-800 p-4">
                <h4 className="text-sm font-medium text-zinc-200 mb-3">总览</h4>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-semibold text-zinc-200">
                      {mcpStatus.connectedServers.length}
                    </div>
                    <div className="text-xs text-zinc-400">已连接服务器</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-indigo-400">{mcpStatus.toolCount}</div>
                    <div className="text-xs text-zinc-400">可用工具</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-cyan-400">{mcpStatus.resourceCount}</div>
                    <div className="text-xs text-zinc-400">可用资源</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SettingsDetails>
      )}

      <SettingsDetails
        title="协议说明"
        description="MCP 的概念说明和自动连接行为。"
      >
        <p className="text-xs text-zinc-400 leading-relaxed">
          MCP (Model Context Protocol) 是一个开放协议，允许 AI 模型安全地访问外部工具和数据源。
          已配置的服务器会在应用启动时自动连接。云端配置支持热更新，无需重启应用。
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
