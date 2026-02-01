// ============================================================================
// MCPSettings - MCP Server Status and Configuration Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';
import { IPC_DOMAINS } from '@shared/ipc';

const logger = createLogger('MCPSettings');

// ============================================================================
// Types
// ============================================================================

interface MCPServerState {
  config: {
    name: string;
    type: 'stdio' | 'sse';
    enabled: boolean;
  };
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  toolCount: number;
  resourceCount: number;
}

interface MCPStatus {
  connectedServers: string[];
  toolCount: number;
  resourceCount: number;
}

// ============================================================================
// Component
// ============================================================================

export const MCPSettings: React.FC = () => {
  const { t } = useI18n();
  const [serverStates, setServerStates] = useState<MCPServerState[]>([]);
  const [mcpStatus, setMcpStatus] = useState<MCPStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [reconnectingServer, setReconnectingServer] = useState<string | null>(null);

  const loadMCPStatus = async () => {
    try {
      // Use new domain API
      const statusResponse = await window.domainAPI?.invoke<MCPStatus>(IPC_DOMAINS.MCP, 'getStatus');
      if (statusResponse?.success && statusResponse.data) {
        setMcpStatus(statusResponse.data);
      }

      const statesResponse = await window.domainAPI?.invoke<MCPServerState[]>(IPC_DOMAINS.MCP, 'getServerStates');
      if (statesResponse?.success && statesResponse.data) {
        setServerStates(statesResponse.data);
      }
    } catch (error) {
      logger.error('Failed to load MCP status', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMCPStatus();
  }, []);

  const handleRefreshFromCloud = async () => {
    setIsRefreshing(true);
    setMessage(null);
    try {
      const result = await window.domainAPI?.invoke(IPC_DOMAINS.MCP, 'refreshFromCloud');
      if (result?.success) {
        setMessage({ type: 'success', text: 'MCP 配置已从云端刷新' });
        await loadMCPStatus();
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
        await loadMCPStatus();
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
      await loadMCPStatus();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      setMessage({ type: 'error', text: `${serverName} 重连失败: ${errorMsg}` });
    } finally {
      setReconnectingServer(null);
    }
  };

  const getStatusColor = (status: MCPServerState['status']): string => {
    switch (status) {
      case 'connected':
        return 'text-green-400';
      case 'connecting':
        return 'text-yellow-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-zinc-400';
    }
  };

  const getStatusText = (status: MCPServerState['status']): string => {
    switch (status) {
      case 'connected':
        return '已连接';
      case 'connecting':
        return '连接中';
      case 'error':
        return '错误';
      default:
        return '未连接';
    }
  };

  const getStatusIcon = (status: MCPServerState['status']) => {
    switch (status) {
      case 'connected':
        return <PlugZap className="w-4 h-4 text-green-400" />;
      case 'connecting':
        return <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
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
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">MCP 服务器</h3>
        <p className="text-xs text-zinc-400 mb-4">
          Model Context Protocol 服务器状态。MCP 允许 Agent 调用外部工具和资源。
        </p>
      </div>

      {/* Overall Status */}
      {mcpStatus && (
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <h4 className="text-sm font-medium text-zinc-100 mb-3">总览</h4>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-semibold text-zinc-100">
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

      {/* Server List */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-100">服务器列表</h4>
        {serverStates.length === 0 ? (
          <div className="bg-zinc-800/50 rounded-lg p-4 text-center text-zinc-400 text-sm">
            没有配置任何 MCP 服务器
          </div>
        ) : (
          serverStates.map((server) => (
            <div
              key={server.config.name}
              className="bg-zinc-800/50 rounded-lg p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                {getStatusIcon(server.status)}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{server.config.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                      {server.config.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                    <span className={getStatusColor(server.status)}>
                      {getStatusText(server.status)}
                    </span>
                    {server.status === 'connected' && (
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
                {server.config.enabled && server.status !== 'connected' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleReconnect(server.config.name)}
                    loading={reconnectingServer === server.config.name}
                    leftIcon={<RefreshCw className="w-3 h-3" />}
                  >
                    重连
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={server.config.enabled ? 'ghost' : 'primary'}
                  onClick={() => handleToggleServer(server.config.name, !server.config.enabled)}
                  leftIcon={
                    server.config.enabled ? (
                      <PowerOff className="w-3 h-3" />
                    ) : (
                      <Power className="w-3 h-3" />
                    )
                  }
                >
                  {server.config.enabled ? '禁用' : '启用'}
                </Button>
              </div>
            </div>
          ))
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
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">关于 MCP</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          MCP (Model Context Protocol) 是一个开放协议，允许 AI 模型安全地访问外部工具和数据源。
          已配置的服务器会在应用启动时自动连接。云端配置支持热更新，无需重启应用。
        </p>
      </div>
    </div>
  );
};
