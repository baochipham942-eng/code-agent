// ============================================================================
// ModelSettings - Model Configuration Tab
// ============================================================================

import React, { useState, useMemo } from 'react';
import { Key } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input, Select } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelProvider } from '@shared/types';
import { UI, MODEL, PROVIDER_MODELS, PROVIDER_MODELS_MAP } from '@shared/constants';
import type { ProviderModelEntry } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('ModelSettings');

// ============================================================================
// Types
// ============================================================================

// Re-export ModelConfig from shared types for consistency
import type { ModelConfig } from '@shared/types';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
export type { ModelConfig };

export interface ModelSettingsProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

// ============================================================================
// Helper: render model options with optional optgroup
// ============================================================================

function renderModelOptions(models: ProviderModelEntry[]): React.ReactNode {
  // Check if any models have groups
  const hasGroups = models.some((m) => m.group);
  if (!hasGroups) {
    return models.map((m) => (
      <option key={m.id} value={m.id}>{m.label}</option>
    ));
  }
  // Group by group label, preserving order
  const groups: { label: string; items: ProviderModelEntry[] }[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const g = m.group || '';
    if (!seen.has(g)) {
      seen.add(g);
      groups.push({ label: g, items: [] });
    }
    groups.find((x) => x.label === g)!.items.push(m);
  }
  return groups.map((g) => (
    <optgroup key={g.label} label={g.label}>
      {g.items.map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </optgroup>
  ));
}

// ============================================================================
// Component
// ============================================================================

export const ModelSettings: React.FC<ModelSettingsProps> = ({ config, onChange }) => {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Build provider display list with i18n names where available
  const providers = useMemo(() =>
    PROVIDER_MODELS.map((p) => ({
      id: p.id,
      name: (t.model.providers as Record<string, { name?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.name || p.name,
      description: (t.model.providers as Record<string, { description?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.description || p.description,
    })),
  [t]);

  // Get models for current provider
  const currentModels = useMemo(
    () => PROVIDER_MODELS_MAP[config.provider]?.models || [],
    [config.provider],
  );

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

  return (
    <div className="space-y-6">
      <WebModeBanner />
      {/* Provider Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-4">{t.model.title}</h3>
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
              <div className="text-sm font-medium text-zinc-200">
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
        <label className="block text-sm font-medium text-zinc-200 mb-2">
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
        <label className="block text-sm font-medium text-zinc-200 mb-2">
          {t.model.modelSelect}
        </label>
        <Select
          value={config.model}
          onChange={(e) => onChange({ ...config, model: e.target.value })}
        >
          {renderModelOptions(currentModels)}
        </Select>
      </div>

      {/* Temperature */}
      <div>
        <label className="block text-sm font-medium text-zinc-200 mb-2">
          {t.model.temperature}: {config.temperature ?? MODEL.DEFAULT_TEMPERATURE}
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={config.temperature ?? MODEL.DEFAULT_TEMPERATURE}
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
      <div className="pt-4 border-t border-zinc-700">
        <Button
          disabled={isWebMode()}
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
