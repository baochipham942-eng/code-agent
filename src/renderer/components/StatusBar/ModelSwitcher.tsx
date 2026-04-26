// ============================================================================
// ModelSwitcher - 运行时模型切换下拉框
// ============================================================================
// 嵌入 StatusBar，支持对话中途切换模型

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  PROVIDER_MODELS_MAP,
  getProviderDisplayName,
  getModelDisplayLabel,
} from '@shared/constants';
import { toast } from '../../hooks/useToast';
import { Eye, Wrench, Brain, Sparkles, Zap } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useModeStore } from '../../stores/modeStore';
import type { EffortLevel } from '../../../shared/contract/agent';

interface ModelOption {
  provider: string;
  model: string;
  label: string;
}

const QUICK_SWITCH_PROVIDERS = [
  'moonshot', 'deepseek', 'zhipu', 'openai', 'claude', 'volcengine', 'local',
] as const;

const MODEL_OPTIONS: ModelOption[] = QUICK_SWITCH_PROVIDERS.flatMap((providerId) => {
  const providerModels = PROVIDER_MODELS_MAP[providerId];
  if (!providerModels) {
    return [];
  }

  return providerModels.models.map((model) => ({
    provider: providerId,
    model: model.id,
    label: getModelDisplayLabel(model.id),
  }));
});

// 模型能力标签（来源: providerRegistry.ts）
const MODEL_CAPABILITIES: Record<string, string[]> = {
  // moonshot
  'kimi-k2.5': ['tool', 'reasoning'],
  'moonshot-v1-8k': ['tool'],
  'moonshot-v1-32k': ['tool'],
  'moonshot-v1-128k': ['tool'],
  // deepseek
  'deepseek-chat': ['tool'],
  'deepseek-coder': ['tool'],
  'deepseek-reasoner': ['reasoning'],
  // zhipu
  'glm-5': ['tool', 'reasoning'],
  'glm-4.7': ['tool', 'reasoning'],
  'glm-4.6v': ['vision', 'reasoning'],
  'glm-4.7-flash': ['tool'],
  'glm-4.6v-flash': ['vision'],
  'codegeex-4': ['tool'],
  // openai
  'gpt-4o': ['tool', 'vision'],
  'gpt-4o-mini': ['tool', 'vision'],
  // claude
  'claude-opus-4-7': ['tool', 'vision', 'reasoning'],
  'claude-sonnet-4-6': ['tool', 'vision', 'reasoning'],
  'claude-haiku-4-5-20251001': ['tool', 'vision'],
  // moonshot 新增
  'kimi-k2.6': ['tool', 'vision', 'reasoning'],
  // 智谱 新增
  'glm-5.1': ['tool', 'reasoning'],
  'glm-4.7-flashx': ['tool'],
  // volcengine — 1.6 系列
  'doubao-seed-1-6': ['tool', 'vision'],
  'doubao-seed-1-6-thinking': ['reasoning', 'vision'],
  'doubao-seed-1-6-flash': ['tool'],
  'doubao-seed-1-6-lite': ['tool'],
  // local
  'qwen2.5-coder:7b': ['tool'],
  'qwen3:8b': ['tool'],
  'qwen3:32b': ['tool', 'reasoning'],
  'gemma4:12b': ['tool'],
  'gemma4:27b': ['tool', 'reasoning'],
  'deepseek-r1:7b': ['reasoning'],
  'deepseek-r1:32b': ['reasoning'],
  'llama4-scout:17b': ['tool', 'vision'],
  'codestral:22b': ['tool'],
};

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
  const [overrideAdaptive, setOverrideAdaptive] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [healthMap, setHealthMap] = useState<Record<string, { status: string; latencyP50: number; errorRate: number }>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const defaultProvider = useAppStore((s) => s.modelConfig.provider);
  // effort 切换内嵌到模型菜单顶部，对照 Codex 的"模型 + Intelligence"两层选择
  const effortLevel = useModeStore((s) => s.effortLevel);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);

  // 搜索过滤
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return MODEL_OPTIONS;
    const q = searchQuery.toLowerCase();
    return MODEL_OPTIONS.filter((opt) => {
      const providerName = (getProviderDisplayName(opt.provider) ?? opt.provider).toLowerCase();
      return (
        opt.label.toLowerCase().includes(q) ||
        opt.model.toLowerCase().includes(q) ||
        providerName.includes(q)
      );
    });
  }, [searchQuery]);

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
        if (res?.success && res.data) {
          setOverrideModel(res.data.model);
          setOverrideAdaptive(!!res.data.adaptive);
        }
      })
      .catch((err: unknown) => toast.error('加载模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误')));
  }, [sessionId]);

  const handleSelect = useCallback(
    async (option: ModelOption) => {
      if (!sessionId) return;
      try {
        await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
          sessionId,
          provider: option.provider,
          model: option.model,
          adaptive: false,
        });
        setOverrideModel(option.model);
        setOverrideAdaptive(false);
      } catch (err) {
        toast.error('模型切换失败: ' + (err instanceof Error ? err.message : '未知错误') + '。请检查 API Key 或网络连接');
      }
      setOpen(false);
    },
    [sessionId]
  );

  const handleSelectAuto = useCallback(async () => {
    if (!sessionId) return;
    try {
      // 自动模式：provider/model 传当前默认作占位，后端靠 adaptive=true 判断
      await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
        sessionId,
        provider: defaultProvider,
        model: currentModel,
        adaptive: true,
      });
      setOverrideModel(currentModel);
      setOverrideAdaptive(true);
    } catch (err) {
      toast.error('切换到自动模式失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
    setOpen(false);
  }, [sessionId, defaultProvider, currentModel]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.domainAPI?.invoke(
        IPC_DOMAINS.SESSION,
        'clearModelOverride',
        { sessionId }
      );
      setOverrideModel(null);
      setOverrideAdaptive(false);
    } catch (err) {
      toast.error('清除模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
    setOpen(false);
  }, [sessionId]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = !!overrideModel;
  const displayLabel = overrideAdaptive ? '自动' : getModelDisplayLabel(displayModel);

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
                    {(MODEL_CAPABILITIES[opt.model] ?? []).map((cap) => {
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
                    {getProviderDisplayName(opt.provider) ?? opt.provider}
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
              ? `已覆盖: ${overrideModel} (原: ${currentModel})`
              : `当前: ${currentModel}`
        }
      >
        {displayLabel}
        <span className="text-zinc-500 ml-1">·</span>
        <span className="text-zinc-400 ml-0.5">{effortShort}</span>
        {isOverridden && <span className="text-[9px] ml-0.5">*</span>}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
