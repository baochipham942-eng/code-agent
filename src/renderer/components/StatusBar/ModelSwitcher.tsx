// ============================================================================
// ModelSwitcher - 运行时模型切换下拉框
// ============================================================================
// 嵌入 StatusBar，支持对话中途切换模型

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  PROVIDER_MODELS_MAP,
  getProviderDisplayName,
  getModelDisplayLabel,
} from '@shared/constants';
import { toast } from '../../hooks/useToast';
import { Eye, Wrench, Brain } from 'lucide-react';

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
  'claude-opus-4-6': ['tool', 'vision', 'reasoning'],
  'claude-sonnet-4-6': ['tool', 'vision'],
  'claude-haiku-4-5-20251001': ['tool', 'vision'],
  'claude-sonnet-4-20250514': ['tool', 'vision'],
  'claude-3-5-sonnet-20241022': ['tool', 'vision'],
  'claude-3-5-haiku-20241022': ['tool', 'vision'],
  // volcengine
  'doubao-1.5-pro-256k': ['tool'],
  'doubao-1.5-thinking-pro': ['reasoning'],
  'doubao-seed-1.6-vision-250815': ['vision'],
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
  const [searchQuery, setSearchQuery] = useState('');
  const [healthMap, setHealthMap] = useState<Record<string, { status: string; latencyP50: number; errorRate: number }>>({});
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionId = useSessionStore((s) => s.currentSessionId);

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

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [open]);

  // 加载当前 override
  useEffect(() => {
    if (!sessionId) return;
    window.domainAPI
      ?.invoke<{ provider: string; model: string } | null>(
        IPC_DOMAINS.SESSION,
        'getModelOverride',
        { sessionId }
      )
      .then((res) => {
        if (res?.success && res.data) {
          setOverrideModel(res.data.model);
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
        });
        setOverrideModel(option.model);
      } catch (err) {
        toast.error('模型切换失败: ' + (err instanceof Error ? err.message : '未知错误') + '。请检查 API Key 或网络连接');
      }
      setOpen(false);
    },
    [sessionId]
  );

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.domainAPI?.invoke(
        IPC_DOMAINS.SESSION,
        'clearModelOverride',
        { sessionId }
      );
      setOverrideModel(null);
    } catch (err) {
      toast.error('清除模型覆盖失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
    setOpen(false);
  }, [sessionId]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = !!overrideModel;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="切换模型"
        aria-expanded={open}
        className={`
          font-medium cursor-pointer truncate max-w-[160px]
          hover:text-purple-300 transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-purple-400'}
        `}
        title={
          isOverridden
            ? `已覆盖: ${overrideModel} (原: ${currentModel})`
            : `当前: ${currentModel}`
        }
      >
        {getModelDisplayLabel(displayModel)}
        {isOverridden && <span className="text-[9px] ml-0.5">*</span>}
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div
          className="
            absolute bottom-full left-0 mb-1
            w-64 py-1
            bg-zinc-800 border border-zinc-700 rounded-lg
            shadow-xl z-50
          "
        >
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
      )}
    </div>
  );
}
