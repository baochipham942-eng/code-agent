import React, { useMemo } from 'react';
import { ArrowLeft, Check, ChevronRight, RefreshCw, Search, Settings, Terminal } from 'lucide-react';
import type {
  AgentEngineKind,
  AgentEngineModelCatalog,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import { AGENT_ENGINE_LABELS } from '@shared/contract/agentEngine';
import { useI18n } from '../../hooks/useI18n';
import { Button } from '../primitives/Button';

export type EngineMenuView = 'models' | 'engines';

export interface EngineScopedModelPanelProps {
  view: EngineMenuView;
  sources: readonly AgentEngineSourceDescriptor[];
  /** 首次探测尚未返回（本机 CLI 探测要数秒）：列表区显示检测中而不是空白 */
  engineSourcesLoading?: boolean;
  /** 当前引擎的真实模型目录仍在读取。 */
  modelCatalogLoading?: boolean;
  /** 模型目录请求已经结束且失败；与加载中严格分开。 */
  modelCatalogFailed?: boolean;
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
  onRetryCatalog: () => void;
}

// 无官方 logo 资产的引擎用「首字母 + 品牌色瓦片」区分彼此：满屏同一个终端图标
// 读作「都没有 logo」（真机 2026-08-05）。真 logo 资产到位后配 manifest.iconAsset 即覆盖。
// 前景一律中性 token（theme-blind 门拦亮档彩色前景类），区分度全靠底色。
const ENGINE_TILE_PALETTE = [
  'bg-sky-500/25',
  'bg-violet-500/25',
  'bg-amber-500/25',
  'bg-emerald-500/25',
  'bg-rose-500/25',
  'bg-cyan-500/25',
] as const;

function engineTileClass(manifestId: string): string {
  let hash = 0;
  for (let i = 0; i < manifestId.length; i += 1) hash = (hash * 31 + manifestId.charCodeAt(i)) | 0;
  return ENGINE_TILE_PALETTE[Math.abs(hash) % ENGINE_TILE_PALETTE.length] ?? ENGINE_TILE_PALETTE[0];
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
        <span
          aria-hidden="true"
          className={`grid h-7 w-7 place-items-center rounded-lg text-sm font-semibold text-zinc-200 ${engineTileClass(source.manifestId)}`}
        >
          {source.label.trim().charAt(0).toUpperCase() || <Terminal className="h-4 w-4" />}
        </span>
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
  engineSourcesLoading = false,
  modelCatalogLoading = false,
  modelCatalogFailed = false,
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
  onRetryCatalog,
}: EngineScopedModelPanelProps) {
  const { t } = useI18n();
  const copy = t.engineModelPanel;
  const currentSource = sourceForKind(sources, currentEngine);
  const currentEngineLabel = AGENT_ENGINE_LABELS[currentEngine];
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
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-zinc-100">选择执行引擎</div>
            <div className="text-[10px] text-zinc-500">先选引擎，再选择它真实可用的模型</div>
          </div>
          <button
            type="button"
            onClick={() => onOpenSettings('agentEngine')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
            aria-label="打开执行引擎设置"
            title="执行引擎设置"
            data-engine-settings-link
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
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
          {engineSourcesLoading && filteredSources.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-zinc-500" data-engine-sources-loading>
              正在检测本机可用的执行引擎…
            </div>
          ) : filteredSources.length === 0 ? (
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
                {selected ? <Check className="h-4 w-4 text-badge-accent" /> : null}
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

  const modelSelection = currentSource?.modelSelection
    ?? (externalCatalog ? 'runtime_catalog' : 'unavailable');
  const catalogIsLoading = modelCatalogLoading || (engineSourcesLoading && !currentSource);
  const catalogIsUnavailable = modelSelection === 'runtime_catalog'
    ? modelCatalogFailed || !externalCatalog
    : modelSelection === 'unavailable';
  let modelSubtitle = copy.clientManagedModel;
  if (catalogIsLoading) {
    modelSubtitle = copy.loadingSubtitle;
  } else if (catalogIsUnavailable) {
    modelSubtitle = copy.loadFailedSubtitle;
  } else if (modelSelection === 'runtime_catalog') {
    modelSubtitle = selectedExternalModel
      ? `${selectedExternalModel.label} · ${selectedExternalModel.id}`
      : copy.noDetectedModel;
  }
  return (
    <div data-external-engine-model-panel>
      <div className="flex items-center gap-2 border-b border-zinc-700/50 px-3 py-2">
        {currentSource ? <EngineIcon source={currentSource} /> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-100">{currentEngineLabel}</div>
          <div
            className="truncate text-[10px] text-zinc-500"
            data-current-external-model
            title={selectedExternalModel?.id}
          >
            {modelSubtitle}
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

      {catalogIsLoading ? (
        <div className="px-3 py-3" data-model-catalog-loading role="status">
          <span className="sr-only">{copy.loadingSubtitle}</span>
          <div
            aria-hidden="true"
            className="relative mb-3 h-8 overflow-hidden rounded-md bg-zinc-600/25"
            data-model-catalog-skeleton="search"
          >
            <div className="animate-shimmer absolute inset-0" />
          </div>
          {[62, 46, 54].map((width) => (
            <div
              key={width}
              aria-hidden="true"
              className="relative my-3 h-5 overflow-hidden rounded-md bg-zinc-600/25"
              style={{ width: `${width}%` }}
              data-model-catalog-skeleton="row"
            >
              <div className="animate-shimmer absolute inset-0" />
            </div>
          ))}
        </div>
      ) : modelSelection === 'runtime_catalog' && externalCatalog ? (
        <>
          <div className="px-2 py-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={copy.searchPlaceholder.replace('{engine}', currentEngineLabel)}
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
                  {model.recommended ? <span className="text-[10px] text-badge-accent">{copy.recommended}</span> : null}
                  {currentModel === model.id ? <Check className="ml-auto h-3.5 w-3.5 text-badge-accent" /> : null}
                </span>
                <span className="mt-0.5 block text-[10px] text-zinc-500">
                  {model.disabledReason || model.capabilities.join(' · ')}
                </span>
              </button>
            ))}
            {filteredModels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-500">{copy.noMatchingModel}</div>
            ) : null}
          </div>
        </>
      ) : modelSelection === 'client_default' ? (
        <div className="px-3 py-5 text-center" data-client-default-model>
          <div className="text-xs font-medium text-zinc-200">{copy.clientDefaultTitle}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            {copy.clientDefaultDescription}
          </div>
        </div>
      ) : (
        <div className="px-3 py-5 text-center" data-model-catalog-unavailable>
          <Settings className="mx-auto h-5 w-5 text-zinc-500" />
          <div className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            {copy.loadFailedDescription.replace('{engine}', currentEngineLabel)}
          </div>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={onRetryCatalog}
              leftIcon={<RefreshCw className="h-3 w-3" />}
              data-model-catalog-retry
            >
              {copy.retry}
            </Button>
            <button
              type="button"
              onClick={() => onOpenSettings('agentEngine')}
              className="rounded px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
            >
              {copy.openEngineSettings}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
