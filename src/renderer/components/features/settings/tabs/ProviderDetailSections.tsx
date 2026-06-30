// ============================================================================
// ProviderDetailSections - Provider 详情面板的「连接」与「高级」区块
//
// Master-Detail 重构（由 CurrentModelConfigurationSection 重组而来）：
//   连接 = 显示名 / 协议 / 地址(+恢复官方) / API Key / 测试连接
//   高级 = 并发 / 代理 / 温度（默认折叠，1% 用户才碰的配置）
// 「模型」区块（发现/手动添加/启用/默认）依赖 handler 多，留在 ModelSettings 内联。
// ============================================================================

import React from 'react';
import { Key } from 'lucide-react';
import type { ModelProviderProtocol, ProxyMode } from '@shared/contract';
import { useI18n } from '../../../../hooks/useI18n';
import { isWebMode } from '../../../../utils/platform';
import { Button, Input, Select } from '../../../primitives';
import { getProtocolLabel } from './ModelSettings.helpers';
import { type ProviderIconPreset } from '@shared/modelRuntime';

// ── 区块外壳：编号 + 标题 + 右侧动作 ──
export const ProviderDetailCard: React.FC<{
  step: string;
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ step, title, meta, actions, children }) => (
  <section className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-zinc-800 text-[11px] font-medium text-zinc-400">
          {step}
        </span>
        {title}
        {meta ? <span className="text-xs font-normal text-zinc-500">{meta}</span> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
    <div className="p-4">{children}</div>
  </section>
);

// ============================================================================
// ① 连接
// ============================================================================

interface ProviderConnectionSectionProps {
  providerDisplayName: string;
  providerIcon: string;
  providerIconPresets: ProviderIconPreset[];
  providerFavorite: boolean;
  providerIdentityManaged?: boolean;
  providerNamePlaceholder: string;
  effectiveProtocol: ModelProviderProtocol;
  isCustomProviderProtocolEditable: boolean;
  showOfficialEndpointReset: boolean;
  registryEndpoint: string;
  configuredBaseUrl: string;
  apiKey: string;
  needsApiKey: boolean;
  hasStoredApiKey: boolean;
  isTesting: boolean;
  canTestConnection: boolean;
  onDisplayNameChange: (value: string) => void;
  onProviderIconChange: (value: string) => void;
  onProviderIconImageUpload?: (dataUrl: string) => Promise<string | undefined>;
  onProviderIconUploadError?: (message: string) => void;
  onProviderFavoriteChange: (value: boolean) => void;
  onProviderProtocolChange: (protocol: ModelProviderProtocol) => void;
  onResetOfficialEndpoint: () => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onTestConnection: () => void;
}

export const ProviderConnectionSection: React.FC<ProviderConnectionSectionProps> = ({
  effectiveProtocol,
  isCustomProviderProtocolEditable,
  showOfficialEndpointReset,
  registryEndpoint,
  configuredBaseUrl,
  apiKey,
  needsApiKey,
  hasStoredApiKey,
  isTesting,
  canTestConnection,
  onProviderProtocolChange,
  onResetOfficialEndpoint,
  onBaseUrlChange,
  onApiKeyChange,
  onTestConnection,
}) => {
  const { t } = useI18n();

  return (
    <ProviderDetailCard step="1" title="连接">
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_12rem] lg:items-start">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-zinc-200">接口地址（Base URL）</label>
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
            <label className="mb-2 block text-sm font-medium text-zinc-200">协议</label>
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
        </div>

        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <label className="mb-2 block text-sm font-medium text-zinc-200">{t.model.apiKey}</label>
            <Input
              type="password"
              value={apiKey}
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
          </div>
          <Button
            disabled={isWebMode() || !canTestConnection}
            onClick={onTestConnection}
            loading={isTesting}
            variant="secondary"
            className="shrink-0"
          >
            测试连接
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          {needsApiKey
            ? hasStoredApiKey && !apiKey
              ? 'API Key 已在本机加密保存。'
              : t.model.apiKeyHint
            : '使用本机 OpenAI-compatible 服务。'}
        </p>
      </div>
    </ProviderDetailCard>
  );
};

// ============================================================================
// ③ 高级（默认折叠：并发 / 代理 / 温度）
// ============================================================================

interface ProviderAdvancedSectionProps {
  maxConcurrent?: number;
  defaultMaxConcurrent?: number;
  proxyMode?: ProxyMode;
  temperature: number;
  onMaxConcurrentChange: (value: number | undefined) => void;
  onProxyModeChange: (mode: ProxyMode) => void;
  onTemperatureChange: (temperature: number) => void;
}

export const ProviderAdvancedSection: React.FC<ProviderAdvancedSectionProps> = ({
  maxConcurrent,
  defaultMaxConcurrent,
  proxyMode,
  temperature,
  onMaxConcurrentChange,
  onProxyModeChange,
  onTemperatureChange,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);

  return (
    <section className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-zinc-800 text-[11px] font-medium text-zinc-400">
            3
          </span>
          高级
          <span className={`text-[11px] text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        </div>
        <span className="text-xs text-zinc-500">并发 · 代理 · 温度</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-zinc-800 p-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">最大并发请求数</label>
              <Input
                type="number"
                min={0}
                value={maxConcurrent ?? ''}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === '') {
                    onMaxConcurrentChange(undefined);
                    return;
                  }
                  const n = Math.floor(Number(raw));
                  onMaxConcurrentChange(Number.isFinite(n) && n > 0 ? n : undefined);
                }}
                placeholder={defaultMaxConcurrent ? `默认 ${defaultMaxConcurrent}` : '留空 = 不限流'}
              />
              <p className="mt-2 text-xs text-zinc-500">
                限制该 Provider 的同时请求数，防止高并发（如批量子代理 / workflow）触发 429 限流。
                留空或 0 = 使用内置默认{defaultMaxConcurrent ? `（${defaultMaxConcurrent}）` : '（不限流）'}。命中限流自动降级，5 分钟无限流后回升。
              </p>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">代理模式</label>
              <Select
                value={proxyMode ?? 'auto'}
                onChange={(event) => onProxyModeChange(event.target.value as ProxyMode)}
              >
                <option value="auto">自动（按内置国内外判断）</option>
                <option value="direct">强制直连</option>
                <option value="proxy">强制走代理</option>
              </Select>
              <p className="mt-2 text-xs text-zinc-500">
                控制该 Provider 是否走全局 HTTPS_PROXY。自动 = 海外 provider 走代理、国内（含小米 mimo）直连；direct / proxy 强制覆盖。
              </p>
            </div>
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
      )}
    </section>
  );
};
