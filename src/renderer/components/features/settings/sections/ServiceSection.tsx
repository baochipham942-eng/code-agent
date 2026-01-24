// ============================================================================
// ServiceSection - 服务设置（MCP 状态、Skills）
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Plug,
  PlugZap,
  Loader2,
  ChevronDown,
  Sparkles,
  Github,
  Eye,
  Check,
  AlertCircle,
} from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc';
import { UI } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('ServiceSection');

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

// ============================================================================
// Component
// ============================================================================

export const ServiceSection: React.FC = () => {
  const { t } = useI18n();

  // GitHub Token state (kept separately for MCP)
  const [githubToken, setGithubToken] = useState('');
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [savingGithub, setSavingGithub] = useState(false);
  const [githubSaveStatus, setGithubSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // MCP state
  const [mcpServers, setMcpServers] = useState<MCPServerState[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [showMcpDetails, setShowMcpDetails] = useState(false);

  // Load GitHub token
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const result = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS);
        if (result) {
          setGithubToken(result.github || '');
        }
      } catch (error) {
        logger.error('Failed to load service keys', error);
      }
    };
    loadKeys();
  }, []);

  // Load MCP status
  useEffect(() => {
    const loadMCPStatus = async () => {
      try {
        const statesResponse = await window.domainAPI?.invoke<MCPServerState[]>(IPC_DOMAINS.MCP, 'getServerStates');
        if (statesResponse?.success && statesResponse.data) {
          setMcpServers(statesResponse.data);
        }
      } catch (error) {
        logger.error('Failed to load MCP status', error);
      } finally {
        setMcpLoading(false);
      }
    };
    loadMCPStatus();
  }, []);

  const handleSaveGithubToken = async () => {
    setSavingGithub(true);
    setGithubSaveStatus('idle');

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY, {
        service: 'github',
        apiKey: githubToken,
      });
      logger.info('GitHub token saved');
      setGithubSaveStatus('success');
      setTimeout(() => setGithubSaveStatus('idle'), UI.COPY_FEEDBACK_DURATION);
    } catch (error) {
      logger.error('Failed to save GitHub token', error);
      setGithubSaveStatus('error');
    } finally {
      setSavingGithub(false);
    }
  };

  const connectedMcpCount = mcpServers.filter(s => s.status === 'connected').length;

  return (
    <div className="space-y-6">
      {/* GitHub Token for MCP */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3 flex items-center gap-2">
          <Github className="w-4 h-4 text-zinc-400" />
          GitHub Token
        </h4>
        <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50">
          <p className="text-xs text-zinc-500 mb-2">用于 MCP GitHub 服务器访问</p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                type={showGithubToken ? 'text' : 'password'}
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="ghp_..."
                className="!py-1.5 !text-xs"
              />
              <button
                type="button"
                onClick={() => setShowGithubToken(!showGithubToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
            <Button
              onClick={handleSaveGithubToken}
              loading={savingGithub}
              variant={githubSaveStatus === 'error' ? 'danger' : 'secondary'}
              size="sm"
              className={`!px-2 ${githubSaveStatus === 'success' ? '!bg-emerald-600 hover:!bg-emerald-500' : ''}`}
            >
              {savingGithub ? (
                '...'
              ) : githubSaveStatus === 'success' ? (
                <Check className="w-3.5 h-3.5" />
              ) : githubSaveStatus === 'error' ? (
                <AlertCircle className="w-3.5 h-3.5" />
              ) : (
                '保存'
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* MCP Status */}
      <div>
        <button
          onClick={() => setShowMcpDetails(!showMcpDetails)}
          className="w-full flex items-center justify-between p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Plug className="w-4 h-4 text-zinc-400" />
            <span className="text-sm font-medium text-zinc-100">MCP 服务器</span>
            {mcpLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
            ) : (
              <span className={`text-xs px-1.5 py-0.5 rounded ${
                connectedMcpCount > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700 text-zinc-400'
              }`}>
                {connectedMcpCount} 已连接
              </span>
            )}
          </div>
          <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${showMcpDetails ? 'rotate-180' : ''}`} />
        </button>

        {showMcpDetails && (
          <div className="mt-2 space-y-2">
            {mcpServers.length === 0 ? (
              <p className="text-xs text-zinc-500 text-center py-3">无 MCP 服务器配置</p>
            ) : (
              mcpServers.map((server) => (
                <div
                  key={server.config.name}
                  className="flex items-center justify-between p-2 rounded bg-zinc-800/50 text-xs"
                >
                  <div className="flex items-center gap-2">
                    {server.status === 'connected' ? (
                      <PlugZap className="w-3.5 h-3.5 text-emerald-400" />
                    ) : server.status === 'connecting' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-yellow-400" />
                    ) : (
                      <Plug className="w-3.5 h-3.5 text-zinc-500" />
                    )}
                    <span className="text-zinc-200">{server.config.name}</span>
                    <span className="text-zinc-500">{server.config.type}</span>
                  </div>
                  {server.status === 'connected' && (
                    <span className="text-zinc-400">{server.toolCount} 工具</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Skills Placeholder */}
      <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div className="flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <div>
            <span className="text-sm font-medium text-zinc-100">Skills</span>
            <p className="text-xs text-zinc-500 mt-0.5">预定义工作流（即将推出）</p>
          </div>
        </div>
      </div>
    </div>
  );
};
