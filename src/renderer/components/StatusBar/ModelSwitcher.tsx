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
  AgentEngineKind,
  AgentEngineModelCatalog,
  AgentEngineModelCatalogResult,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import type { EffortLevel } from '@shared/contract/agent';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { getProviderDisplayName, isAgenticVerifiedModel } from '@shared/constants';
import {
  buildRuntimeModelOptions,
  groupRuntimeModelOptionsByProvider,
  getRuntimeModelLabel,
  hasConfiguredRuntimeModels,
  type RuntimeModelOption,
} from '@shared/modelRuntime';
import {
  PRICING_BASELINE_DEFAULT,
  computeCoef,
  formatCoefLabel,
  resolveModelPrice,
} from '@shared/pricing/resolveModelPrice';
import { toast } from '../../hooks/useToast';
import { BadgeCheck, Brain, Sparkles, Code2, Settings, Star } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../stores/appStore';
import { useModeStore } from '../../stores/modeStore';
import { trackRenderer } from '../../observability/posthogRenderer';
import { POSTHOG_EVENTS } from '@shared/observability/posthog-events';
import { Z_LAYERS } from '../../styles/zLayers';
import {
  buildProviderBillingSummary,
  buildProviderHealthSummary,
  buildProviderMetaTitle,
  CAPABILITY_CONFIG,
  ENGINE_SHORT_LABEL,
  formatExternalModelSwitcherTooltip,
  formatNativeModelSwitcherTooltip,
  getEngineEffortOptions,
  getProviderEffortOptions,
  getSelectedEffortOption,
  type ProviderHealthSnapshot,
  ProviderLogo,
  QUICK_SWITCH_PROVIDERS,
  sortProviderGroupsByModelStrategy,
  buildModelSwitcherEngineSelection,
} from './modelSwitcherHelpers';
import {
  EngineScopedModelPanel,
  type EngineMenuView,
} from './EngineScopedModelPanel';

export { buildModelSwitcherEngineSelection } from './modelSwitcherHelpers';

interface ModelSwitcherProps {
  currentModel: string;
}

export const MODEL_OVERRIDE_CHANGE_EVENT = 'code-agent:model-override-change';

/** 会话内（如 AgentErrorCard「切换模型」按钮）请求打开模型选择器的事件。 */
export const OPEN_MODEL_SWITCHER_EVENT = 'code-agent:open-model-switcher';

// 相对倍率价签（设计稿 §8.1）：基准恒定，逐 option 纯函数求值即可，无需状态。
const PRICE_BASELINE = resolveModelPrice(PRICING_BASELINE_DEFAULT.provider, PRICING_BASELINE_DEFAULT.modelId);

export function getModelPriceBadge(provider: string, model: string): { label: string; known: boolean } {
  const price = resolveModelPrice(provider, model);
  const label = formatCoefLabel(computeCoef(price, PRICE_BASELINE));
  return label ? { label, known: true } : { label: '—', known: false };
}

export interface ModelOverrideChangeDetail {
  sessionId: string;
  override: {
    provider: ModelProvider;
    model: string;
    adaptive?: boolean;
  } | null;
}

export interface ModelSwitcherMenuPosition {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

const MODEL_SWITCHER_MENU_WIDTH = 352;
const MODEL_SWITCHER_MENU_ESTIMATED_HEIGHT = 520;
const MODEL_SWITCHER_VIEWPORT_MARGIN = 12;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeModelSwitcherMenuPosition(args: {
  triggerRect: Pick<DOMRect, 'left' | 'top'>;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  margin?: number;
}): ModelSwitcherMenuPosition {
  const margin = args.margin ?? MODEL_SWITCHER_VIEWPORT_MARGIN;
  const maxWidth = Math.max(1, args.viewportWidth - margin * 2);
  const width = Math.min(args.menuWidth ?? MODEL_SWITCHER_MENU_WIDTH, maxWidth);
  const maxHeight = Math.max(1, args.viewportHeight - margin * 2);
  const effectiveHeight = Math.min(args.menuHeight ?? MODEL_SWITCHER_MENU_ESTIMATED_HEIGHT, maxHeight);
  const maxLeft = Math.max(margin, args.viewportWidth - width - margin);
  const preferredBottom = args.viewportHeight - args.triggerRect.top + 4;
  const maxBottom = Math.max(margin, args.viewportHeight - effectiveHeight - margin);

  return {
    left: clampNumber(args.triggerRect.left, margin, maxLeft),
    bottom: clampNumber(preferredBottom, margin, maxBottom),
    width,
    maxHeight,
  };
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

export function shouldShowNativeReasoningSegment(args: {
  engineKind: AgentEngineKind;
  showModelSettingsPrompt: boolean;
  effortOptionCount: number;
}): boolean {
  return args.engineKind === 'native'
    && !args.showModelSettingsPrompt
    && args.effortOptionCount > 1;
}

export function shouldDismissModelSwitcher(
  target: Node,
  trigger: Pick<Node, 'contains'> | null,
  menu: Pick<Node, 'contains'> | null,
): boolean {
  return !trigger?.contains(target) && !menu?.contains(target);
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
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealthSnapshot>>({});
  const [modelSettings, setModelSettings] = useState<AppSettings | null>(null);
  // modelSettings IPC 是否已返回（用于打开面板时的锚定时机）
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { t } = useI18n();
  const modelText = t.settings.model.models;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 内层模型列表滚动容器（max-h-64 overflow-y-auto），锚定滚动只动它，避免误滚外层页面
  const listScrollRef = useRef<HTMLDivElement>(null);
  // 打开面板后是否还需要执行一次"锚定到选中模型"（搜索过滤不重复锚定）
  const anchorPendingRef = useRef(false);
  const [menuPos, setMenuPos] = useState<ModelSwitcherMenuPosition | null>(null);
  const [engineMenuView, setEngineMenuView] = useState<EngineMenuView>('models');
  const [engineSources, setEngineSources] = useState<AgentEngineSourceDescriptor[]>([]);
  const [engineCatalog, setEngineCatalog] = useState<AgentEngineModelCatalog | null>(null);
  const [busyEngineId, setBusyEngineId] = useState<string | null>(null);
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
  // 状态栏仍展示当前执行引擎；弹窗本身只负责 Neo provider 模型，不再承载外部引擎模型配置。
  const engine = normalizeAgentEngineSession(session?.engine);
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
    const groupProviderHealth = (group: ReturnType<typeof groupRuntimeModelOptionsByProvider>[number]) => {
      const provider = group.options[0]?.provider ?? group.provider;
      return healthMap[provider];
    };
    return sortProviderGroupsByModelStrategy(
      groupRuntimeModelOptionsByProvider(filteredOptions),
      healthMap,
    ).map((group) => ({
      ...group,
      billingSummary: buildProviderBillingSummary(group.providerBillingMode),
      healthSummary: buildProviderHealthSummary(groupProviderHealth(group)),
      options: group.options.map((option) => ({
        option,
        index: nextIndex++,
      })),
    }));
  }, [filteredOptions, healthMap]);

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

  // 会话内入口（AgentErrorCard「切换模型」）请求打开菜单
  useEffect(() => {
    const handleOpenRequest = () => setOpen(true);
    window.addEventListener(OPEN_MODEL_SWITCHER_EVENT, handleOpenRequest);
    return () => window.removeEventListener(OPEN_MODEL_SWITCHER_EVENT, handleOpenRequest);
  }, []);

  // 打开时读取模型设置，保证输入框模型列表和 Settings 的启用状态一致
  useEffect(() => {
    if (!open) {
      setSettingsLoaded(false);
      return;
    }
    const api = window.domainAPI;
    if (!api) {
      setSettingsLoaded(true);
      return;
    }
    api.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {})
      .then((res) => {
        if (res?.success && res.data) {
          setModelSettings(res.data);
        }
      })
      .catch(() => { /* 设置读取失败时保留内置模型列表兜底 */ })
      .finally(() => setSettingsLoaded(true));
  }, [open]);

  // 引擎来源与模型能力均由 host 探测/目录返回；renderer 不硬编码营销状态或模型。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      window.domainAPI?.invoke<AgentEngineSourceDescriptor[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listSources',
        {},
      ),
      window.domainAPI?.invoke<AgentEngineModelCatalogResult>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listModels',
        {},
      ),
    ]).then(([sourceResult, catalogResult]) => {
      if (cancelled) return;
      if (sourceResult?.success && Array.isArray(sourceResult.data)) {
        setEngineSources(sourceResult.data);
      }
      if (catalogResult?.success && catalogResult.data?.catalog) {
        setEngineCatalog(catalogResult.data.catalog);
      }
    }).catch(() => {
      // 探测失败时保留当前会话触发器；不伪造来源或模型。
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    setEngineMenuView('models');
    setSearchQuery('');
  }, [engine.kind]);

  // 打开时拉取 provider 健康状态
  useEffect(() => {
    if (open) {
      window.domainAPI?.invoke<Record<string, ProviderHealthSnapshot>>(
        IPC_DOMAINS.PROVIDER,
        'getHealthStatus',
        {}
      )
        .then((res) => { if (res?.success && res.data) setHealthMap(res.data); })
        .catch(() => { /* 静默失败，健康点不显示即可 */ });
    }
  }, [open]);

  // 点击外部关闭（portal 让菜单脱离 ref，需要同时检查 triggerRef + menuRef）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (shouldDismissModelSwitcher(target, triggerRef.current, menuRef.current)) {
        setOpen(false);
      }
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
      setMenuPos(computeModelSwitcherMenuPosition({
        triggerRect: rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        menuHeight: menuRef.current?.offsetHeight,
      }));
    };
    updatePos();
    const frame = window.requestAnimationFrame(updatePos);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.cancelAnimationFrame(frame);
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

  const selectableOptionCount = showModelSettingsPrompt ? 0 : 1 + filteredOptions.length;

  useEffect(() => {
    if (!open) return;
    setActiveOptionIndex(0);
  }, [open, searchQuery]);

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
    // 输入法合成期（中文/日文等选候选词）的回车/方向键交给输入法，不当弹窗快捷键，
    // 否则按回车选词会被误当"选中模型+关弹窗"。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
      if (activeOptionIndex === 0) {
        void handleSelectAuto();
        return;
      }
      const option = filteredOptions[activeOptionIndex - 1];
      if (option) void handleSelect(option);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, [
    activeOptionIndex,
    filteredOptions,
    handleSelect,
    handleSelectAuto,
    selectableOptionCount,
  ]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = engine.kind === 'native' && !!overrideModel;
  const displayProvider = overrideProvider || defaultProvider;

  // 打开面板时锚定到当前选中模型：等 modelSettings IPC 返回、列表二次渲染后执行一次。
  // 用 anchorPendingRef 保证每次打开只锚一次，搜索过滤（groupedFilteredOptions 变化）不重复锚定。
  useEffect(() => {
    if (!open) return;
    if (!settingsLoaded) {
      anchorPendingRef.current = true;
      return;
    }
    if (!anchorPendingRef.current) return;
    anchorPendingRef.current = false;
    if (showModelSettingsPrompt) return;
    let selectedIndex = 0;
    for (const group of groupedFilteredOptions) {
      const hit = group.options.find(
        ({ option }) => option.model === displayModel && option.provider === displayProvider,
      );
      if (hit) {
        selectedIndex = hit.index;
        break;
      }
    }
    // 键盘导航从当前选中项开始；无选中项时保持 0（「自动」）
    setActiveOptionIndex(selectedIndex);
    if (selectedIndex <= 0) return;
    // 直接设置内层滚动容器的 scrollTop 让选中行居中可见，避免 scrollIntoView 误滚外层页面
    const container = listScrollRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-model-option-index="${selectedIndex}"]`);
    if (container && row) {
      container.scrollTop = row.offsetTop - (container.clientHeight - row.clientHeight) / 2;
    }
  }, [open, settingsLoaded, showModelSettingsPrompt, groupedFilteredOptions, displayModel, displayProvider]);

  const nativeDisplayLabel = overrideAdaptive ? '自动' : getRuntimeModelLabel(displayModel, displayProvider, modelSettings);
  const selectedNativeOption = useMemo(
    () => modelOptions.find((option) => option.provider === displayProvider && option.model === displayModel),
    [displayModel, displayProvider, modelOptions],
  );
  const displayLabel = engine.kind === 'native'
    ? showModelSettingsPrompt ? '配置模型' : nativeDisplayLabel
    : engine.model ?? '默认模型';

  const effortOptions = useMemo(
    () => engine.kind === 'native'
      ? getProviderEffortOptions(displayProvider, displayModel, selectedNativeOption?.features)
      : getEngineEffortOptions(engine.kind),
    [displayModel, displayProvider, engine.kind, selectedNativeOption?.features],
  );
  const selectedEffort = getSelectedEffortOption(effortLevel, effortOptions);
  // 思考段（2026-07-29 合并改版）：原 Thinking On/Off 与 Effort 两段行高不齐、
  // 选项数不一（2 vs 3），合并为一行 4 等分 segmented：关 = thinking off；
  // 低/中/高 = thinking on + effort low/med/high。setters 不变，只是 UI 合段。
  const thinkingSegmentOptions = useMemo(() => ([
    {
      value: 'off' as const,
      label: modelText.thinkingOptionOff,
      selected: !thinkingEnabled,
      color: 'text-zinc-300',
      tint: 'bg-zinc-700',
      onSelect: () => setThinkingEnabled(false),
    },
    ...(['low', 'medium', 'high'] as const).map((level) => {
      const effortOption = effortOptions.find((option) => option.value === level);
      return {
        value: level as EffortLevel,
        label: level === 'low'
          ? modelText.thinkingOptionLow
          : level === 'medium'
            ? modelText.thinkingOptionMedium
            : modelText.thinkingOptionHigh,
        selected: thinkingEnabled && effortLevel === level,
        color: effortOption?.color ?? 'text-zinc-300',
        tint: effortOption?.tint ?? 'bg-zinc-700',
        onSelect: () => {
          setThinkingEnabled(true);
          setEffortLevel(level);
        },
      };
    }),
  ]), [effortLevel, effortOptions, modelText, setEffortLevel, setThinkingEnabled, thinkingEnabled]);
  const supportsThinkingControls = !showModelSettingsPrompt && engine.kind === 'native'
    ? displayProvider === 'xiaomi'
      || Boolean(selectedNativeOption?.features.includes('reasoning'))
      || /reason|thinking|think|mimo|r1|o\d/i.test(displayModel)
    : false;
  const showNativeReasoningSegment = shouldShowNativeReasoningSegment({
    engineKind: engine.kind,
    showModelSettingsPrompt,
    effortOptionCount: effortOptions.length,
  });
  const thinkingShortLabel = supportsThinkingControls
    ? thinkingEnabled ? '思考' : '不思考'
    : null;
  const selectedNativeBillingSummary = engine.kind === 'native'
    ? buildProviderBillingSummary(selectedNativeOption?.providerBillingMode)
    : null;
  const selectedNativeHealthSummary = engine.kind === 'native'
    ? buildProviderHealthSummary(healthMap[displayProvider])
    : null;
  const triggerTitle = engine.kind !== 'native'
    ? formatExternalModelSwitcherTooltip({
      engineLabel: ENGINE_SHORT_LABEL[engine.kind],
      model: engine.model ?? '默认模型',
      effort: selectedEffort,
    })
    : showModelSettingsPrompt
      ? '还没有可用模型'
      : formatNativeModelSwitcherTooltip({
        engineLabel: ENGINE_SHORT_LABEL[engine.kind],
        currentModel,
        displayProvider,
        displayModel,
        adaptive: overrideAdaptive,
        overridden: isOverridden,
        billingSummary: selectedNativeBillingSummary,
        healthSummary: selectedNativeHealthSummary,
        effort: selectedEffort,
        thinkingLabel: thinkingShortLabel,
      });

  const handleTriggerClick = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const handleEngineMenuViewChange = useCallback((view: EngineMenuView) => {
    setEngineMenuView(view);
    setSearchQuery('');
  }, []);

  const handleSelectEngine = useCallback(async (source: AgentEngineSourceDescriptor) => {
    if (!sessionId || !source.kind || !source.selectable) return;
    const descriptorResponse = await window.domainAPI?.invoke(
      IPC_DOMAINS.AGENT_ENGINE,
      'get',
      { kind: source.kind },
    );
    if (!descriptorResponse?.success || !descriptorResponse.data) {
      toast.error(descriptorResponse?.error?.message || '执行引擎探测结果不可用');
      return;
    }
    setBusyEngineId(source.manifestId);
    try {
      const descriptor = descriptorResponse.data as Parameters<typeof buildModelSwitcherEngineSelection>[0];
      const workingDirectory = session?.workingDirectory ?? appWorkingDirectory ?? undefined;
      await updateSessionEngine(
        sessionId,
        buildModelSwitcherEngineSelection(
          descriptor,
          workingDirectory,
          source.kind === 'native'
            ? undefined
            : engineCatalog?.engines.find((item) => item.kind === source.kind)?.defaultModel,
        ),
      );
      setEngineMenuView('models');
      setSearchQuery('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '执行引擎切换失败');
    } finally {
      setBusyEngineId(null);
    }
  }, [
    appWorkingDirectory,
    engineCatalog?.engines,
    session?.workingDirectory,
    sessionId,
    updateSessionEngine,
  ]);

  const handleSelectExternalModel = useCallback(async (
    kind: ExternalAgentEngineKind,
    model: string,
  ) => {
    if (!sessionId) return;
    setBusyEngineId(kind);
    try {
      await updateSessionEngine(sessionId, {
        kind,
        model,
        permissionProfile: 'read_only',
        cwd: session?.workingDirectory ?? appWorkingDirectory ?? undefined,
      });
      setSearchQuery('');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '外部引擎模型切换失败');
    } finally {
      setBusyEngineId(null);
    }
  }, [appWorkingDirectory, session?.workingDirectory, sessionId, updateSessionEngine]);

  useEffect(() => {
    if (effortOptions.some((option) => option.value === effortLevel)) return;
    setEffortLevel(selectedEffort.value);
  }, [effortLevel, effortOptions, selectedEffort.value, setEffortLevel]);

  const menu = open && menuPos && (
    <div
      ref={menuRef}
      className="
        py-1 overflow-y-auto
        elevation-l2 popover-enter rounded-lg
      "
      style={{
        position: 'fixed',
        left: menuPos.left,
        bottom: menuPos.bottom,
        width: menuPos.width,
        maxHeight: menuPos.maxHeight,
        zIndex: Z_LAYERS.statusPopover,
      }}
    >
      {engineMenuView === 'engines' ? (
        <EngineScopedModelPanel
          view="engines"
          sources={engineSources}
          catalog={engineCatalog}
          currentEngine={engine.kind}
          currentModel={engine.model}
          query={searchQuery}
          busyEngineId={busyEngineId}
          onQueryChange={setSearchQuery}
          onViewChange={handleEngineMenuViewChange}
          onSelectEngine={(source) => void handleSelectEngine(source)}
          onSelectExternalModel={(kind, model) => void handleSelectExternalModel(kind, model)}
          onOpenSettings={openSettingsTab}
        />
      ) : (
        <>
          <EngineScopedModelPanel
            view="models"
            sources={engineSources}
            catalog={engineCatalog}
            currentEngine={engine.kind}
            currentModel={engine.model}
            query={searchQuery}
            busyEngineId={busyEngineId}
            onQueryChange={setSearchQuery}
            onViewChange={handleEngineMenuViewChange}
            onSelectEngine={(source) => void handleSelectEngine(source)}
            onSelectExternalModel={(kind, model) => void handleSelectExternalModel(kind, model)}
            onOpenSettings={openSettingsTab}
          />
          {engine.kind === 'native' && (
            <div className="border-b border-zinc-700/50">
              <div className="flex items-center gap-1 px-3 pt-1.5 pb-1 text-[10px] text-zinc-500">
              <Code2 className="w-3 h-3" />
              <span>主任务模型</span>
            </div>
            <div className="px-2 pb-1.5">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleMenuKeyDown}
                placeholder="搜索主任务模型…"
                data-model-search-input
                className="
                  w-full px-2 py-1 text-xs
                  bg-zinc-900 border border-zinc-700 rounded
                  text-gray-200 placeholder-gray-500
                  outline-none focus:border-zinc-600
                "
              />
            </div>
            <div ref={listScrollRef} className="max-h-64 overflow-y-auto pb-1">
              {showModelSettingsPrompt ? (
                  <div className="px-3 py-4 text-center">
                    <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded bg-zinc-700/60 text-zinc-300">
                      <Settings className="h-4 w-4" />
                    </div>
                    <div className="text-xs font-medium text-zinc-200">还没有可用模型</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                      配好 Provider 和 API Key 后再选择主任务模型。
                    </div>
                    <button
                      type="button"
                      onClick={handleOpenModelSettings}
                      className="mt-3 inline-flex h-7 items-center justify-center rounded bg-zinc-700 px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-600"
                    >
                      去模型设置
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
                      <span className="text-gray-500 text-[10px] ml-auto">按任务、成本和能力切换</span>
                    </div>
                  </button>
                  {filteredOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500 text-center">
                      无匹配模型
                    </div>
                  ) : (
                    groupedFilteredOptions.map((group) => {
                      // C-7: 检测/计费/来源/协议/endpoint 收进 hover 详情，头部只留一个健康色点。
                      const providerMetaTitle = buildProviderMetaTitle(group);
                      return (
                      <div key={group.provider}>
                        <div
                          className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500"
                          title={providerMetaTitle}
                        >
                          <ProviderLogo
                            provider={group.provider}
                            label={group.providerLabel || getProviderDisplayName(group.provider) || group.provider}
                            icon={group.providerIcon}
                          />
                          <span>{group.providerLabel || getProviderDisplayName(group.provider) || group.provider}</span>
                          {group.providerFavorite && (
                            <Star className="h-3 w-3 fill-amber-300 text-amber-300" />
                          )}
                          <span
                            className={`ml-auto h-1.5 w-1.5 rounded-full ${group.healthSummary.dotClass}`}
                            aria-label={`Provider 状态: ${group.healthSummary.label}`}
                          />
                        </div>
                        {group.options.map(({ option: opt, index }) => {
                          const selected = displayModel === opt.model && displayProvider === opt.provider;
                          const rowHealthSummary = healthMap[opt.provider]
                            ? buildProviderHealthSummary(healthMap[opt.provider])
                            : null;
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
                                {isAgenticVerifiedModel(opt.model) ? (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-badge-success"
                                    title={modelText.verifiedBadgeTitle}
                                  >
                                    <BadgeCheck className="h-3 w-3" />
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-300/90"
                                    title={modelText.unverifiedHint}
                                  >
                                    {modelText.unverifiedShort}
                                  </span>
                                )}
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
                                {(() => {
                                  const badge = getModelPriceBadge(opt.provider, opt.model);
                                  return (
                                    <span
                                      className={`ml-auto text-[10px] tabular-nums ${badge.known ? 'text-zinc-400' : 'text-zinc-600'}`}
                                      title={badge.known
                                        ? modelText.priceCoefTitle.replace('{baseline}', PRICING_BASELINE_DEFAULT.modelId)
                                        : modelText.priceUnknownTitle}
                                    >
                                      {badge.label}
                                    </span>
                                  );
                                })()}
                              </div>
                              <span className="text-gray-500 text-[10px] inline-flex items-center gap-1">
                                {rowHealthSummary && (
                                  <span
                                    className={`inline-block w-1.5 h-1.5 rounded-full ${rowHealthSummary.dotClass}`}
                                    title={`${rowHealthSummary.label} · ${rowHealthSummary.detail}`}
                                  />
                                )}
                                {opt.model}
                              </span>
                            </button>
                          );
                        })}
                      </div>
	                      );
	                    })
	                  )}
	                  </>
              )}
            </div>
          </div>
          )}

          {showNativeReasoningSegment && (
            <div className="px-2 pt-1.5 pb-1.5 border-b border-zinc-700/50">
              <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
                <Brain className="w-3 h-3" />
                <span>{modelText.thinkingSectionLabel}</span>
              </div>
              <div className="grid grid-cols-4 gap-1" data-native-reasoning-segment>
                {thinkingSegmentOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={option.onSelect}
                    className={`
                      inline-flex h-7 items-center justify-center rounded px-2 text-[10px] transition-colors
                      ${option.selected
                        ? `${option.color} ${option.tint} font-medium ring-1 ring-zinc-600/70`
                        : 'text-zinc-500 hover:bg-zinc-700/50'}
                    `}
                    title={`${modelText.thinkingSectionLabel}: ${option.label}`}
                  >
                    {option.label}
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
            恢复主任务模型
          </button>
        </>
      )}
        </>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        aria-label="切换模型"
        aria-expanded={open}
        // 弱一档（zinc-400/xs）：这行的主位是专家。「Neo」也从这里去掉——产品名跟模型名
        // 并排会让用户以为 Neo 是个模型；外部引擎名（Codex/Claude Code）是真信息，留着。
        // 思考档 / effort 收进点开后的面板：reasoning effort 对非程序员是纯噪音，
        // 「低」在外面既看不懂也改不出所以然（hover title 里仍带着，需要时能查）。
        className={`
          cursor-pointer truncate max-w-[200px] text-xs
          hover:text-white transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-zinc-400'}
        `}
        title={triggerTitle}
      >
        {engine.kind !== 'native' && (
          <>
            <span className="text-zinc-500">{ENGINE_SHORT_LABEL[engine.kind]}</span>
            <span className="text-zinc-600 mx-1">·</span>
          </>
        )}
        {displayLabel}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
