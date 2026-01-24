// ============================================================================
// ModelSection - 模型设置（提供商、API Key、模型选择、温度、第三方服务 Keys）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Key, Check, AlertCircle, ChevronDown, Eye, Search, Zap } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input, Select } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelProvider, ModelConfig } from '@shared/types';
import { UI } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('ModelSection');

// ============================================================================
// Types
// ============================================================================

export interface ModelSectionProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

// ============================================================================
// Types for Service Keys
// ============================================================================

type ServiceKey = 'brave' | 'openrouter' | 'exa' | 'perplexity';

interface ServiceConfig {
  id: ServiceKey;
  name: string;
  description: string;
  icon: React.ReactNode;
  placeholder: string;
}

// ============================================================================
// Component
// ============================================================================

export const ModelSection: React.FC<ModelSectionProps> = ({ config, onChange }) => {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Service keys state
  const [showServiceKeys, setShowServiceKeys] = useState(false);
  const [serviceKeys, setServiceKeys] = useState<Record<ServiceKey, string>>({
    brave: '',
    openrouter: '',
    exa: '',
    perplexity: '',
  });
  const [visibleKeys, setVisibleKeys] = useState<Record<ServiceKey, boolean>>({
    brave: false,
    openrouter: false,
    exa: false,
    perplexity: false,
  });
  const [savingKey, setSavingKey] = useState<ServiceKey | null>(null);
  const [keySaveStatus, setKeySaveStatus] = useState<Record<ServiceKey, 'idle' | 'success' | 'error'>>({
    brave: 'idle',
    openrouter: 'idle',
    exa: 'idle',
    perplexity: 'idle',
  });

  // Load service keys
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const result = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS);
        if (result) {
          setServiceKeys(prev => ({
            ...prev,
            brave: result.brave || '',
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

  // Save config to backend
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        models: {
          default: config.provider,
          defaultProvider: config.provider,
          providers: {
            [config.provider]: {
              apiKey: config.apiKey,
              model: config.model,
              temperature: config.temperature,
              enabled: true,
            },
          },
        },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Config saved', { provider: config.provider });
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), UI.COPY_FEEDBACK_DURATION);
    } catch (error) {
      logger.error('Failed to save config', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  // Save service key
  const handleSaveServiceKey = async (serviceId: ServiceKey) => {
    setSavingKey(serviceId);
    setKeySaveStatus(prev => ({ ...prev, [serviceId]: 'idle' }));

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY, {
        service: serviceId,
        apiKey: serviceKeys[serviceId],
      });
      logger.info('Service key saved', { service: serviceId });
      setKeySaveStatus(prev => ({ ...prev, [serviceId]: 'success' }));
      setTimeout(() => {
        setKeySaveStatus(prev => ({ ...prev, [serviceId]: 'idle' }));
      }, UI.COPY_FEEDBACK_DURATION);
    } catch (error) {
      logger.error('Failed to save service key', { service: serviceId, error });
      setKeySaveStatus(prev => ({ ...prev, [serviceId]: 'error' }));
    } finally {
      setSavingKey(null);
    }
  };

  const providers: { id: ModelProvider; name: string; description: string }[] = [
    { id: 'deepseek', name: t.model.providers.deepseek.name, description: t.model.providers.deepseek.description },
    { id: 'claude', name: t.model.providers.anthropic.name, description: t.model.providers.anthropic.description },
    { id: 'openai', name: t.model.providers.openai.name, description: t.model.providers.openai.description },
    { id: 'openrouter', name: t.model.providers.openrouter?.name || 'OpenRouter', description: t.model.providers.openrouter?.description || '中转服务' },
  ];

  const services: ServiceConfig[] = [
    {
      id: 'brave',
      name: 'Brave Search',
      description: '网络搜索',
      icon: <Search className="w-4 h-4 text-orange-400" />,
      placeholder: 'BSA...',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'PDF 解析 / 图片生成',
      icon: <Zap className="w-4 h-4 text-purple-400" />,
      placeholder: 'sk-or-...',
    },
    {
      id: 'exa',
      name: 'EXA',
      description: '高质量搜索',
      icon: <Search className="w-4 h-4 text-cyan-400" />,
      placeholder: 'exa-...',
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      description: 'AI 增强搜索',
      icon: <Search className="w-4 h-4 text-green-400" />,
      placeholder: 'pplx-...',
    },
  ];

  return (
    <div className="space-y-5">
      {/* Provider Selection - Dropdown */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          对话模型提供商
        </label>
        <Select
          value={config.provider}
          onChange={(e) => onChange({ ...config, provider: e.target.value as ModelProvider })}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} - {provider.description}
            </option>
          ))}
        </Select>
      </div>

      {/* API Key */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.apiKey}
        </label>
        <Input
          type="password"
          value={config.apiKey || ''}
          onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
          placeholder={t.model.apiKeyPlaceholder}
          leftIcon={<Key className="w-4 h-4" />}
        />
        <p className="text-xs text-zinc-500 mt-1.5">
          {t.model.apiKeyHint}
        </p>
      </div>

      {/* Model Selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.modelSelect}
        </label>
        <Select
          value={config.model}
          onChange={(e) => onChange({ ...config, model: e.target.value })}
        >
          {config.provider === 'deepseek' && (
            <>
              <option value="deepseek-chat">DeepSeek Chat</option>
              <option value="deepseek-coder">DeepSeek Coder</option>
            </>
          )}
          {config.provider === 'claude' && (
            <>
              <option value="claude-sonnet-4-20250514">Claude 4 Sonnet</option>
              <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
              <option value="claude-3-opus-20240229">Claude 3 Opus</option>
            </>
          )}
          {config.provider === 'openai' && (
            <>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            </>
          )}
          {config.provider === 'openrouter' && (
            <>
              <optgroup label="Google Gemini">
                <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
                <option value="google/gemini-2.0-flash-thinking-exp:free">Gemini 2.0 Flash Thinking (Free)</option>
              </optgroup>
              <optgroup label="Anthropic Claude">
                <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                <option value="anthropic/claude-3.5-haiku">Claude 3.5 Haiku</option>
              </optgroup>
              <optgroup label="OpenAI">
                <option value="openai/gpt-4o">GPT-4o</option>
                <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
              </optgroup>
              <optgroup label="DeepSeek">
                <option value="deepseek/deepseek-chat">DeepSeek Chat</option>
                <option value="deepseek/deepseek-r1">DeepSeek R1</option>
              </optgroup>
            </>
          )}
        </Select>
      </div>

      {/* Temperature */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.temperature}: <span className="text-teal-400">{config.temperature ?? 0.7}</span>
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={config.temperature ?? 0.7}
          onChange={(e) => onChange({ ...config, temperature: parseFloat(e.target.value) })}
          className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-teal-500"
        />
        <div className="flex justify-between text-xs text-zinc-500 mt-1">
          <span>{t.model.temperaturePrecise}</span>
          <span>{t.model.temperatureCreative}</span>
        </div>
      </div>

      {/* Save Button */}
      <Button
        onClick={handleSave}
        loading={isSaving}
        fullWidth
        variant={saveStatus === 'error' ? 'danger' : 'primary'}
        className={saveStatus === 'success' ? '!bg-emerald-600 hover:!bg-emerald-500' : ''}
      >
        {isSaving ? (
          t.common.saving || 'Saving...'
        ) : saveStatus === 'success' ? (
          <span className="flex items-center gap-2">
            <Check className="w-4 h-4" />
            {t.common.saved || 'Saved'}
          </span>
        ) : saveStatus === 'error' ? (
          <span className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {t.common.error || 'Error'}
          </span>
        ) : (
          t.common.save || 'Save'
        )}
      </Button>

      {/* Service API Keys - Accordion */}
      <div className="pt-4 border-t border-zinc-800">
        <button
          onClick={() => setShowServiceKeys(!showServiceKeys)}
          className="w-full flex items-center justify-between py-2 text-sm font-medium text-zinc-100 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-2">
            <Key className="w-4 h-4 text-zinc-400" />
            第三方服务 API Keys
          </span>
          <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${showServiceKeys ? 'rotate-180' : ''}`} />
        </button>

        {showServiceKeys && (
          <div className="mt-3 space-y-3">
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
                        value={serviceKeys[service.id]}
                        onChange={(e) => setServiceKeys(prev => ({ ...prev, [service.id]: e.target.value }))}
                        placeholder={service.placeholder}
                        className="!py-1.5 !text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setVisibleKeys(prev => ({ ...prev, [service.id]: !prev[service.id] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <Button
                      onClick={() => handleSaveServiceKey(service.id)}
                      loading={savingKey === service.id}
                      variant={keySaveStatus[service.id] === 'error' ? 'danger' : 'secondary'}
                      size="sm"
                      className={`!px-2 ${keySaveStatus[service.id] === 'success' ? '!bg-emerald-600 hover:!bg-emerald-500' : ''}`}
                    >
                      {savingKey === service.id ? (
                        '...'
                      ) : keySaveStatus[service.id] === 'success' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : keySaveStatus[service.id] === 'error' ? (
                        <AlertCircle className="w-3.5 h-3.5" />
                      ) : (
                        '保存'
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            <p className="text-xs text-zinc-500">
              API Keys 安全存储在系统 Keychain 中
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
