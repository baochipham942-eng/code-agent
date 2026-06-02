// ============================================================================
// ModelSwitcher - 运行时模型切换下拉框
// ============================================================================
// 嵌入 StatusBar，支持对话中途切换模型

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelProvider } from '@shared/contract';
import type {
  AgentEngineDescriptor,
  AgentEngineKind,
  AgentEngineModelCatalogModel,
  AgentEngineModelCatalogResult,
  AgentEngineSessionMetadata,
} from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { getProviderDisplayName } from '@shared/constants';
import {
  buildRuntimeModelOptions,
  groupRuntimeModelOptionsByProvider,
  getRuntimeModelLabel,
  hasConfiguredRuntimeModels,
  type RuntimeModelOption,
} from '@shared/modelRuntime';
import { toast } from '../../hooks/useToast';
import { Brain, Sparkles, Zap, Cpu, Code2, Settings } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useModeStore } from '../../stores/modeStore';
import { trackRenderer } from '../../observability/posthogRenderer';
import { POSTHOG_EVENTS } from '@shared/observability/posthog-events';
import {
  buildModelSwitcherEngineSelection,
  CAPABILITY_CONFIG,
  ENGINE_ICON,
  ENGINE_SHORT_LABEL,
  formatEngineTooltip,
  getEngineEffortOptions,
  getEngineUnavailableReason,
  getProviderEffortOptions,
  getSelectedEffortOption,
  HEALTH_DOT_COLOR,
  isExternalEngineKind,
  ProviderLogo,
  QUICK_SWITCH_PROVIDERS,
} from './modelSwitcherHelpers';

export { buildModelSwitcherEngineSelection } from './modelSwitcherHelpers';

interface ModelSwitcherProps {
  currentModel: string;
}

export const MODEL_OVERRIDE_CHANGE_EVENT = 'code-agent:model-override-change';

export interface ModelOverrideChangeDetail {
  sessionId: string;
  override: {
    provider: ModelProvider;
    model: string;
    adaptive?: boolean;
  } | null;
}

export function shouldShowModelSettingsPrompt(
  engineKind: AgentEngineKind,
  modelSettings: AppSettings | null,
  nativeHasConfiguredModels: boolean,
): boolean {
  return engineKind === 'native'
    && modelSettings !== null
    && !nativeHasConfiguredModels;
}

function emitModelOverrideChange(detail: ModelOverrideChangeDetail): void {
  window.dispatchEvent(new CustomEvent<ModelOverrideChangeDetail>(MODEL_OVERRIDE_CHANGE_EVENT, { detail }));
}

function trackModelSelected(properties: Record<string, unknown>): void {
  trackRenderer(POSTHOG_EVENTS.MODEL_SELECTED, properties);
}

export function ModelSwitcher({ currentModel }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const [overrideProvider, setOverrideProvider] = useState<ModelProvider | null>(null);
  const [overrideAdaptive, setOverrideAdaptive] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const [healthMap, setHealthMap] = useState<Record<string, { status: string; latencyP50: number; errorRate: number }>>({});
  const [modelSettings, setModelSettings] = useState<AppSettings | null>(null);
  const [engineCatalogResult, setEngineCatalogResult] = useState<AgentEngineModelCatalogResult | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const session = useSessionStore((s) =>
    s.currentSessionId
      ? s.sessions.find((item) => item.id === s.currentSessionId) ?? null
      : null
  );
  const updateSessionEngine = useSessionStore((s) => s.updateSessionEngine);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const appWorkingDirectory = useAppStore((s) => s.workingDirectory);
  const defaultProvider = useAppStore((s) => s.modelConfig.provider);
  // effort 切换内嵌到模型菜单顶部，对照 Codex 的"模型 + Intelligence"两层选择
  const effortLevel = useModeStore((s) => s.effortLevel);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);
  const thinkingEnabled = useModeStore((s) => s.thinkingEnabled);
  const setThinkingEnabled = useModeStore((s) => s.setThinkingEnabled);
  // Engine adapter（Native/Codex/Claude）— 从 AgentEngineSelector 合并进来，
  // 让"Engine · Model · Effort"在一个 trigger 里统一展示和切换。
  const engine = normalizeAgentEngineSession(session?.engine);
  const effectiveWorkingDirectory = session?.workingDirectory || appWorkingDirectory || null;
  const [engineDescriptors, setEngineDescriptors] = useState<AgentEngineDescriptor[]>([]);
  const selectedEngineDescriptor = useMemo(
    () => engineDescriptors.find((descriptor) => descriptor.kind === engine.kind) ?? null,
    [engine.kind, engineDescriptors],
  );
  const selectedEngineCatalog = useMemo(() => {
    if (!engineCatalogResult || !isExternalEngineKind(engine.kind)) return null;
    return engineCatalogResult.catalog.engines.find((item) => item.kind === engine.kind) ?? null;
  }, [engine.kind, engineCatalogResult]);
  const modelProviderInclusions = useMemo(
    () => Array.from(new Set([
      defaultProvider,
      overrideProvider,
    ].filter(Boolean))) as ModelProvider[],
    [defaultProvider, overrideProvider],
  );

  const modelOptions = useMemo(
    () => buildRuntimeModelOptions(modelSettings, QUICK_SWITCH_PROVIDERS, {
      includeDisabledProviders: modelProviderInclusions,
    }),
    [modelProviderInclusions, modelSettings],
  );
  const nativeHasConfiguredModels = useMemo(
    () => hasConfiguredRuntimeModels(modelSettings),
    [modelSettings],
  );
  const showModelSettingsPrompt = shouldShowModelSettingsPrompt(
    engine.kind,
    modelSettings,
    nativeHasConfiguredModels,
  );
  const visibleModelOptions = showModelSettingsPrompt ? [] : modelOptions;

  // 搜索过滤
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return visibleModelOptions;
    const q = searchQuery.toLowerCase();
    return visibleModelOptions.filter((opt) => {
      const providerName = (opt.providerLabel || getProviderDisplayName(opt.provider) || opt.provider).toLowerCase();
      return (
        opt.label.toLowerCase().includes(q) ||
        opt.model.toLowerCase().includes(q) ||
        providerName.includes(q)
      );
    });
  }, [searchQuery, visibleModelOptions]);

  const groupedFilteredOptions = useMemo(() => {
    let nextIndex = 1;
    return groupRuntimeModelOptionsByProvider(filteredOptions).map((group) => ({
      ...group,
      options: group.options.map((option) => ({
        option,
        index: nextIndex++,
      })),
    }));
  }, [filteredOptions]);

  const filteredEngineModels = useMemo(() => {
    if (!selectedEngineCatalog) return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return selectedEngineCatalog.models;
    return selectedEngineCatalog.models.filter((model) =>
      model.id.toLowerCase().includes(query) ||
      model.label.toLowerCase().includes(query) ||
      model.capabilities.some((capability) => capability.toLowerCase().includes(query))
    );
  }, [searchQuery, selectedEngineCatalog]);

  const getPreferredEngineModel = useCallback(
    (kind: AgentEngineKind): string | undefined => {
      if (!isExternalEngineKind(kind)) return undefined;
      const catalogEngine = engineCatalogResult?.catalog.engines.find((item) => item.kind === kind);
      const localDefault = modelSettings?.models?.agentEngines?.[kind]?.defaultModel;
      const enabledModels = catalogEngine?.models.filter((model) => !model.disabledReason) ?? [];
      return enabledModels.find((model) => model.id === localDefault)?.id
        ?? enabledModels.find((model) => model.id === catalogEngine?.defaultModel)?.id
        ?? enabledModels[0]?.id;
    },
    [engineCatalogResult, modelSettings],
  );

  // 打开时自动聚焦搜索框 + 重置搜索
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      // 延迟聚焦，等待 DOM 渲染
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [open]);

  // 打开时读取模型设置，保证输入框模型列表和 Settings 的启用状态一致
  useEffect(() => {
    if (!open) return;
    window.domainAPI?.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {})
      .then((res) => {
        if (res?.success && res.data) {
          setModelSettings(res.data);
        }
      })
      .catch(() => { /* 设置读取失败时保留内置模型列表兜底 */ });
  }, [open]);

  // 打开时拉取 provider 健康状态
  useEffect(() => {
    if (open) {
      window.domainAPI?.invoke<Record<string, { status: string; latencyP50: number; errorRate: number }>>(
        IPC_DOMAINS.PROVIDER,
        'getHealthStatus',
        {}
      )
        .then((res) => { if (res?.success && res.data) setHealthMap(res.data); })
        .catch(() => { /* 静默失败，健康点不显示即可 */ });
    }
  }, [open]);

  // 打开时拉取 agent engine 描述符（Native/Codex/Claude 可用性）
  useEffect(() => {
    if (!open) return;
    window.domainAPI?.invoke<AgentEngineDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, 'list', {})
      .then((res) => { if (res?.success && res.data) setEngineDescriptors(res.data); })
      .catch(() => { /* engine 检测失败时只显示当前 engine 标签 */ });
  }, [open]);

  // 打开时拉取服务端签名模型目录；主进程已做验签和 bundled fallback。
  useEffect(() => {
    if (!open) return;
    window.domainAPI?.invoke<AgentEngineModelCatalogResult>(IPC_DOMAINS.AGENT_ENGINE, 'listModels', {})
      .then((res) => { if (res?.success && res.data) setEngineCatalogResult(res.data); })
      .catch(() => {
        setEngineCatalogResult(null);
      });
  }, [open]);

  const selectEngine = useCallback(
    async (descriptor: AgentEngineDescriptor) => {
      if (!sessionId) return;
      if (descriptor.kind !== 'native' && !effectiveWorkingDirectory) {
        toast.error(`${descriptor.label} 需要先选择工作目录`);
        return;
      }
      if (!descriptor.executable) {
        toast.info(`${descriptor.label} 当前只开放检测和历史导入`);
        return;
      }
      if (
        descriptor.installState === 'missing'
        || descriptor.runtimeState === 'error'
        || descriptor.runtimeState === 'blocked'
      ) {
        toast.error(`${descriptor.label} 不可用`);
        return;
      }
      await updateSessionEngine(
        sessionId,
        buildModelSwitcherEngineSelection(
          descriptor,
          effectiveWorkingDirectory,
          getPreferredEngineModel(descriptor.kind),
        ),
      );
    },
    [effectiveWorkingDirectory, getPreferredEngineModel, sessionId, updateSessionEngine]
  );

  // 点击外部关闭（portal 让菜单脱离 ref，需要同时检查 triggerRef + menuRef）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    if (open) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [open]);

  // 打开时 / 视口变化时，计算菜单 fixed 定位（portal 到 body，脱离父容器 overflow 限制）
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const updatePos = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 4,
      });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  // 加载当前 override
  useEffect(() => {
    if (!sessionId) return;
    window.domainAPI
      ?.invoke<{ provider: string; model: string; adaptive?: boolean } | null>(
        IPC_DOMAINS.SESSION,
        'getModelOverride',
        { sessionId }
      )
      .then((res) => {
        if (res?.success) {
          setOverrideModel(res.data?.model ?? null);
          setOverrideProvider((res.data?.provider as ModelProvider | undefined) ?? null);
          setOverrideAdaptive(!!res.data?.adaptive);
        } else {
          toast.error('加载模型覆盖失败: ' + (res?.error?.message ?? '未知错误'));
        }
      })
      .catch((err: unknown) => toast.error('加载模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误')));
  }, [sessionId]);

  const handleSelect = useCallback(
    async (option: RuntimeModelOption) => {
      if (!sessionId) return;
      try {
        const res = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
          sessionId,
          provider: option.provider,
          model: option.model,
          adaptive: false,
        });
        if (!res?.success) {
          toast.error('模型切换失败: ' + (res?.error?.message ?? '未知错误') + '。请检查 API Key 或网络连接');
          return;
        }
        setOverrideModel(option.model);
        setOverrideProvider(option.provider);
        setOverrideAdaptive(false);
        emitModelOverrideChange({
          sessionId,
          override: { provider: option.provider, model: option.model, adaptive: false },
        });
        trackModelSelected({
          sessionId,
          engine: 'native',
          provider: option.provider,
          model: option.model,
          mode: 'override',
        });
        setOpen(false);
      } catch (err) {
        toast.error('模型切换失败: ' + (err instanceof Error ? err.message : '未知错误') + '。请检查 API Key 或网络连接');
      }
    },
    [sessionId]
  );

  const handleOpenModelSettings = useCallback(() => {
    setOpen(false);
    openSettingsTab('model');
  }, [openSettingsTab]);

  const handleSelectEngineModel = useCallback(
    async (model: AgentEngineModelCatalogModel) => {
      if (!sessionId || !isExternalEngineKind(engine.kind)) return;
      const needsWorkspace = !effectiveWorkingDirectory;
      const unavailableReason = selectedEngineDescriptor
        ? getEngineUnavailableReason(selectedEngineDescriptor, needsWorkspace)
        : null;
      if (unavailableReason) {
        toast.info(unavailableReason);
        return;
      }
      if (model.disabledReason) {
        toast.info(model.disabledReason);
        return;
      }
      try {
        const res = await window.domainAPI?.invoke<AgentEngineSessionMetadata>(
          IPC_DOMAINS.AGENT_ENGINE,
          'selectModel',
          {
            sessionId,
            kind: engine.kind,
            model: model.id,
          },
        );
        if (!res?.success || !res.data) {
          toast.error('模型切换失败: ' + (res?.error?.message ?? '未知错误'));
          return;
        }
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((item) =>
            item.id === sessionId
              ? { ...item, engine: normalizeAgentEngineSession(res.data), updatedAt: Date.now() }
              : item
          ),
        }));
        trackModelSelected({
          sessionId,
          engine: engine.kind,
          model: model.id,
          mode: 'engine_model',
        });
        setOpen(false);
      } catch (err) {
        toast.error('模型切换失败: ' + (err instanceof Error ? err.message : '未知错误'));
      }
    },
    [effectiveWorkingDirectory, engine.kind, selectedEngineDescriptor, sessionId],
  );

  const handleSelectAuto = useCallback(async () => {
    if (!sessionId) return;
    try {
      // 自动模式：provider/model 传当前默认作占位，后端靠 adaptive=true 判断
      const res = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
        sessionId,
        provider: defaultProvider,
        model: currentModel,
        adaptive: true,
      });
      if (!res?.success) {
        toast.error('切换到自动模式失败: ' + (res?.error?.message ?? '未知错误'));
        return;
      }
      setOverrideModel(currentModel);
      setOverrideProvider(defaultProvider);
      setOverrideAdaptive(true);
      emitModelOverrideChange({
        sessionId,
        override: { provider: defaultProvider, model: currentModel, adaptive: true },
      });
      trackModelSelected({
        sessionId,
        engine: 'native',
        provider: defaultProvider,
        model: currentModel,
        mode: 'adaptive',
      });
      setOpen(false);
    } catch (err) {
      toast.error('切换到自动模式失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }, [sessionId, defaultProvider, currentModel]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await window.domainAPI?.invoke(
        IPC_DOMAINS.SESSION,
        'clearModelOverride',
        { sessionId }
      );
      if (!res?.success) {
        toast.error('清除模型覆盖失败: ' + (res?.error?.message ?? '未知错误'));
        return;
      }
      setOverrideModel(null);
      setOverrideProvider(null);
      setOverrideAdaptive(false);
      emitModelOverrideChange({ sessionId, override: null });
      trackModelSelected({
        sessionId,
        engine: 'native',
        provider: defaultProvider,
        model: currentModel,
        mode: 'default',
      });
      setOpen(false);
    } catch (err) {
      toast.error('清除模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }, [sessionId, defaultProvider, currentModel]);

  const selectableOptionCount = engine.kind === 'native'
    ? showModelSettingsPrompt ? 0 : 1 + filteredOptions.length
    : filteredEngineModels.length;

  useEffect(() => {
    if (!open) return;
    setActiveOptionIndex(0);
  }, [engine.kind, open, searchQuery]);

  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    setActiveOptionIndex((index) => Math.min(index, selectableOptionCount - 1));
  }, [open, selectableOptionCount]);

  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    const active = menuRef.current?.querySelector<HTMLElement>(`[data-model-option-index="${activeOptionIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionIndex, open, selectableOptionCount]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      setActiveOptionIndex((index) => {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (index + delta + selectableOptionCount) % selectableOptionCount;
      });
      return;
    }

    if (event.key === 'Enter') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      if (engine.kind === 'native') {
        if (activeOptionIndex === 0) {
          void handleSelectAuto();
          return;
        }
        const option = filteredOptions[activeOptionIndex - 1];
        if (option) void handleSelect(option);
        return;
      }
      const model = filteredEngineModels[activeOptionIndex];
      if (model) void handleSelectEngineModel(model);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, [
    activeOptionIndex,
    engine.kind,
    filteredEngineModels,
    filteredOptions,
    handleSelect,
    handleSelectAuto,
    handleSelectEngineModel,
    selectableOptionCount,
  ]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = engine.kind === 'native' && !!overrideModel;
  const displayProvider = overrideProvider || defaultProvider;
  const nativeDisplayLabel = overrideAdaptive ? '自动' : getRuntimeModelLabel(displayModel, displayProvider, modelSettings);
  const selectedNativeOption = useMemo(
    () => modelOptions.find((option) => option.provider === displayProvider && option.model === displayModel),
    [displayModel, displayProvider, modelOptions],
  );
  const selectedCatalogModel = selectedEngineCatalog?.models.find((model) => model.id === engine.model);
  const externalModelUnavailable = Boolean(
    isExternalEngineKind(engine.kind) &&
    selectedEngineCatalog &&
    engine.model &&
    (!selectedCatalogModel || selectedCatalogModel.disabledReason),
  );
  const externalDisplayLabel = externalModelUnavailable
    ? '已不可用'
    : selectedCatalogModel?.label
      ?? selectedEngineCatalog?.models.find((model) => model.id === selectedEngineCatalog.defaultModel)?.label
      ?? engine.model
      ?? selectedEngineCatalog?.defaultModel
      ?? '默认模型';
  const displayLabel = engine.kind === 'native'
    ? showModelSettingsPrompt ? '配置模型' : nativeDisplayLabel
    : externalDisplayLabel;

  const effortOptions = useMemo(
    () => engine.kind === 'native'
      ? getProviderEffortOptions(displayProvider, displayModel, selectedNativeOption?.features)
      : getEngineEffortOptions(engine.kind),
    [displayModel, displayProvider, engine.kind, selectedNativeOption?.features],
  );
  const selectedEffort = getSelectedEffortOption(effortLevel, effortOptions);
  const supportsThinkingControls = !showModelSettingsPrompt && engine.kind === 'native'
    ? displayProvider === 'xiaomi'
      || Boolean(selectedNativeOption?.features.includes('reasoning'))
      || /reason|thinking|think|mimo|r1|o\d/i.test(displayModel)
    : false;
  const thinkingShortLabel = supportsThinkingControls
    ? thinkingEnabled ? 'Think' : 'NoThink'
    : null;

  useEffect(() => {
    if (effortOptions.some((option) => option.value === effortLevel)) return;
    setEffortLevel(selectedEffort.value);
  }, [effortLevel, effortOptions, selectedEffort.value, setEffortLevel]);

  const menu = open && menuPos && (
    <div
      ref={menuRef}
      className="
        w-[22rem] py-1
        bg-zinc-800 border border-zinc-700 rounded-lg
        shadow-xl
      "
      style={{
        position: 'fixed',
        left: menuPos.left,
        bottom: menuPos.bottom,
        zIndex: 9999,
      }}
    >
          {/* Engine adapter 行 — 三层选择的第一层 */}
          {engineDescriptors.length > 0 && (
            <div className="px-2 pt-1.5 pb-1 border-b border-zinc-700/50">
              <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
                <span className="text-[9px] text-zinc-600">1</span>
                <Cpu className="w-3 h-3" />
                <span>Engine</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {engineDescriptors.map((descriptor) => {
                  const selected = descriptor.kind === engine.kind;
                  const needsWorkspace = descriptor.kind !== 'native' && !effectiveWorkingDirectory;
                  const unavailableReason = getEngineUnavailableReason(descriptor, needsWorkspace);
                  const disabled =
                    Boolean(unavailableReason);
                  const shortLabel = ENGINE_SHORT_LABEL[descriptor.kind] ?? descriptor.label;
                  return (
                    <button
                      key={descriptor.kind}
                      type="button"
                      disabled={disabled}
                      onClick={() => void selectEngine(descriptor)}
                      title={formatEngineTooltip(descriptor, needsWorkspace)}
                      className={`
                        inline-flex items-center justify-center gap-1 px-1.5 py-1 text-[10px] rounded transition-colors
                        ${selected
                          ? 'text-emerald-300 bg-zinc-700 font-medium'
                          : disabled
                            ? 'text-zinc-600 cursor-not-allowed'
                            : 'text-zinc-400 hover:bg-zinc-700/50'}
                      `}
                    >
                      {ENGINE_ICON[descriptor.kind]}
                      <span>{shortLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-b border-zinc-700/50">
            <div className="flex items-center gap-1 px-3 pt-1.5 pb-1 text-[10px] text-zinc-500">
              <span className="text-[9px] text-zinc-600">2</span>
              <Code2 className="w-3 h-3" />
              <span>Model</span>
            </div>
            <div className="px-2 pb-1.5">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleMenuKeyDown}
                placeholder="搜索模型..."
                data-model-search-input
                className="
                  w-full px-2 py-1 text-xs
                  bg-zinc-900 border border-zinc-700 rounded
                  text-gray-200 placeholder-gray-500
                  outline-none focus:border-zinc-600
                "
              />
            </div>
            <div className="max-h-64 overflow-y-auto pb-1">
              {engine.kind === 'native' ? (
                showModelSettingsPrompt ? (
                  <div className="px-3 py-4 text-center">
                    <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded bg-zinc-700/60 text-zinc-300">
                      <Settings className="h-4 w-4" />
                    </div>
                    <div className="text-xs font-medium text-zinc-200">还没有可用模型</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                      配好 Provider 和 API Key 后再发送消息。
                    </div>
                    <button
                      type="button"
                      onClick={handleOpenModelSettings}
                      className="mt-3 inline-flex h-7 items-center justify-center rounded bg-zinc-700 px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-600"
                    >
                      去模型配置
                    </button>
                  </div>
                ) : (
                  <>
                  <button
                    type="button"
                    onClick={handleSelectAuto}
                    data-model-option-index={0}
                    className={`
                      w-full text-left px-3 py-1.5 text-xs
                      border-b border-zinc-700/50
                      hover:bg-zinc-700 transition-colors
                      ${activeOptionIndex === 0 ? 'bg-zinc-700/80' : ''}
                      ${overrideAdaptive ? 'text-primary-300' : 'text-gray-200'}
                    `}
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-primary-400" />
                      <span className="font-medium">自动</span>
                      <span className="text-gray-500 text-[10px] ml-auto">按任务复杂度切换</span>
                    </div>
                  </button>
                  {filteredOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500 text-center">
                      无匹配模型
                    </div>
                  ) : (
                    groupedFilteredOptions.map((group) => (
                      <div key={group.provider}>
                        <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
                          <ProviderLogo
                            provider={group.provider}
                            label={group.providerLabel || getProviderDisplayName(group.provider) || group.provider}
                          />
                          <span>{group.providerLabel || getProviderDisplayName(group.provider) || group.provider}</span>
                          {group.providerSourceLabel && (
                            <span
                              className="ml-auto normal-case tracking-normal text-[10px] font-medium text-zinc-500"
                              title={`来源: ${group.providerSourceLabel}`}
                            >
                              来源 {group.providerSourceLabel}
                            </span>
                          )}
                        </div>
                        {group.options.map(({ option: opt, index }) => {
                          const selected = displayModel === opt.model && displayProvider === opt.provider;
                          return (
                            <button
                              key={`${opt.provider}/${opt.model}`}
                              type="button"
                              onClick={() => handleSelect(opt)}
                              data-model-option-index={index}
                              className={`
                                w-full text-left px-3 py-1.5 text-xs
                                hover:bg-zinc-700 transition-colors
                                ${activeOptionIndex === index ? 'bg-zinc-700/80' : ''}
                                ${selected ? 'text-purple-400' : 'text-gray-300'}
                              `}
                            >
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="font-medium">{opt.label}</span>
                                {opt.features.map((cap) => {
                                  const cfg = CAPABILITY_CONFIG[cap];
                                  if (!cfg) return null;
                                  return (
                                    <span
                                      key={cap}
                                      className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded ${cfg.color}`}
                                      title={cap}
                                    >
                                      {cfg.icon}
                                    </span>
                                  );
                                })}
                              </div>
                              <span className="text-gray-500 text-[10px] inline-flex items-center gap-1">
                                {healthMap[opt.provider] && (
                                  <span
                                    className={`inline-block w-1.5 h-1.5 rounded-full ${HEALTH_DOT_COLOR[healthMap[opt.provider].status] ?? 'bg-gray-400'}`}
                                    title={`${healthMap[opt.provider].status} | P50: ${healthMap[opt.provider].latencyP50}ms | Error: ${(healthMap[opt.provider].errorRate * 100).toFixed(0)}%`}
                                  />
                                )}
                                {opt.model}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                  </>
                )
              ) : !selectedEngineCatalog ? (
                <div className="px-3 py-3 text-xs text-gray-500 text-center">
                  模型目录暂不可用
                </div>
              ) : filteredEngineModels.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-500 text-center">
                  无匹配模型
                </div>
              ) : (
                filteredEngineModels.map((model, index) => {
                  const needsWorkspace = engine.kind !== 'native' && !effectiveWorkingDirectory;
                  const unavailableReason = selectedEngineDescriptor
                    ? getEngineUnavailableReason(selectedEngineDescriptor, needsWorkspace)
                    : null;
                  const disabled = Boolean(model.disabledReason || unavailableReason);
                  const selected = engine.model === model.id
                    || (!engine.model && model.id === selectedEngineCatalog.defaultModel);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => void handleSelectEngineModel(model)}
                      data-model-option-index={index}
                      title={model.disabledReason || unavailableReason || model.id}
                      className={`
                        w-full text-left px-3 py-1.5 text-xs transition-colors
                        ${activeOptionIndex === index ? 'bg-zinc-700/80' : ''}
                        ${selected ? 'text-purple-400' : disabled ? 'text-zinc-600 cursor-not-allowed' : 'text-gray-300 hover:bg-zinc-700'}
                      `}
                    >
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-medium">{model.label}</span>
                        {model.disabledReason ? (
                          <span className="rounded bg-zinc-700/70 px-1 py-0.5 text-[10px] text-zinc-400">不可用</span>
                        ) : null}
                        {model.capabilities.map((cap) => {
                          const cfg = CAPABILITY_CONFIG[cap];
                          if (!cfg) return null;
                          return (
                            <span
                              key={cap}
                              className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded ${cfg.color}`}
                              title={cap}
                            >
                              {cfg.icon}
                            </span>
                          );
                        })}
                      </div>
                      <span className="text-gray-500 text-[10px]">
                        {model.id}
                        {model.disabledReason ? ` · ${model.disabledReason}` : ''}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {!showModelSettingsPrompt && supportsThinkingControls && (
            <div className="px-2 pt-1.5 pb-1.5 border-b border-zinc-700/50">
              <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
                <span className="text-[9px] text-zinc-600">3</span>
                <Brain className="w-3 h-3" />
                <span>Thinking</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setThinkingEnabled(option.value)}
                    className={`
                      inline-flex h-7 items-center justify-center rounded px-2 text-[10px] transition-colors
                      ${thinkingEnabled === option.value
                        ? 'text-amber-300 bg-amber-500/15 font-medium ring-1 ring-zinc-600/70'
                        : 'text-zinc-500 hover:bg-zinc-700/50'}
                    `}
                    title={`Thinking: ${option.label}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!showModelSettingsPrompt && (
          <div className="px-2 pt-1.5 pb-1.5 border-b border-zinc-700/50">
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
              <span className="text-[9px] text-zinc-600">{supportsThinkingControls ? '4' : '3'}</span>
              <Zap className="w-3 h-3" />
              <span>Effort</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {effortOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setEffortLevel(opt.value)}
                  className={`
                    inline-flex h-7 min-w-[3.8rem] items-center justify-center rounded px-2 text-[10px] transition-colors
                    ${selectedEffort.value === opt.value
                      ? `${opt.color} ${opt.tint} font-medium ring-1 ring-zinc-600/70`
                      : 'text-zinc-500 hover:bg-zinc-700/50'}
                  `}
                  title={`Effort: ${opt.label}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          )}
      {engine.kind === 'native' && isOverridden && !showModelSettingsPrompt && (
        <>
          <div className="border-t border-zinc-700 my-1" />
          <button
            type="button"
            onClick={handleClear}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-zinc-700"
          >
            恢复默认模型
          </button>
        </>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="切换模型"
        aria-expanded={open}
        className={`
          font-medium cursor-pointer truncate max-w-[260px]
          hover:text-white transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-zinc-100'}
        `}
        title={
          engine.kind !== 'native'
            ? `Engine: ${ENGINE_SHORT_LABEL[engine.kind]} · Model: ${engine.model ?? selectedEngineCatalog?.defaultModel ?? '默认模型'}`
            : showModelSettingsPrompt
              ? '还没有可用模型'
            : overrideAdaptive
            ? `自动路由（按任务复杂度切换，当前默认 ${currentModel}）`
            : isOverridden
              ? `已覆盖: ${displayProvider}/${overrideModel} (原: ${currentModel}) · Engine: ${ENGINE_SHORT_LABEL[engine.kind]}`
              : `当前: ${currentModel} · Engine: ${ENGINE_SHORT_LABEL[engine.kind]}`
        }
      >
        <span className="text-zinc-400">{ENGINE_SHORT_LABEL[engine.kind] ?? 'Neo'}</span>
        <span className="text-zinc-500 mx-1">·</span>
        {displayLabel}
        {!showModelSettingsPrompt && (
          <>
            <span className="text-zinc-500 ml-1">·</span>
            {thinkingShortLabel && (
              <>
                <span className="text-zinc-400 ml-0.5">{thinkingShortLabel}</span>
                <span className="text-zinc-500 ml-1">·</span>
              </>
            )}
            <span className="text-zinc-400 ml-0.5">{selectedEffort.shortLabel}</span>
          </>
        )}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
