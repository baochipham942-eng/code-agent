// ============================================================================
// ServiceSection - 服务设置（第三方 API Keys、MCP 状态、Skills）
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Key,
  Search,
  Github,
  Eye,
  Zap,
  Check,
  AlertCircle,
  Plug,
  PlugZap,
  Loader2,
  ChevronDown,
  Sparkles,
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

type ServiceKey = 'brave' | 'github' | 'openrouter' | 'exa' | 'perplexity';

interface ServiceConfig {
  id: ServiceKey;
  name: string;
  description: string;
  icon: React.ReactNode;
  placeholder: string;
  helpUrl?: string;
}

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

  // API Keys state
  const [keys, setKeys] = useState<Record<ServiceKey, string>>({
    brave: '',
    github: '',
    openrouter: '',
    exa: '',
    perplexity: '',
  });
  const [visibleKeys, setVisibleKeys] = useState<Record<ServiceKey, boolean>>({
    brave: false,
    github: false,
    openrouter: false,
    exa: false,
    perplexity: false,
  });
  const [saving, setSaving] = useState<ServiceKey | null>(null);
  const [saveStatus, setSaveStatus] = useState<Record<ServiceKey, 'idle' | 'success' | 'error'>>({
    brave: 'idle',
    github: 'idle',
    openrouter: 'idle',
    exa: 'idle',
    perplexity: 'idle',
  });

  // MCP state
  const [mcpServers, setMcpServers] = useState<MCPServerState[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [showMcpDetails, setShowMcpDetails] = useState(false);

  // Load API keys
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const result = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS);
        if (result) {
          setKeys(prev => ({
            ...prev,
            brave: result.brave || '',
            github: result.github || '',
            openrouter: result.openrouter || '',
            exa: result.exa || '',
            perplexity: result.perplexity || '',
          }));
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

  const services: ServiceConfig[] = [
    {
      id: 'brave',
      name: 'Brave Search',
      description: '网络搜索',
      icon: <Search className="w-4 h-4 text-orange-400" />,
      placeholder: 'BSA...',
      helpUrl: 'https://brave.com/search/api/',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'MCP 服务器',
      icon: <Github className="w-4 h-4 text-zinc-300" />,
      placeholder: 'ghp_...',
      helpUrl: 'https://github.com/settings/tokens',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'PDF 解析 / 图片生成',
      icon: <Zap className="w-4 h-4 text-purple-400" />,
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
    },
    {
      id: 'exa',
      name: 'EXA',
      description: '高质量搜索',
      icon: <Search className="w-4 h-4 text-cyan-400" />,
      placeholder: 'exa-...',
      helpUrl: 'https://exa.ai/dashboard',
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      description: 'AI 增强搜索',
      icon: <Search className="w-4 h-4 text-green-400" />,
      placeholder: 'pplx-...',
      helpUrl: 'https://www.perplexity.ai/settings/api',
    },
  ];

  const handleSave = async (serviceId: ServiceKey) => {
    setSaving(serviceId);
    setSaveStatus(prev => ({ ...prev, [serviceId]: 'idle' }));

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY, {
        service: serviceId,
        apiKey: keys[serviceId],
      });
      logger.info('Service key saved', { service: serviceId });
      setSaveStatus(prev => ({ ...prev, [serviceId]: 'success' }));
      setTimeout(() => {
        setSaveStatus(prev => ({ ...prev, [serviceId]: 'idle' }));
      }, UI.COPY_FEEDBACK_DURATION);
    } catch (error) {
      logger.error('Failed to save service key', { service: serviceId, error });
      setSaveStatus(prev => ({ ...prev, [serviceId]: 'error' }));
    } finally {
      setSaving(null);
    }
  };

  const toggleVisibility = (serviceId: ServiceKey) => {
    setVisibleKeys(prev => ({ ...prev, [serviceId]: !prev[serviceId] }));
  };

  const connectedMcpCount = mcpServers.filter(s => s.status === 'connected').length;

  return (
    <div className="space-y-6">
      {/* API Keys */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3 flex items-center gap-2">
          <Key className="w-4 h-4 text-zinc-400" />
          第三方 API Keys
        </h4>
        <div className="space-y-3">
          {services.map((service) => (
            <div
              key={service.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-zinc-800 bg-zinc-900/50"
            >
              <div className="shrink-0">{service.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100">{service.name}</span>
                  <span className="text-xs text-zinc-500">{service.description}</span>
                </div>
                <div className="flex gap-2 mt-2">
                  <div className="flex-1 relative">
                    <Input
                      type={visibleKeys[service.id] ? 'text' : 'password'}
                      value={keys[service.id]}
                      onChange={(e) => setKeys(prev => ({ ...prev, [service.id]: e.target.value }))}
                      placeholder={service.placeholder}
                      className="!py-1.5 !text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => toggleVisibility(service.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <Button
                    onClick={() => handleSave(service.id)}
                    loading={saving === service.id}
                    variant={saveStatus[service.id] === 'error' ? 'danger' : 'secondary'}
                    size="sm"
                    className={`!px-2 ${saveStatus[service.id] === 'success' ? '!bg-emerald-600 hover:!bg-emerald-500' : ''}`}
                  >
                    {saving === service.id ? (
                      '...'
                    ) : saveStatus[service.id] === 'success' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : saveStatus[service.id] === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5" />
                    ) : (
                      '保存'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ))}
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

      {/* Security Note */}
      <p className="text-xs text-zinc-500">
        API Keys 安全存储在系统 Keychain 中
      </p>
    </div>
  );
};
