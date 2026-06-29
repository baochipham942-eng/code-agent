// ============================================================================
// ProviderDetailSections - Provider 详情面板的「连接」与「高级」区块
//
// Master-Detail 重构（由 CurrentModelConfigurationSection 重组而来）：
//   连接 = 显示名 / 协议 / 地址(+恢复官方) / API Key / 测试连接
//   高级 = 并发 / 代理 / 温度（默认折叠，1% 用户才碰的配置）
// 「模型」区块（发现/手动添加/启用/默认）依赖 handler 多，留在 ModelSettings 内联。
// ============================================================================

import React from 'react';
import { ImagePlus, Key, X } from 'lucide-react';
import type { ModelProviderProtocol, ProxyMode } from '@shared/contract';
import { useI18n } from '../../../../hooks/useI18n';
import { isWebMode } from '../../../../utils/platform';
import { Button, Input, Select, Toggle } from '../../../primitives';
import { SettingsDetails } from '../SettingsLayout';
import { describeProviderIconValidationError, getProtocolLabel } from './ModelSettings.helpers';
import {
  PROVIDER_ICON_IMAGE_MAX_BYTES,
  estimateProviderIconImageBytes,
  isProviderIconAssetRef,
  isProviderImageIcon,
  validateProviderIcon,
  type ProviderIconPreset,
} from '@shared/modelRuntime';
import { useProviderIconImageSource } from '../../../../utils/providerIconAssets';

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
  providerDisplayName,
  providerIcon,
  providerIconPresets,
  providerFavorite,
  providerIdentityManaged = false,
  providerNamePlaceholder,
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
  onDisplayNameChange,
  onProviderIconChange,
  onProviderIconImageUpload,
  onProviderIconUploadError,
  onProviderFavoriteChange,
  onProviderProtocolChange,
  onResetOfficialEndpoint,
  onBaseUrlChange,
  onApiKeyChange,
  onTestConnection,
}) => {
  const { t } = useI18n();
  const iconFileInputRef = React.useRef<HTMLInputElement>(null);
  const providerIconIsImage = isProviderImageIcon(providerIcon);
  const providerIconIsAsset = isProviderIconAssetRef(providerIcon);
  const providerIconImageSource = useProviderIconImageSource(providerIcon);
  const providerIconImageBytes = estimateProviderIconImageBytes(providerIcon);
  const fallbackIconText = providerNamePlaceholder.slice(0, 2).toUpperCase();

  const reportIconUploadError = React.useCallback((message: string) => {
    onProviderIconUploadError?.(message);
  }, [onProviderIconUploadError]);

  const handleProviderIconFileChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
    if (!supportedTypes.has(file.type)) {
      reportIconUploadError('只支持 PNG、JPG、WebP、GIF 或 SVG 图标。');
      return;
    }
    if (file.size > PROVIDER_ICON_IMAGE_MAX_BYTES) {
      reportIconUploadError('Provider 图标不能超过 96 KB。');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const validation = validateProviderIcon(result);
      if (!validation.valid) {
        reportIconUploadError(describeProviderIconValidationError(validation) ?? '图片图标读取失败，请换一张更小的图片。');
        return;
      }
      if (validation.kind !== 'image') {
        reportIconUploadError('图片图标读取失败，请换一张更小的图片。');
        return;
      }
      void (async () => {
        try {
          const storedIcon = await onProviderIconImageUpload?.(validation.normalized);
          onProviderIconChange(storedIcon || validation.normalized);
        } catch {
          reportIconUploadError('本机图标资产目录不可用，已改用内联 data URL 保存。');
          onProviderIconChange(validation.normalized);
        }
      })();
    };
    reader.onerror = () => {
      reportIconUploadError('图片图标读取失败，请重试。');
    };
    reader.readAsDataURL(file);
  }, [onProviderIconChange, onProviderIconImageUpload, reportIconUploadError]);

  return (
    <ProviderDetailCard step="1" title="连接">
      <div className="space-y-4">
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

        <SettingsDetails
          title="显示名称 / 图标 / 协议 / 收藏"
          description="一般不用改：默认按官方名称和接口地址识别。需要自定义标识、切换协议或收藏置顶时再展开。"
        >
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)]">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-200">显示名称</label>
                <Input
                  value={providerDisplayName}
                  onChange={(event) => onDisplayNameChange(event.target.value)}
                  placeholder={providerNamePlaceholder}
                  disabled={providerIdentityManaged}
                />
                {providerIdentityManaged && (
                  <p className="mt-2 text-xs text-zinc-500">
                    团队托管 Provider 的名称由控制面下发，本机只保留收藏偏好。
                  </p>
                )}
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-200">图标标识</label>
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 text-xs font-semibold text-zinc-200">
                    {providerIconIsImage ? (
                      providerIconImageSource ? (
                        <img src={providerIconImageSource} alt="" className="h-full w-full object-cover" />
                      ) : (
                        fallbackIconText
                      )
                    ) : (
                      providerIcon || fallbackIconText
                    )}
                  </span>
                  <Input
                    value={providerIconIsImage ? '' : providerIcon}
                    onChange={(event) => onProviderIconChange(event.target.value)}
                    placeholder={fallbackIconText}
                    maxLength={4}
                    disabled={providerIconIsImage || providerIdentityManaged}
                  />
                </div>
                {providerIconPresets.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label="内置 Provider 图标">
                    {providerIconPresets.map((preset) => (
                      <button
                        key={`${preset.icon}-${preset.label}`}
                        type="button"
                        className={`flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-[11px] font-semibold transition-colors ${
                          providerIdentityManaged
                            ? 'cursor-not-allowed border-zinc-800 bg-zinc-950 text-zinc-600'
                            : providerIcon === preset.icon
                            ? 'border-cyan-400/70 bg-cyan-400/10 text-cyan-100'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800'
                        }`}
                        disabled={providerIdentityManaged}
                        title={preset.label}
                        aria-label={`使用 ${preset.label} 图标`}
                        onClick={() => onProviderIconChange(preset.icon)}
                      >
                        {preset.icon}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <input
                    ref={iconFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    onChange={handleProviderIconFileChange}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    leftIcon={<ImagePlus className="h-3.5 w-3.5" />}
                    onClick={() => iconFileInputRef.current?.click()}
                    disabled={providerIdentityManaged}
                  >
                    上传图片
                  </Button>
                  {providerIconIsImage && !providerIdentityManaged && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leftIcon={<X className="h-3.5 w-3.5" />}
                      onClick={() => onProviderIconChange('')}
                    >
                      清除
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  {providerIdentityManaged
                    ? '团队托管 Provider 的图标由控制面下发，避免本机标识掩盖共享链路身份。'
                    : providerIconIsAsset
                    ? '图片图标保存在本机 assets/provider-icons，settings 只保存引用。Provider 身份仍以显示名称、来源和接口地址为准。'
                    : providerIconIsImage
                    ? `图片图标以内联 data URL 保存在本机 settings 中${providerIconImageBytes !== undefined ? `，约 ${(providerIconImageBytes / 1024).toFixed(1)} KB` : ''}。Provider 身份仍以显示名称、来源和接口地址为准。`
                    : '短标识只影响列表和模型菜单识别；Provider 身份仍以显示名称、来源和接口地址为准。'}
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

            <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-200">收藏 Provider</span>
                <span className="block truncate text-xs text-zinc-500">收藏后在 Provider 列表和模型菜单里前置显示。</span>
              </span>
              <Toggle
                checked={providerFavorite}
                onChange={onProviderFavoriteChange}
                aria-label="收藏 Provider"
              />
            </label>
          </div>
        </SettingsDetails>
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
