// ============================================================================
// ServiceKeysSettings - Service API Keys Configuration Tab
// Brave Search, GitHub, OpenRouter, Langfuse etc.
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Key, Search, Github, Eye, Zap, Check, AlertCircle } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { UI } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('ServiceKeysSettings');

// ============================================================================
// Types
// ============================================================================

type ServiceKey = 'brave' | 'github' | 'openrouter' | 'langfuse_public' | 'langfuse_secret' | 'exa' | 'perplexity';

interface ServiceConfig {
  id: ServiceKey;
  name: string;
  description: string;
  icon: React.ReactNode;
  placeholder: string;
  helpUrl?: string;
}

// ============================================================================
// Component
// ============================================================================

export const ServiceKeysSettings: React.FC = () => {
  const { t } = useI18n();
  const [keys, setKeys] = useState<Record<ServiceKey, string>>({
    brave: '',
    github: '',
    openrouter: '',
    langfuse_public: '',
    langfuse_secret: '',
    exa: '',
    perplexity: '',
  });
  const [visibleKeys, setVisibleKeys] = useState<Record<ServiceKey, boolean>>({
    brave: false,
    github: false,
    openrouter: false,
    langfuse_public: false,
    langfuse_secret: false,
    exa: false,
    perplexity: false,
  });
  const [saving, setSaving] = useState<ServiceKey | null>(null);
  const [saveStatus, setSaveStatus] = useState<Record<ServiceKey, 'idle' | 'success' | 'error'>>({
    brave: 'idle',
    github: 'idle',
    openrouter: 'idle',
    langfuse_public: 'idle',
    langfuse_secret: 'idle',
    exa: 'idle',
    perplexity: 'idle',
  });

  // Load existing keys on mount
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS);
        if (result) {
          setKeys(prev => ({
            ...prev,
            brave: result.brave || '',
            github: result.github || '',
            openrouter: result.openrouter || '',
            langfuse_public: result.langfuse_public || '',
            langfuse_secret: result.langfuse_secret || '',
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

  const services: ServiceConfig[] = [
    {
      id: 'brave',
      name: 'Brave Search',
      description: '网络搜索功能（WebSearch 工具）',
      icon: <Search className="w-4 h-4 text-orange-400" />,
      placeholder: 'BSA...',
      helpUrl: 'https://brave.com/search/api/',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'MCP GitHub 服务器访问',
      icon: <Github className="w-4 h-4 text-zinc-400" />,
      placeholder: 'ghp_...',
      helpUrl: 'https://github.com/settings/tokens',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'PDF 视觉解析、图片生成',
      icon: <Zap className="w-4 h-4 text-purple-400" />,
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
    },
    {
      id: 'langfuse_public',
      name: 'Langfuse Public Key',
      description: '可观测性追踪（公钥）',
      icon: <Eye className="w-4 h-4 text-blue-400" />,
      placeholder: 'pk-lf-...',
      helpUrl: 'https://langfuse.com/',
    },
    {
      id: 'langfuse_secret',
      name: 'Langfuse Secret Key',
      description: '可观测性追踪（私钥）',
      icon: <Eye className="w-4 h-4 text-blue-400" />,
      placeholder: 'sk-lf-...',
    },
    {
      id: 'exa',
      name: 'EXA',
      description: '高质量网络搜索（并行数据源）',
      icon: <Search className="w-4 h-4 text-cyan-400" />,
      placeholder: 'exa-...',
      helpUrl: 'https://exa.ai/dashboard',
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      description: 'AI 增强搜索（并行数据源）',
      icon: <Search className="w-4 h-4 text-green-400" />,
      placeholder: 'pplx-...',
      helpUrl: 'https://www.perplexity.ai/settings/api',
    },
  ];

  const handleSave = async (serviceId: ServiceKey) => {
    setSaving(serviceId);
    setSaveStatus(prev => ({ ...prev, [serviceId]: 'idle' }));

    try {
      await ipcService.invoke(IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY, {
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

  return (
    <div className="space-y-6">
      <WebModeBanner />
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">服务 API Keys</h3>
        <p className="text-xs text-zinc-500 mb-4">
          配置第三方服务的 API Key，用于启用对应功能
        </p>
      </div>

      <div className="space-y-4">
        {services.map((service) => (
          <div
            key={service.id}
            className="p-4 rounded-lg border border-zinc-700 bg-zinc-900"
          >
            <div className="flex items-center gap-2 mb-2">
              {service.icon}
              <span className="text-sm font-medium text-zinc-200">{service.name}</span>
              {service.helpUrl && (
                <a
                  href={service.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 ml-auto"
                >
                  获取 Key →
                </a>
              )}
            </div>
            <p className="text-xs text-zinc-500 mb-3">{service.description}</p>

            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Input
                  type={visibleKeys[service.id] ? 'text' : 'password'}
                  value={keys[service.id]}
                  onChange={(e) => setKeys(prev => ({ ...prev, [service.id]: e.target.value }))}
                  placeholder={service.placeholder}
                  leftIcon={<Key className="w-4 h-4" />}
                />
                <button
                  type="button"
                  onClick={() => toggleVisibility(service.id)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-400"
                >
                  <Eye className="w-4 h-4" />
                </button>
              </div>
              <Button
                disabled={isWebMode()}
                onClick={() => handleSave(service.id)}
                loading={saving === service.id}
                variant={saveStatus[service.id] === 'error' ? 'danger' : 'primary'}
                size="sm"
                className={saveStatus[service.id] === 'success' ? '!bg-green-600 hover:!bg-green-500' : ''}
              >
                {saving === service.id ? (
                  '...'
                ) : saveStatus[service.id] === 'success' ? (
                  <Check className="w-4 h-4" />
                ) : saveStatus[service.id] === 'error' ? (
                  <AlertCircle className="w-4 h-4" />
                ) : (
                  '保存'
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="pt-4 border-t border-zinc-700">
        <p className="text-xs text-zinc-500">
          💡 API Keys 安全存储在系统 Keychain 中，不会上传到云端
        </p>
      </div>
    </div>
  );
};
