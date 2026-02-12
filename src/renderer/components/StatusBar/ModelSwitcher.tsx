// ============================================================================
// ModelSwitcher - 运行时模型切换下拉框
// ============================================================================
// 嵌入 StatusBar，支持对话中途切换模型

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';

interface ModelOption {
  provider: string;
  model: string;
  label: string;
}

// 常用模型列表
const MODEL_OPTIONS: ModelOption[] = [
  { provider: 'moonshot', model: 'kimi-k2.5', label: 'Kimi K2.5' },
  { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3' },
  { provider: 'zhipu', model: 'glm-5', label: 'GLM-5' },
  { provider: 'zhipu', model: 'glm-4.7', label: 'GLM-4.7' },
  { provider: 'zhipu', model: 'glm-4.7-flash', label: 'GLM-4.7 Flash' },
  { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' },
  { provider: 'claude', model: 'claude-sonnet-4-20250514', label: 'Sonnet 4' },
];

interface ModelSwitcherProps {
  currentModel: string;
}

export function ModelSwitcher({ currentModel }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const sessionId = useSessionStore((s) => s.currentSessionId);

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
      .catch(() => {});
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
      } catch {
        // 静默处理
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
    } catch {
      // 静默处理
    }
    setOpen(false);
  }, [sessionId]);

  const displayModel = overrideModel || currentModel;
  const isOverridden = !!overrideModel;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`
          font-medium cursor-pointer
          hover:text-purple-300 transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-purple-400'}
        `}
        title={
          isOverridden
            ? `已覆盖: ${overrideModel} (原: ${currentModel})`
            : `当前: ${currentModel}`
        }
      >
        {displayModel.slice(0, 12)}
        {isOverridden && <span className="text-[9px] ml-0.5">*</span>}
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div
          className="
            absolute bottom-full left-0 mb-1
            w-48 py-1
            bg-zinc-800 border border-zinc-700 rounded-lg
            shadow-xl z-50
          "
        >
          <div className="px-2 py-1 text-[10px] text-gray-500 uppercase tracking-wider">
            切换模型
          </div>
          {MODEL_OPTIONS.map((opt) => (
            <button
              key={`${opt.provider}/${opt.model}`}
              onClick={() => handleSelect(opt)}
              className={`
                w-full text-left px-3 py-1.5 text-xs
                hover:bg-zinc-700/50 transition-colors
                ${displayModel === opt.model ? 'text-purple-400' : 'text-gray-300'}
              `}
            >
              <span className="font-medium">{opt.label}</span>
              <span className="text-gray-500 ml-1 text-[10px]">
                {opt.provider}
              </span>
            </button>
          ))}
          {isOverridden && (
            <>
              <div className="border-t border-zinc-700 my-1" />
              <button
                onClick={handleClear}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-zinc-700/50"
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
