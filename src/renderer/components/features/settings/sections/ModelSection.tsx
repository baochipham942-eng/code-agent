// ============================================================================
// ModelSection - 模型设置（提供商、API Key、模型选择、温度）
// ============================================================================

import React, { useState } from 'react';
import { Key, Check, AlertCircle } from 'lucide-react';
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
// Component
// ============================================================================

export const ModelSection: React.FC<ModelSectionProps> = ({ config, onChange }) => {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

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

  const providers: { id: ModelProvider; name: string; description: string }[] = [
    { id: 'deepseek', name: t.model.providers.deepseek.name, description: t.model.providers.deepseek.description },
    { id: 'claude', name: t.model.providers.anthropic.name, description: t.model.providers.anthropic.description },
    { id: 'openai', name: t.model.providers.openai.name, description: t.model.providers.openai.description },
    { id: 'openrouter', name: t.model.providers.openrouter?.name || 'OpenRouter', description: t.model.providers.openrouter?.description || '中转服务' },
  ];

  return (
    <div className="space-y-5">
      {/* Provider Selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-3">
          {t.model.title || '模型提供商'}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => onChange({ ...config, provider: provider.id })}
              className={`p-3 rounded-lg border text-left transition-all ${
                config.provider === provider.id
                  ? 'border-teal-500/50 bg-teal-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <div className={`text-sm font-medium ${config.provider === provider.id ? 'text-teal-400' : 'text-zinc-100'}`}>
                {provider.name}
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                {provider.description}
              </div>
            </button>
          ))}
        </div>
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
    </div>
  );
};
