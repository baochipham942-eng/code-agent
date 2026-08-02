import React, { useMemo } from 'react';
import { ArrowLeft, Check, ChevronRight, Search, Settings, Terminal } from 'lucide-react';
import type {
  AgentEngineKind,
  AgentEngineModelCatalog,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';

export type EngineMenuView = 'models' | 'engines';

export interface EngineScopedModelPanelProps {
  view: EngineMenuView;
  sources: readonly AgentEngineSourceDescriptor[];
  catalog: AgentEngineModelCatalog | null;
  currentEngine: AgentEngineKind;
  currentModel?: string;
  query: string;
  busyEngineId?: string | null;
  onQueryChange: (query: string) => void;
  onViewChange: (view: EngineMenuView) => void;
  onSelectEngine: (source: AgentEngineSourceDescriptor) => void;
  onSelectExternalModel: (kind: ExternalAgentEngineKind, model: string) => void;
  onOpenSettings: (tab: 'model' | 'agentEngine') => void;
}

function EngineIcon({ source }: { source: AgentEngineSourceDescriptor }) {
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden text-zinc-300"
      data-engine-icon-slot
    >
      {source.iconAsset ? (
        <img src={source.iconAsset} alt="" className="h-8 w-8 object-contain" />
      ) : (
        <Terminal className="h-8 w-8" aria-hidden="true" />
      )}
    </span>
  );
}

function sourceForKind(
  sources: readonly AgentEngineSourceDescriptor[],
  kind: AgentEngineKind,
): AgentEngineSourceDescriptor | undefined {
  return sources.find((source) => source.kind === kind);
}

export function filterEngineSources(
  sources: readonly AgentEngineSourceDescriptor[],
  query: string,
): AgentEngineSourceDescriptor[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...sources];
  return sources.filter((source) => (
    source.label.toLowerCase().includes(normalized)
    || source.summary.toLowerCase().includes(normalized)
    || source.manifestId.toLowerCase().includes(normalized)
  ));
}

export function EngineScopedModelPanel({
  view,
  sources,
  catalog,
  currentEngine,
  currentModel,
  query,
  busyEngineId,
  onQueryChange,
  onViewChange,
  onSelectEngine,
  onSelectExternalModel,
  onOpenSettings,
}: EngineScopedModelPanelProps) {
  const currentSource = sourceForKind(sources, currentEngine);
  const filteredSources = useMemo(() => filterEngineSources(sources, query), [query, sources]);
  const externalCatalog = currentEngine === 'native'
    ? undefined
    : catalog?.engines.find((entry) => entry.kind === currentEngine);
  const filteredModels = useMemo(() => {
    const models = externalCatalog?.models ?? [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return models;
    return models.filter((model) => (
      model.label.toLowerCase().includes(normalized)
      || model.id.toLowerCase().includes(normalized)
    ));
  }, [externalCatalog?.models, query]);
  const selectedExternalModel = currentEngine === 'native'
    ? undefined
    : externalCatalog?.models.find((model) => model.id === currentModel)
      ?? externalCatalog?.models.find((model) => model.id === externalCatalog.defaultModel);

  if (view === 'engines') {
    return (
      <div data-engine-picker>
        <div className="flex items-center gap-2 border-b border-zinc-700/50 px-2 py-2">
          <button
            type="button"
            onClick={() => onViewChange('models')}
            className="grid h-7 w-7 place-items-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
            aria-label="返回模型"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="text-xs font-medium text-zinc-100">选择执行引擎</div>
            <div className="text-[10px] text-zinc-500">先选引擎，再选择它真实可用的模型</div>
          </div>
        </div>
        <div className="px-2 py-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              autoFocus
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索执行引擎…"
              data-engine-search-input
              className="w-full rounded border border-zinc-700 bg-zinc-900 py-1 pl-7 pr-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />
          </label>
        </div>
        <div className="max-h-72 overflow-y-auto px-1 pb-1" data-engine-scroll-list>
          {filteredSources.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-zinc-500">无匹配引擎</div>
          ) : filteredSources.map((source) => {
            const selected = source.kind === currentEngine;
            const disabled = !source.selectable || busyEngineId !== null;
            const state = source.selectable
              ? source.detected ? '已检测，可用' : '未检测'
              : source.detected
                ? source.authState === 'needs_login'
                  ? '已检测，需要登录'
                  : (source.authState === 'not_checked' || source.authState === 'unknown')
                    && source.evidence === 'production'
                    ? '已检测，登录状态未验证'
                    : '已检测，适配器未开放'
                : source.recommendation?.label ?? '暂不可用';
            return (
              <button
                key={source.manifestId}
                type="button"
                disabled={disabled}
                onClick={() => onSelectEngine(source)}
                data-engine-source={source.manifestId}
                data-selectable={source.selectable ? 'true' : 'false'}
                className="grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-2 text-left transition hover:bg-zinc-700/70 disabled:cursor-default disabled:opacity-55"
              >
                <EngineIcon source={source} />
                <span className="min-w-0 self-center">
                  <strong className="block truncate text-xs font-medium text-zinc-100">{source.label}</strong>
                  <span className="block truncate text-[10px] text-zinc-500">{state}</span>
                </span>
                {selected ? <Check className="h-4 w-4 text-primary-300" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (currentEngine === 'native') {
    return (
      <div className="flex items-center border-b border-zinc-700/50 pr-2" data-current-engine-row>
        <button
          type="button"
          onClick={() => onViewChange('engines')}
          className="grid min-w-0 flex-1 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left hover:bg-zinc-700/50"
        >
          <EngineIcon source={currentSource ?? {
            manifestId: 'native',
            kind: 'native',
            label: 'Neo',
            summary: '',
            detected: true,
            selectable: true,
            authState: 'authenticated',
            modelSelection: 'neo_provider',
            iconAsset: '/code-agent/agent-neo-mark.svg',
            evidence: 'production',
            credentialOwner: 'neo',
            auditNotes: [],
          }} />
          <span className="min-w-0 self-center">
            <strong className="block truncate text-xs font-medium text-zinc-100">Neo</strong>
            <span className="block truncate text-[10px] text-zinc-500">Provider 模型</span>
          </span>
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        </button>
        <button
          type="button"
          onClick={() => onOpenSettings('model')}
          className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          data-neo-model-settings
        >
          去设置
        </button>
      </div>
    );
  }

  const modelSelection = currentSource?.modelSelection ?? 'unavailable';
  return (
    <div data-external-engine-model-panel>
      <div className="flex items-center gap-2 border-b border-zinc-700/50 px-3 py-2">
        {currentSource ? <EngineIcon source={currentSource} /> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-100">{currentSource?.label ?? currentEngine}</div>
          <div
            className="truncate text-[10px] text-zinc-500"
            data-current-external-model
            title={selectedExternalModel?.id}
          >
            {modelSelection === 'runtime_catalog'
              ? selectedExternalModel
                ? `${selectedExternalModel.label} · ${selectedExternalModel.id}`
                : '尚未探测到模型'
              : '官方客户端管理模型'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onViewChange('engines')}
          className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
        >
          切换引擎
        </button>
      </div>

      {modelSelection === 'runtime_catalog' && externalCatalog ? (
        <>
          <div className="px-2 py-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={`搜索 ${currentSource?.label ?? '当前引擎'} 模型…`}
                data-external-model-search-input
                className="w-full rounded border border-zinc-700 bg-zinc-900 py-1 pl-7 pr-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
              />
            </label>
          </div>
          <div className="max-h-64 overflow-y-auto pb-1">
            {filteredModels.map((model) => (
              <button
                key={model.id}
                type="button"
                disabled={Boolean(model.disabledReason)}
                onClick={() => onSelectExternalModel(currentEngine, model.id)}
                data-external-model={model.id}
                className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{model.label}</span>
                  {model.recommended ? <span className="text-[10px] text-primary-300">推荐</span> : null}
                  {currentModel === model.id ? <Check className="ml-auto h-3.5 w-3.5 text-primary-300" /> : null}
                </span>
                <span className="mt-0.5 block text-[10px] text-zinc-500">
                  {model.disabledReason || model.capabilities.join(' · ')}
                </span>
              </button>
            ))}
            {filteredModels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-500">没有探测到匹配模型</div>
            ) : null}
          </div>
        </>
      ) : modelSelection === 'client_default' ? (
        <div className="px-3 py-5 text-center" data-client-default-model>
          <div className="text-xs font-medium text-zinc-200">由官方客户端选择默认模型</div>
          <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            当前客户端没有返回可信模型目录，Neo 不会虚构可选模型。
          </div>
        </div>
      ) : (
        <div className="px-3 py-5 text-center">
          <Settings className="mx-auto h-5 w-5 text-zinc-500" />
          <div className="mt-2 text-xs font-medium text-zinc-200">模型能力暂不可用</div>
          <div className="mt-1 text-[11px] text-zinc-500">请先完成客户端与 Adapter 验证。</div>
          <button
            type="button"
            onClick={() => onOpenSettings('agentEngine')}
            className="mt-3 rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600"
          >
            去执行引擎设置
          </button>
        </div>
      )}
    </div>
  );
}
