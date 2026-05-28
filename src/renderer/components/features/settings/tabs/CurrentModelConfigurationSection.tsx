import React from 'react';
import { Key, Zap } from 'lucide-react';
import type { ModelConfig, ModelProviderProtocol } from '@shared/contract';
import { MODEL } from '@shared/constants';
import type { RuntimeProviderModel } from '@shared/modelRuntime';
import { useI18n } from '../../../../hooks/useI18n';
import { isWebMode } from '../../../../utils/platform';
import { Button, Input, Select } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import { getProtocolLabel, renderModelOptions } from './ModelSettings.helpers';

interface CurrentModelConfigurationSectionProps {
  config: ModelConfig;
  providerName: string;
  selectedModelLabel: string;
  providerDisplayName: string;
  providerNamePlaceholder: string;
  effectiveProtocol: ModelProviderProtocol;
  isCustomProviderProtocolEditable: boolean;
  showOfficialEndpointReset: boolean;
  registryEndpoint: string;
  configuredBaseUrl: string;
  effectiveBaseUrl: string;
  selectableModels: RuntimeProviderModel[];
  hasApiKey: boolean;
  enabledModelCount: number;
  modelCount: number;
  needsApiKey: boolean;
  hasStoredApiKey: boolean;
  onDisplayNameChange: (value: string) => void;
  onProviderProtocolChange: (protocol: ModelProviderProtocol) => void;
  onResetOfficialEndpoint: () => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onTemperatureChange: (temperature: number) => void;
}

export const CurrentModelConfigurationSection: React.FC<CurrentModelConfigurationSectionProps> = ({
  config,
  providerName,
  selectedModelLabel,
  providerDisplayName,
  providerNamePlaceholder,
  effectiveProtocol,
  isCustomProviderProtocolEditable,
  showOfficialEndpointReset,
  registryEndpoint,
  configuredBaseUrl,
  effectiveBaseUrl,
  selectableModels,
  hasApiKey,
  enabledModelCount,
  modelCount,
  needsApiKey,
  hasStoredApiKey,
  onDisplayNameChange,
  onProviderProtocolChange,
  onResetOfficialEndpoint,
  onBaseUrlChange,
  onApiKeyChange,
  onModelChange,
  onTemperatureChange,
}) => {
  const { t } = useI18n();
  const temperature = config.temperature ?? MODEL.DEFAULT_TEMPERATURE;

  return (
    <SettingsSection
      title="当前模型配置"
      description={`当前使用 ${providerName} / ${selectedModelLabel}`}
    >
      <div className="grid gap-4 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">
              Provider 名称
            </label>
            <Input
              value={providerDisplayName}
              onChange={(event) => onDisplayNameChange(event.target.value)}
              placeholder={providerNamePlaceholder}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">
              Provider 协议
            </label>
            {isCustomProviderProtocolEditable ? (
              <Select
                value={effectiveProtocol}
                onChange={(event) => onProviderProtocolChange(event.target.value as ModelProviderProtocol)}
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="claude">Claude 协议</option>
              </Select>
            ) : (
              <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300">
                {getProtocolLabel(effectiveProtocol)}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-zinc-200">
                Provider 地址
              </label>
              {showOfficialEndpointReset && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onResetOfficialEndpoint}
                  disabled={isWebMode()}
                >
                  恢复官方
                </Button>
              )}
            </div>
            <Input
              value={configuredBaseUrl}
              onChange={(event) => onBaseUrlChange(event.target.value)}
              placeholder={registryEndpoint || 'https://api.example.com/v1'}
            />
            <p className="mt-2 text-xs text-zinc-500">
              OpenAI 兼容通常填到 /v1；Claude 协议通常填 Anthropic-compatible base URL。
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">
              {t.model.apiKey}
            </label>
            <Input
              type="password"
              value={config.apiKey || ''}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={
                needsApiKey
                  ? hasStoredApiKey
                    ? '已保存，输入新密钥可替换'
                    : t.model.apiKeyPlaceholder
                  : '本地模型无需 API Key'
              }
              disabled={!needsApiKey}
              leftIcon={<Key className="w-4 h-4" />}
            />
            <p className="mt-2 text-xs text-zinc-500">
              {needsApiKey
                ? hasStoredApiKey && !config.apiKey
                  ? 'API Key 已在本机加密保存。'
                  : t.model.apiKeyHint
                : '使用本机 OpenAI-compatible 服务。'}
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">
              {t.model.modelSelect}
            </label>
            <Select
              value={config.model}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {renderModelOptions(selectableModels)}
            </Select>
            <p className="mt-2 text-xs text-zinc-500">
              默认模型只能从已启用模型里选；未启用模型会从输入框下拉隐藏。
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">
              {t.model.temperature}: {temperature}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={temperature}
              onChange={(event) => onTemperatureChange(parseFloat(event.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{t.model.temperaturePrecise}</span>
              <span>{t.model.temperatureCreative}</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Zap className="h-4 w-4 text-amber-300" />
            运行摘要
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Provider</dt>
              <dd className="truncate text-zinc-300">{providerName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Model</dt>
              <dd className="truncate text-zinc-300">{selectedModelLabel}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Endpoint</dt>
              <dd className="max-w-[150px] truncate font-mono text-zinc-400" title={effectiveBaseUrl}>
                {effectiveBaseUrl || '-'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">API Key</dt>
              <dd className={hasApiKey ? 'text-emerald-300' : 'text-amber-300'}>
                {needsApiKey ? (hasApiKey ? '已保存' : '未填写') : '无需填写'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">模型池</dt>
              <dd className="text-zinc-300">{enabledModelCount}/{modelCount} 个</dd>
            </div>
          </dl>
        </div>
      </div>
    </SettingsSection>
  );
};
