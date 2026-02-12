// ============================================================================
// ModelSettings - Model Configuration Tab
// ============================================================================

import React, { useState } from 'react';
import { Key } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input, Select } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelProvider } from '@shared/types';
import { UI } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('ModelSettings');

// ============================================================================
// Types
// ============================================================================

// Re-export ModelConfig from shared types for consistency
import type { ModelConfig } from '@shared/types';
export type { ModelConfig };

export interface ModelSettingsProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

// ============================================================================
// Component
// ============================================================================

export const ModelSettings: React.FC<ModelSettingsProps> = ({ config, onChange }) => {
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
    // 国外御三家
    { id: 'openai', name: t.model.providers.openai.name, description: t.model.providers.openai.description },
    { id: 'claude', name: t.model.providers.anthropic.name, description: t.model.providers.anthropic.description },
    { id: 'gemini', name: t.model.providers.gemini?.name || 'Gemini', description: t.model.providers.gemini?.description || 'Google Gemini 2.5' },
    // 国内梯队
    { id: 'deepseek', name: t.model.providers.deepseek.name, description: t.model.providers.deepseek.description },
    { id: 'zhipu', name: t.model.providers.zhipu?.name || '智谱 AI', description: t.model.providers.zhipu?.description || 'GLM-4 系列模型' },
    { id: 'qwen', name: t.model.providers.qwen?.name || '通义千问', description: t.model.providers.qwen?.description || '阿里云 Qwen 模型' },
    { id: 'moonshot', name: t.model.providers.moonshot?.name || 'Kimi', description: t.model.providers.moonshot?.description || 'Moonshot AI 模型' },
    { id: 'minimax', name: t.model.providers.minimax?.name || 'MiniMax', description: t.model.providers.minimax?.description || 'MiniMax 海螺 AI' },
    // 第三方服务
    { id: 'openrouter', name: t.model.providers.openrouter?.name || 'OpenRouter', description: t.model.providers.openrouter?.description || '中转服务' },
    { id: 'perplexity', name: t.model.providers.perplexity?.name || 'Perplexity', description: t.model.providers.perplexity?.description || 'AI 搜索服务' },
  ];

  return (
    <div className="space-y-6">
      {/* Provider Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.model.title}</h3>
        <div className="grid grid-cols-3 gap-3">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => onChange({ ...config, provider: provider.id })}
              className={`p-3 rounded-lg border text-left transition-colors ${
                config.provider === provider.id
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <div className="text-sm font-medium text-zinc-100">
                {provider.name}
              </div>
              <div className="text-xs text-zinc-500 mt-1">
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
        <p className="text-xs text-zinc-500 mt-2">
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
              <option value="deepseek-chat">DeepSeek V3.2 Chat (推荐)</option>
              <option value="deepseek-reasoner">DeepSeek V3.2 Reasoner</option>
            </>
          )}
          {config.provider === 'claude' && (
            <>
              <option value="claude-opus-4-5-20251124">Claude 4.5 Opus (最强)</option>
              <option value="claude-sonnet-4-5-20251124">Claude 4.5 Sonnet (推荐)</option>
              <option value="claude-haiku-4-5-20251124">Claude 4.5 Haiku (快速)</option>
              <option value="claude-opus-4-1-20250805">Claude 4.1 Opus</option>
              <option value="claude-sonnet-4-20250514">Claude 4 Sonnet</option>
            </>
          )}
          {config.provider === 'openai' && (
            <>
              <optgroup label="GPT 系列">
                <option value="gpt-4.1">GPT-4.1 (推荐)</option>
                <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                <option value="gpt-4.1-nano">GPT-4.1 Nano (快速)</option>
                <option value="gpt-4o">GPT-4o</option>
              </optgroup>
              <optgroup label="推理模型 (o 系列)">
                <option value="o3">o3 (最强推理)</option>
                <option value="o3-mini">o3 Mini</option>
                <option value="o4-mini">o4 Mini (高性价比)</option>
              </optgroup>
            </>
          )}
          {config.provider === 'gemini' && (
            <>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro (推荐)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (最便宜)</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
            </>
          )}
          {config.provider === 'openrouter' && (
            <>
              <optgroup label="Google Gemini">
                <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="google/gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
              </optgroup>
              <optgroup label="Anthropic Claude">
                <option value="anthropic/claude-sonnet-4.5">Claude 4.5 Sonnet</option>
                <option value="anthropic/claude-haiku-4.5">Claude 4.5 Haiku</option>
              </optgroup>
              <optgroup label="OpenAI">
                <option value="openai/gpt-4.1">GPT-4.1</option>
                <option value="openai/gpt-4o">GPT-4o</option>
                <option value="openai/o3-mini">o3 Mini</option>
              </optgroup>
              <optgroup label="DeepSeek">
                <option value="deepseek/deepseek-chat">DeepSeek V3.2</option>
                <option value="deepseek/deepseek-reasoner">DeepSeek Reasoner</option>
              </optgroup>
            </>
          )}
          {config.provider === 'zhipu' && (
            <>
              <option value="glm-5">GLM-5 (最新旗舰)</option>
              <option value="glm-4.7">GLM-4.7</option>
              <option value="glm-4.7-flash">GLM-4.7 Flash (快速)</option>
              <option value="glm-4.6v">GLM-4.6V (视觉)</option>
            </>
          )}
          {config.provider === 'qwen' && (
            <>
              <option value="qwen3-max">Qwen3 Max (推荐)</option>
              <option value="qwen-max-latest">Qwen Max Latest</option>
              <option value="qwen-plus-latest">Qwen Plus Latest</option>
              <option value="qwen3-coder">Qwen3 Coder</option>
              <option value="qwen-vl-max">Qwen VL Max (视觉)</option>
            </>
          )}
          {config.provider === 'moonshot' && (
            <>
              <option value="kimi-k2-turbo-preview">Kimi K2 Turbo (推荐)</option>
              <option value="kimi-k2-thinking">Kimi K2 Thinking</option>
              <option value="moonshot-v1-auto">Moonshot V1 Auto</option>
              <option value="moonshot-v1-128k">Moonshot V1 128K</option>
            </>
          )}
          {config.provider === 'minimax' && (
            <>
              <option value="MiniMax-M2">MiniMax M2 (推荐)</option>
              <option value="MiniMax-M1">MiniMax M1</option>
              <option value="MiniMax-Text-01">MiniMax Text-01</option>
              <option value="abab7-preview">ABAB7 Preview</option>
            </>
          )}
          {config.provider === 'perplexity' && (
            <>
              <option value="sonar-pro">Sonar Pro (推荐)</option>
              <option value="sonar">Sonar</option>
              <option value="sonar-reasoning-pro">Sonar Reasoning Pro</option>
              <option value="sonar-reasoning">Sonar Reasoning</option>
            </>
          )}
        </Select>
      </div>

      {/* Temperature */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.temperature}: {config.temperature ?? 0.7}
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={config.temperature ?? 0.7}
          onChange={(e) =>
            onChange({ ...config, temperature: parseFloat(e.target.value) })
          }
          className="w-full"
        />
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{t.model.temperaturePrecise}</span>
          <span>{t.model.temperatureCreative}</span>
        </div>
      </div>

      {/* Save Button */}
      <div className="pt-4 border-t border-zinc-800">
        <Button
          onClick={handleSave}
          loading={isSaving}
          fullWidth
          variant={saveStatus === 'error' ? 'danger' : 'primary'}
          className={saveStatus === 'success' ? '!bg-green-600 hover:!bg-green-500' : ''}
        >
          {isSaving ? t.common.saving || 'Saving...' : saveStatus === 'success' ? t.common.saved || 'Saved!' : saveStatus === 'error' ? t.common.error || 'Error' : t.common.save || 'Save'}
        </Button>
      </div>
    </div>
  );
};
