import React from 'react';
import { Brain, Code2, Eye, Gauge, RefreshCw, Search, Wrench } from 'lucide-react';
import { Button, Input, Toggle } from '../../../primitives';
import type { ModelProvider } from '@shared/contract';
import { CONTEXT_WINDOWS } from '@shared/constants';
import {
  featuresFromModelMetadata,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { isWebMode } from '../../../../utils/platform';
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
  const features = featuresFromModelMetadata({
    modelId: model.id,
    capabilities: model.capabilities,
    supportsTool: model.supportsTool,
    supportsVision: model.supportsVision,
  });
  const isDefault = defaultSelection.provider === provider && defaultSelection.model === model.id;
  const contextWindow = CONTEXT_WINDOWS[model.id];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3">
      {/* 左：①名称 + 默认 + 内置 / ②类型标签 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">{model.label}</span>
          {isDefault && (
            <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">★ 默认</span>
          )}
          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {model.source === 'discovered' ? '发现' : '内置'}
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

      {/* 右：上下文 / Max Output（只读）+ 设为默认 + 进选择页 */}
      <div className="flex shrink-0 items-center gap-4">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">上下文</div>
          <div className="text-xs text-zinc-300">{formatTokens(contextWindow)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Max Output</div>
          <div className="text-xs text-zinc-300">{formatTokens(model.maxTokens)}</div>
        </div>
        {!isDefault && model.enabled ? (
          <button
            type="button"
            onClick={() => void onSetDefaultModel(model.id)}
            disabled={settingDefaultModelId !== null}
            className="inline-flex h-7 items-center rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-400 transition hover:text-zinc-200"
          >
            {settingDefaultModelId === model.id ? '保存中...' : '设为默认'}
          </button>
        ) : null}
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] text-zinc-500">进选择页</span>
          <Toggle
            checked={model.enabled}
            onChange={(checked) => onToggleModelEnabled(model, checked)}
            aria-label="该模型是否进入模型选择页"
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
  if (!hasApiKey) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-xs text-zinc-500">
        填写 API Key 并测试连接后，即可发现和启用该 Provider 的模型。
      </div>
    );
  }

  return (
    <ProviderDetailCard
      step="2"
      title="模型"
      meta={`${currentEnabledModels.length} 已启用 / ${currentModels.length} 个`}
      actions={(
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onDiscoverModels()}
          disabled={isWebMode() || !effectiveBaseUrl}
          loading={isDiscovering}
          leftIcon={<RefreshCw className="h-3 w-3" />}
        >
          发现模型
        </Button>
      )}
    >
      {/* 搜索 */}
      <div className="mb-3">
        <Input
          value={modelSearch}
          onChange={(event) => onModelSearchChange(event.target.value)}
          placeholder="搜索模型..."
          inputSize="sm"
          leftIcon={<Search className="h-3.5 w-3.5" />}
        />
      </div>
      <p className="mb-3 text-xs leading-relaxed text-zinc-500">
        勾上「进选择页」的模型会出现在对话的模型选择里；「设为默认」决定 Neo 默认用哪个。
      </p>

      {/* 模型列表 */}
      <div className="max-h-[420px] overflow-y-auto rounded-lg border border-zinc-800">
        {filteredCurrentModels.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">
            没有匹配模型
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
