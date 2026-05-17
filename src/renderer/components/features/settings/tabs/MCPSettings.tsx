// ============================================================================
// MCPSettings - MCP Server Status and Configuration Tab
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
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
import { Button } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import { IPC_DOMAINS } from '@shared/ipc';
import { WebModeBanner } from '../WebModeBanner';
import { LocalBridgeSection } from '../sections/localBridge';
import { NativeConnectorsSection } from '../sections';
import { McpServerEditor, type McpServerConfig } from '../McpServerEditor';
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

const logger = createLogger('MCPSettings');

export const MCPSettings: React.FC = () => {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
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
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [reconnectingServer, setReconnectingServer] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);

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
    if (!isAdmin) return;
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
    if (!isAdmin) return;
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
    if (!isAdmin) return;
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

  const handleAddServer = useCallback(async (config: McpServerConfig) => {
    if (!isAdmin) return;
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
  }, [isAdmin, reloadMcpStatus]);

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
            {isAdmin && (
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
                message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
              }`}
            >
              {message.type === 'success' ? (
                <CheckCircle className="w-4 h-4" />
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
                            {isAdmin
                              ? '添加 server 后会在这里显示连接状态、工具数量和可用操作。'
                              : '管理员配置 MCP 后，这里会显示可用状态。'}
                          </div>
                        </div>
                        {isAdmin && (
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
                        </td>
                        <td className="max-w-[220px] px-3 py-3 align-middle">
                          {server.error && isAdmin ? (
                            <span className="block truncate text-red-400" title={server.error}>
                              {server.error}
                            </span>
                          ) : server.blockedReason && isAdmin ? (
                            <span className="block truncate text-yellow-300" title={server.blockedReason.detail}>
                              {server.blockedReason.detail}
                            </span>
                          ) : (server.error || server.blockedReason) ? (
                            <span className="text-zinc-500">管理员可查看</span>
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
                            {isAdmin && server.enabled && !server.available && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleReconnect(server.id)}
                                loading={reconnectingServer === server.id}
                                leftIcon={<RefreshCw className="w-3 h-3" />}
                              >
                                重连
                              </Button>
                            )}
                            {isAdmin && (
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

      <SettingsDetails
        title="协议说明"
        description="MCP 的概念说明和自动连接行为。"
      >
        <p className="text-xs text-zinc-400 leading-relaxed">
          MCP (Model Context Protocol) 是一个开放协议，允许 AI 模型安全地访问外部工具和数据源。
          已配置的服务器会在应用启动时自动连接。云端配置支持热更新，无需重启应用。
        </p>
      </SettingsDetails>

      {/* Add Server Editor Modal */}
      {isAdmin && (
        <McpServerEditor
          isOpen={isEditorOpen}
          onClose={() => setIsEditorOpen(false)}
          onSave={handleAddServer}
        />
      )}

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
