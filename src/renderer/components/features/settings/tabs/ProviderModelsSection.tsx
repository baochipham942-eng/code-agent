import React from 'react';
import { Brain, Code2, Eye, Gauge, Plus, RefreshCw, Search, Wrench } from 'lucide-react';
import { Button, Input } from '../../../primitives';
import type { ModelCapability, ModelProvider } from '@shared/contract';
import {
  MODEL_CAPABILITY_OPTIONS,
  featuresFromModelMetadata,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { isWebMode } from '../../../../utils/platform';
import { isModelMetadataLocked } from './ModelSettings.helpers';
import { ProviderDetailCard } from './ProviderDetailSections';

const CAPABILITY_ICONS: Record<string, React.ReactNode> = { tool: <Wrench className="h-3 w-3" />, vision: <Eye className="h-3 w-3" />, reasoning: <Brain className="h-3 w-3" />, code: <Code2 className="h-3 w-3" />, fast: <Gauge className="h-3 w-3" /> };
const MODEL_CAPABILITY_PICKER = MODEL_CAPABILITY_OPTIONS.filter((capability) => ['code', 'vision', 'reasoning', 'fast', 'longContext', 'search'].includes(capability.id));

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
  onToggleModelTool: (model: RuntimeProviderModel) => void;
  onToggleModelCapability: (model: RuntimeProviderModel, capabilityId: ModelCapability) => void;
}

function ModelRow({
  model,
  provider,
  defaultSelection,
  settingDefaultModelId,
  onSetDefaultModel,
  onToggleModelEnabled,
  onToggleModelTool,
  onToggleModelCapability,
}: ModelRowProps) {
  const features = featuresFromModelMetadata({
    modelId: model.id,
    capabilities: model.capabilities,
    supportsTool: model.supportsTool,
    supportsVision: model.supportsVision,
  });
  const metadataLocked = isModelMetadataLocked(provider, model);
  return (
    <div className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-100">
            <input
              type="checkbox"
              checked={model.enabled}
              onChange={(event) => onToggleModelEnabled(model, event.target.checked)}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            <span>{model.label}</span>
          </label>
          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
            {model.source === 'discovered' ? '发现' : '内置'}
          </span>
          {features.map((feature) => (
            <span
              key={feature}
              className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              {CAPABILITY_ICONS[feature]}
              {feature}
            </span>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
          <span>{model.id}</span>
          {model.maxTokens ? <span>{model.maxTokens.toLocaleString()} tokens</span> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
        {/* 设为主任务 */}
        {defaultSelection.provider === provider && defaultSelection.model === model.id ? (
          <span className="inline-flex h-7 items-center gap-1 rounded border border-blue-400/50 bg-blue-500/15 px-2 text-[11px] text-blue-200">
            ★ 主任务
          </span>
        ) : model.enabled ? (
          <button
            type="button"
            onClick={() => void onSetDefaultModel(model.id)}
            disabled={settingDefaultModelId !== null}
            className="inline-flex h-7 items-center rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-500 transition hover:text-zinc-300"
          >
            {settingDefaultModelId === model.id ? '保存中...' : '设为主任务'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onToggleModelTool(model)}
          disabled={metadataLocked}
          className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
            model.supportsTool
              ? 'border-blue-400/50 bg-blue-500/15 text-blue-200'
              : metadataLocked
                ? 'border-zinc-700 bg-zinc-800 text-zinc-500'
                : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
          }`}
          title={metadataLocked ? '内置模型标签由模型目录决定' : '工具调用'}
        >
          <Wrench className="h-3 w-3" />
          工具
        </button>
        {MODEL_CAPABILITY_PICKER.map((capability) => {
          const active = model.capabilities.includes(capability.id);
          return (
            <button
              key={capability.id}
              type="button"
              onClick={() => onToggleModelCapability(model, capability.id)}
              disabled={metadataLocked}
              className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
                active
                  ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                  : metadataLocked
                    ? 'border-zinc-700 bg-zinc-800 text-zinc-500'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
              title={metadataLocked ? '内置模型标签由模型目录决定' : capability.label}
            >
              {CAPABILITY_ICONS[capability.id] ?? <span className="text-[10px]">{capability.label.slice(0, 1)}</span>}
              {capability.label}
            </button>
          );
        })}
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
  onToggleModelTool: (model: RuntimeProviderModel) => void;
  onToggleModelCapability: (model: RuntimeProviderModel, capabilityId: ModelCapability) => void;
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
  manualModelId,
  onManualModelIdChange,
  manualModelLabel,
  onManualModelLabelChange,
  onAddManualModel,
  defaultSelection,
  settingDefaultModelId,
  onSetDefaultModel,
  onToggleModelEnabled,
  onToggleModelTool,
  onToggleModelCapability,
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
      {/* 搜索 + 手动添加 */}
      <div className="mb-3 grid gap-3 lg:grid-cols-[minmax(160px,1fr)_minmax(140px,1fr)_minmax(120px,0.8fr)_auto] lg:items-end">
        <div>
          <label className="mb-2 block text-xs font-medium text-zinc-400">搜索模型</label>
          <Input
            value={modelSearch}
            onChange={(event) => onModelSearchChange(event.target.value)}
            placeholder="搜索模型..."
            inputSize="sm"
            leftIcon={<Search className="h-3.5 w-3.5" />}
          />
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-zinc-400">手动添加：模型 ID</label>
          <Input
            value={manualModelId}
            onChange={(event) => onManualModelIdChange(event.target.value)}
            placeholder="deepseek-v3-2-251201"
            inputSize="sm"
          />
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-zinc-400">显示名称</label>
          <Input
            value={manualModelLabel}
            onChange={(event) => onManualModelLabelChange(event.target.value)}
            placeholder={manualModelId || '可选'}
            inputSize="sm"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onAddManualModel}
          disabled={isWebMode() || !manualModelId.trim()}
          leftIcon={<Plus className="h-3 w-3" />}
          className="lg:mb-px"
        >
          添加
        </Button>
      </div>
      <p className="mb-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs leading-relaxed text-zinc-400">
        主任务模型会影响每一轮交付质量：复杂任务和长上下文适合能力更强的模型，日常小任务避免长期锁定慢模型或按量昂贵模型；自动模式会按任务、成本、速度和能力尝试切换。
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
                onToggleModelTool={onToggleModelTool}
                onToggleModelCapability={onToggleModelCapability}
              />
            ))}
          </div>
        )}
      </div>
    </ProviderDetailCard>
  );
}
