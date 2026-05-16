// ============================================================================
// ModelSwitcher - 运行时模型切换下拉框
// ============================================================================
// 嵌入 StatusBar，支持对话中途切换模型

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelProvider } from '@shared/contract';
import type { AgentEngineDescriptor, AgentEngineKind } from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { getProviderDisplayName } from '@shared/constants';
import {
  buildRuntimeModelOptions,
  getRuntimeModelLabel,
  type RuntimeModelOption,
} from '@shared/modelRuntime';
import { toast } from '../../hooks/useToast';
import { Eye, Wrench, Brain, Sparkles, Zap, Cpu, Terminal } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useModeStore } from '../../stores/modeStore';
import type { EffortLevel } from '../../../shared/contract/agent';

const QUICK_SWITCH_PROVIDERS = [
  'moonshot', 'deepseek', 'zhipu', 'openai', 'claude', 'volcengine', 'local', 'xiaomi', 'custom',
] as const satisfies readonly ModelProvider[];

// Engine 短标签（与 AgentEngineSelector 保持一致）
const ENGINE_SHORT_LABEL: Record<AgentEngineKind, string> = {
  native: 'Native',
  codex_cli: 'Codex',
  claude_code: 'Claude',
};

const ENGINE_ICON: Record<AgentEngineKind, React.ReactNode> = {
  native: <Cpu className="w-3 h-3" />,
  codex_cli: <Terminal className="w-3 h-3" />,
  claude_code: <Terminal className="w-3 h-3" />,
};

// MODEL_FEATURES 单一真理源已迁至 src/shared/constants/models.ts (2026-04-28 audit B3)

const CAPABILITY_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  vision: {
    icon: <Eye className="w-2.5 h-2.5" />,
    color: 'bg-purple-500/20 text-purple-300',
  },
  tool: {
    icon: <Wrench className="w-2.5 h-2.5" />,
    color: 'bg-blue-500/20 text-blue-300',
  },
  reasoning: {
    icon: <Brain className="w-2.5 h-2.5" />,
    color: 'bg-amber-500/20 text-amber-300',
  },
};

// 健康状态颜色映射
const HEALTH_DOT_COLOR: Record<string, string> = {
  healthy: 'bg-green-400',
  degraded: 'bg-yellow-400',
  unavailable: 'bg-red-400',
  recovering: 'bg-blue-400',
};

interface ModelSwitcherProps {
  currentModel: string;
}

export function ModelSwitcher({ currentModel }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const [overrideProvider, setOverrideProvider] = useState<ModelProvider | null>(null);
  const [overrideAdaptive, setOverrideAdaptive] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [healthMap, setHealthMap] = useState<Record<string, { status: string; latencyP50: number; errorRate: number }>>({});
  const [modelSettings, setModelSettings] = useState<AppSettings | null>(null);
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
  const appWorkingDirectory = useAppStore((s) => s.workingDirectory);
  const defaultProvider = useAppStore((s) => s.modelConfig.provider);
  // effort 切换内嵌到模型菜单顶部，对照 Codex 的"模型 + Intelligence"两层选择
  const effortLevel = useModeStore((s) => s.effortLevel);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);
  // Engine adapter（Native/Codex/Claude）— 从 AgentEngineSelector 合并进来，
  // 让"Engine · Model · Effort"在一个 trigger 里统一展示和切换。
  const engine = normalizeAgentEngineSession(session?.engine);
  const effectiveWorkingDirectory = session?.workingDirectory || appWorkingDirectory || null;
  const [engineDescriptors, setEngineDescriptors] = useState<AgentEngineDescriptor[]>([]);

  const modelOptions = useMemo(
    () => buildRuntimeModelOptions(modelSettings, QUICK_SWITCH_PROVIDERS),
    [modelSettings],
  );

  // 搜索过滤
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return modelOptions;
    const q = searchQuery.toLowerCase();
    return modelOptions.filter((opt) => {
      const providerName = (opt.providerLabel || getProviderDisplayName(opt.provider) || opt.provider).toLowerCase();
      return (
        opt.label.toLowerCase().includes(q) ||
        opt.model.toLowerCase().includes(q) ||
        providerName.includes(q)
      );
    });
  }, [modelOptions, searchQuery]);

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

  const selectEngine = useCallback(
    async (descriptor: AgentEngineDescriptor) => {
      if (!sessionId) return;
      if (descriptor.kind !== 'native' && !effectiveWorkingDirectory) {
        toast.error(`${descriptor.label} 需要先选择 workspace`);
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
      await updateSessionEngine(sessionId, {
        kind: descriptor.kind,
        permissionProfile: descriptor.defaultPermissionProfile,
        origin: 'manual',
      });
    },
    [effectiveWorkingDirectory, sessionId, updateSessionEngine]
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
        setOpen(false);
      } catch (err) {
        toast.error('模型切换失败: ' + (err instanceof Error ? err.message : '未知错误') + '。请检查 API Key 或网络连接');
      }
    },
    [sessionId]
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
      setOpen(false);
    } catch (err) {
      toast.error('清除模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }, [sessionId]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = !!overrideModel;
  const displayProvider = overrideProvider || defaultProvider;
  const displayLabel = overrideAdaptive ? '自动' : getRuntimeModelLabel(displayModel, displayProvider, modelSettings);

  const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string; color: string }> = [
    { value: 'low', label: 'Low', color: 'text-zinc-400' },
    { value: 'medium', label: 'Med', color: 'text-blue-400' },
    { value: 'high', label: 'High', color: 'text-amber-400' },
    { value: 'max', label: 'Max', color: 'text-pink-400' },
  ];
  const effortShort = EFFORT_OPTIONS.find((o) => o.value === effortLevel)?.label ?? 'High';

  const menu = open && menuPos && (
    <div
      ref={menuRef}
      className="
        w-64 py-1
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
          {/* Engine adapter 行 — 合并自原 AgentEngineSelector，与 Reasoning effort
              一起组成"Engine · Model · Effort"三层选择 */}
          {engineDescriptors.length > 0 && (
            <div className="px-2 pt-1.5 pb-1 border-b border-zinc-700/50">
              <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
                <Cpu className="w-3 h-3" />
                <span>Engine</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {engineDescriptors.map((descriptor) => {
                  const selected = descriptor.kind === engine.kind;
                  const needsWorkspace = descriptor.kind !== 'native' && !effectiveWorkingDirectory;
                  const disabled =
                    needsWorkspace
                    || !descriptor.executable
                    || descriptor.installState === 'missing'
                    || descriptor.runtimeState === 'error'
                    || descriptor.runtimeState === 'blocked';
                  const shortLabel = ENGINE_SHORT_LABEL[descriptor.kind] ?? descriptor.label;
                  return (
                    <button
                      key={descriptor.kind}
                      type="button"
                      disabled={disabled}
                      onClick={() => void selectEngine(descriptor)}
                      title={
                        needsWorkspace
                          ? `${descriptor.label}：需要先选择 workspace`
                          : descriptor.installState === 'missing'
                            ? `${descriptor.label}：未安装`
                            : descriptor.label
                      }
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

          {/* Reasoning effort 行（Codex 风格 Intelligence 子菜单的扁平化） */}
          <div className="px-2 pt-1.5 pb-1 border-b border-zinc-700/50">
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
              <Zap className="w-3 h-3" />
              <span>Reasoning effort</span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {EFFORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setEffortLevel(opt.value)}
                  className={`
                    px-1.5 py-1 text-[10px] rounded transition-colors
                    ${effortLevel === opt.value
                      ? `${opt.color} bg-zinc-700 font-medium`
                      : 'text-zinc-500 hover:bg-zinc-700/50'}
                  `}
                  title={`Reasoning effort: ${opt.value}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 搜索框 */}
          <div className="px-2 py-1.5">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索模型..."
              className="
                w-full px-2 py-1 text-xs
                bg-zinc-900 border border-zinc-700 rounded
                text-gray-200 placeholder-gray-500
                outline-none focus:border-purple-500
              "
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {/* 自动路由选项（固定顶部，不参与搜索过滤） */}
            {!searchQuery.trim() && (
              <button
                onClick={handleSelectAuto}
                className={`
                  w-full text-left px-3 py-1.5 text-xs
                  border-b border-zinc-700/50
                  hover:bg-zinc-700 transition-colors
                  ${overrideAdaptive ? 'text-primary-300' : 'text-gray-200'}
                `}
              >
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-primary-400" />
                  <span className="font-medium">自动</span>
                  <span className="text-gray-500 text-[10px] ml-auto">按任务复杂度切换</span>
                </div>
              </button>
            )}
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-500 text-center">
                无匹配模型
              </div>
            ) : (
              filteredOptions.map((opt) => (
                <button
                  key={`${opt.provider}/${opt.model}`}
                  onClick={() => handleSelect(opt)}
                  className={`
                    w-full text-left px-3 py-1.5 text-xs
                    hover:bg-zinc-700 transition-colors
                    ${displayModel === opt.model ? 'text-purple-400' : 'text-gray-300'}
                  `}
                >
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="font-medium">{opt.label}</span>
                    {/* 能力标签 */}
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
                    {opt.providerLabel || getProviderDisplayName(opt.provider) || opt.provider}
                  </span>
                </button>
              ))
            )}
          </div>
      {isOverridden && (
        <>
          <div className="border-t border-zinc-700 my-1" />
          <button
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
        onClick={() => setOpen(!open)}
        aria-label="切换模型"
        aria-expanded={open}
        className={`
          font-medium cursor-pointer truncate max-w-[200px]
          hover:text-white transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-zinc-100'}
        `}
        title={
          overrideAdaptive
            ? `自动路由（按任务复杂度切换，当前默认 ${currentModel}）`
            : isOverridden
              ? `已覆盖: ${displayProvider}/${overrideModel} (原: ${currentModel}) · Engine: ${ENGINE_SHORT_LABEL[engine.kind]}`
              : `当前: ${currentModel} · Engine: ${ENGINE_SHORT_LABEL[engine.kind]}`
        }
      >
        <span className="text-zinc-400">{ENGINE_SHORT_LABEL[engine.kind] ?? 'Native'}</span>
        <span className="text-zinc-500 mx-1">·</span>
        {displayLabel}
        <span className="text-zinc-500 ml-1">·</span>
        <span className="text-zinc-400 ml-0.5">{effortShort}</span>
        {isOverridden && <span className="text-[9px] ml-0.5">*</span>}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
