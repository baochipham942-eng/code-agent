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
  Zap,
  ExternalLink,
  Plus,
} from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { useMcpStatus } from '../../../../hooks/useMcpStatus';
import { useWorkbenchInsights } from '../../../../hooks/useWorkbenchInsights';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';
import { IPC_DOMAINS } from '@shared/ipc';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { LocalBridgeSection } from '../sections/localBridge';
import { NativeConnectorsSection } from '../sections';
import ipcService from '../../../../services/ipcService';
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
  const { t } = useI18n();
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
  const [codexDetectedPath, setCodexDetectedPath] = useState<string | null>(null);
  const [codexSandboxEnabled, setCodexSandboxEnabled] = useState(false);
  const [codexCrossVerifyEnabled, setCodexCrossVerifyEnabled] = useState(false);
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

  // 自动清除成功消息
  useEffect(() => {
    if (message?.type === 'success') {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadCodexSettings = async () => {
    try {
      const settings = await ipcService.invokeDomain<any>(IPC_DOMAINS.SETTINGS, 'get');
      if (settings?.codex) {
        setCodexDetectedPath(settings.codex.detectedPath ?? null);
        setCodexSandboxEnabled(settings.codex.sandboxEnabled ?? false);
        setCodexCrossVerifyEnabled(settings.codex.crossVerifyEnabled ?? false);
      }
    } catch (error) {
      logger.error('Failed to load Codex settings', error);
    }
  };

  const handleCodexToggle = async (field: 'sandboxEnabled' | 'crossVerifyEnabled', value: boolean) => {
    try {
      const settings = await ipcService.invokeDomain<any>(IPC_DOMAINS.SETTINGS, 'get');
      const codex = settings?.codex || { sandboxEnabled: false, crossVerifyEnabled: false };
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        codex: { ...codex, [field]: value },
      });
      if (field === 'sandboxEnabled') setCodexSandboxEnabled(value);
      else setCodexCrossVerifyEnabled(value);
      setMessage({ type: 'success', text: `Codex ${field === 'sandboxEnabled' ? '沙箱执行' : '交叉验证'}已${value ? '启用' : '关闭'}，重启后生效` });
    } catch (error) {
      logger.error('Failed to update Codex settings', error);
      setMessage({ type: 'error', text: '更新 Codex 设置失败' });
    }
  };

  useEffect(() => {
    loadCodexSettings();
  }, []);

  const handleRefreshFromCloud = async () => {
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
    } catch (error) {
      setMessage({ type: 'error', text: '刷新失败' });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleToggleServer = async (serverName: string, enabled: boolean) => {
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
  }, []);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WebModeBanner />

      {/* Local Bridge Service */}
      <LocalBridgeSection />

      {/* Native Connectors */}
      <NativeConnectorsSection />

      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">MCP 服务器</h3>
        <p className="text-xs text-zinc-400 mb-4">
          Model Context Protocol 服务器状态。MCP 允许 Agent 调用外部工具和资源。
        </p>
      </div>

      {/* Overall Status */}
      {mcpStatus && (
        <div className="bg-zinc-800 rounded-lg p-4">
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

      {/* Codex CLI Integration */}
      <div className="bg-zinc-800 rounded-lg p-4 border border-zinc-700">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-4 h-4 text-orange-400" />
          <h4 className="text-sm font-medium text-zinc-200">Codex CLI</h4>
          {codexDetectedPath ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
              已检测到
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-600 text-zinc-400">
              未安装
            </span>
          )}
        </div>

        {codexDetectedPath ? (
          <>
            <p className="text-xs text-zinc-400 mb-3">
              路径: <code className="text-zinc-400">{codexDetectedPath}</code>
            </p>
            <div className="space-y-2">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm text-zinc-200">沙箱执行</span>
                  <p className="text-xs text-zinc-500">非安全命令委托 Codex 沙箱执行</p>
                </div>
                <button
                  disabled={isWebMode()}
                  onClick={() => handleCodexToggle('sandboxEnabled', !codexSandboxEnabled)}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    codexSandboxEnabled ? 'bg-orange-500' : 'bg-zinc-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      codexSandboxEnabled ? 'translate-x-4' : ''
                    }`}
                  />
                </button>
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm text-zinc-200">交叉验证</span>
                  <p className="text-xs text-zinc-500">复杂代码任务双模型验证</p>
                </div>
                <button
                  disabled={isWebMode()}
                  onClick={() => handleCodexToggle('crossVerifyEnabled', !codexCrossVerifyEnabled)}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    codexCrossVerifyEnabled ? 'bg-orange-500' : 'bg-zinc-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      codexCrossVerifyEnabled ? 'translate-x-4' : ''
                    }`}
                  />
                </button>
              </label>
            </div>
          </>
        ) : (
          <div className="text-xs text-zinc-400">
            <p>安装 Codex CLI 后可启用沙箱执行和交叉验证。</p>
            <a
              href="https://github.com/openai/codex"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 mt-2"
            >
              安装指南 <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>

      {/* Server List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-zinc-200">服务器列表</h4>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsEditorOpen(true)}
            leftIcon={<Plus className="w-3 h-3" />}
          >
            添加服务器
          </Button>
        </div>
        {mcpServers.length === 0 ? (
          <div className="bg-zinc-800 rounded-lg p-4 text-center text-zinc-400 text-sm">
            没有配置任何 MCP 服务器
          </div>
        ) : (
          mcpServers.map((server) => {
            const serverStatus = getWorkbenchCapabilityStatusPresentation(server, { locale: 'zh' });

            return (
              <div
                key={server.id}
                className="bg-zinc-800 rounded-lg p-4 flex items-center justify-between"
                title={getWorkbenchCapabilityTitle(server, { locale: 'zh' })}
              >
                <div className="flex items-center gap-3">
                  {getStatusIcon(server.lifecycle.connectionState)}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">{server.label}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-600 text-zinc-400">
                        {server.transport}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                      <span className={serverStatus.colorClass}>
                        {serverStatus.label}
                      </span>
                      {server.available && (
                        <>
                          <span>{server.toolCount} 工具</span>
                          <span>{server.resourceCount} 资源</span>
                        </>
                      )}
                      {server.error && (
                        <span className="text-red-400 truncate max-w-[200px]" title={server.error}>
                          {server.error}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <WorkbenchCapabilityDetailButton
                    label={server.label}
                    onClick={() => openCapabilitySheet(server)}
                  />
                  {server.enabled && !server.available && (
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
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Refresh from Cloud Button */}
      <Button
        onClick={handleRefreshFromCloud}
        loading={isRefreshing}
        variant="primary"
        fullWidth
        leftIcon={!isRefreshing ? <Cloud className="w-4 h-4" /> : undefined}
        className="!bg-indigo-600 hover:!bg-indigo-500"
      >
        {isRefreshing ? '刷新中...' : '从云端刷新 MCP 配置'}
      </Button>

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg ${
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

      {/* Info Box */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-2">关于 MCP</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          MCP (Model Context Protocol) 是一个开放协议，允许 AI 模型安全地访问外部工具和数据源。
          已配置的服务器会在应用启动时自动连接。云端配置支持热更新，无需重启应用。
        </p>
      </div>

      {/* Add Server Editor Modal */}
      <McpServerEditor
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        onSave={handleAddServer}
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
    </div>
  );
};
