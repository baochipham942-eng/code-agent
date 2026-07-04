import React from 'react';
import { Brain, Code2, Eye, Gauge, RefreshCw, Search, Wrench } from 'lucide-react';
import { Button, Input, Toggle } from '../../../primitives';
import type { ModelProvider } from '@shared/contract';
import { CONTEXT_WINDOWS, MODEL_MAX_OUTPUT_TOKENS, normalizeModelId } from '@shared/constants';
import {
  featuresFromModelMetadata,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { ProviderDetailCard } from './ProviderDetailSections';

const CAPABILITY_ICONS: Record<string, React.ReactNode> = { tool: <Wrench className="h-3 w-3" />, vision: <Eye className="h-3 w-3" />, reasoning: <Brain className="h-3 w-3" />, code: <Code2 className="h-3 w-3" />, fast: <Gauge className="h-3 w-3" /> };

function formatTokens(value?: number): string {
  if (!value) return '—';
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return `${value}`;
}

interface DefaultModelSelection {
  provider: ModelProvider;
  model: string;
}

interface ModelRowProps {
  model: RuntimeProviderModel;
  provider: ModelProvider;
  defaultSelection: DefaultModelSelection;
  settingDefaultModelId: string | null;
  onSetDefaultModel: (modelId: string) => void;
  onToggleModelEnabled: (model: RuntimeProviderModel, enabled: boolean) => void;
}

function ModelRow({
  model,
  provider,
  defaultSelection,
  settingDefaultModelId,
  onSetDefaultModel,
  onToggleModelEnabled,
}: ModelRowProps) {
  const { t } = useI18n();
  const modelText = t.settings.model.models;
  const features = featuresFromModelMetadata({
    modelId: model.id,
    capabilities: model.capabilities,
    supportsTool: model.supportsTool,
    supportsVision: model.supportsVision,
  });
  const isDefault = defaultSelection.provider === provider && defaultSelection.model === model.id;
  // 优先用发现/配置捕获的真值，回退到内置模型表（按规范化 id 查）。
  const normId = normalizeModelId(model.id);
  const contextWindow = model.contextWindow ?? CONTEXT_WINDOWS[normId];
  const maxOutput = model.maxTokens ?? MODEL_MAX_OUTPUT_TOKENS[normId];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3">
      {/* 左：①名称 + 默认 + 内置 / ②类型标签 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">{model.label}</span>
          {isDefault && (
            <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">{modelText.defaultBadge}</span>
          )}
          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {model.source === 'discovered' ? modelText.sourceDiscovered : modelText.sourceBuiltin}
          </span>
        </div>
        {features.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {features.map((feature) => (
              <span
                key={feature}
                className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
              >
                {CAPABILITY_ICONS[feature]}
                {feature}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 右：固定列宽对齐——上下文 / MAX OUTPUT / 设为默认（占位保留）/ 进选择页 */}
      <div className="grid shrink-0 grid-cols-[4rem_5rem_5.5rem_3.5rem] items-center gap-3">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{modelText.contextLabel}</div>
          <div className="text-xs text-zinc-300">{formatTokens(contextWindow)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Max Output</div>
          <div className="text-xs text-zinc-300">{formatTokens(maxOutput)}</div>
        </div>
        <div className="flex justify-end">
          {!isDefault && model.enabled ? (
            <button
              type="button"
              onClick={() => void onSetDefaultModel(model.id)}
              disabled={settingDefaultModelId !== null}
              className="inline-flex h-7 items-center rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-400 transition hover:text-zinc-200"
            >
              {settingDefaultModelId === model.id ? modelText.setDefaultSaving : modelText.setDefault}
            </button>
          ) : null}
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] text-zinc-500">{modelText.selectableLabel}</span>
          <Toggle
            checked={model.enabled}
            onChange={(checked) => onToggleModelEnabled(model, checked)}
            aria-label={modelText.selectableAriaLabel}
          />
        </div>
      </div>
    </div>
  );
}

export interface ProviderModelsSectionProps {
  hasApiKey: boolean;
  provider: ModelProvider;
  currentModels: RuntimeProviderModel[];
  currentEnabledModels: RuntimeProviderModel[];
  filteredCurrentModels: RuntimeProviderModel[];
  effectiveBaseUrl: string;
  isDiscovering: boolean;
  onDiscoverModels: () => void;
  modelSearch: string;
  onModelSearchChange: (value: string) => void;
  manualModelId: string;
  onManualModelIdChange: (value: string) => void;
  manualModelLabel: string;
  onManualModelLabelChange: (value: string) => void;
  onAddManualModel: () => void;
  defaultSelection: DefaultModelSelection;
  settingDefaultModelId: string | null;
  onSetDefaultModel: (modelId: string) => void;
  onToggleModelEnabled: (model: RuntimeProviderModel, enabled: boolean) => void;
}

export function ProviderModelsSection({
  hasApiKey,
  provider,
  currentModels,
  currentEnabledModels,
  filteredCurrentModels,
  effectiveBaseUrl,
  isDiscovering,
  onDiscoverModels,
  modelSearch,
  onModelSearchChange,
  defaultSelection,
  settingDefaultModelId,
  onSetDefaultModel,
  onToggleModelEnabled,
}: ProviderModelsSectionProps) {
  const { t } = useI18n();
  const modelText = t.settings.model.models;
  if (!hasApiKey) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-xs text-zinc-500">
        {modelText.needsApiKeyEmpty}
      </div>
    );
  }

  return (
    <ProviderDetailCard
      step="2"
      title={modelText.title}
      meta={`${currentEnabledModels.length}${modelText.metaEnabledSuffix}${currentModels.length}${modelText.metaTotalSuffix}`}
      actions={(
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onDiscoverModels()}
          disabled={isWebMode() || !effectiveBaseUrl}
          loading={isDiscovering}
          leftIcon={<RefreshCw className="h-3 w-3" />}
        >
          {modelText.discover}
        </Button>
      )}
    >
      {/* 搜索 */}
      <div className="mb-3">
        <Input
          value={modelSearch}
          onChange={(event) => onModelSearchChange(event.target.value)}
          placeholder={modelText.searchPlaceholder}
          inputSize="sm"
          leftIcon={<Search className="h-3.5 w-3.5" />}
        />
      </div>
      <p className="mb-3 text-xs leading-relaxed text-zinc-500">
        {modelText.selectionHint}
      </p>

      {/* 模型列表 */}
      <div className="max-h-[420px] overflow-y-auto rounded-lg border border-zinc-800">
        {filteredCurrentModels.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">
            {modelText.noMatch}
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {filteredCurrentModels.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                provider={provider}
                defaultSelection={defaultSelection}
                settingDefaultModelId={settingDefaultModelId}
                onSetDefaultModel={onSetDefaultModel}
                onToggleModelEnabled={onToggleModelEnabled}
              />
            ))}
          </div>
        )}
      </div>
    </ProviderDetailCard>
  );
}
