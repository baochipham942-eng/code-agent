// ============================================================================
// Card - TaskPanel 内部卡片外壳（与 TaskMonitor / Connectors 共用）
// ============================================================================

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CardProps {
  title: string;
  count?: string;
  highlight?: boolean;
  rightElement?: React.ReactNode;
  isEmpty?: boolean;
  emptyLabel?: string;
  defaultExpanded?: boolean;
  storageKey?: string;
  children: React.ReactNode;
}

const CARD_EXPAND_STORAGE_PREFIX = 'taskpanel.card.expanded.';

function readStoredExpanded(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey || typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`${CARD_EXPAND_STORAGE_PREFIX}${storageKey}`);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // 本地存储不可用（无痕 / 配额）时直接回退到 default
  }
  return fallback;
}

function writeStoredExpanded(storageKey: string | undefined, value: boolean): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${CARD_EXPAND_STORAGE_PREFIX}${storageKey}`, value ? '1' : '0');
  } catch {
    // 写入失败静默忽略
  }
}

export function Card({
  title,
  count,
  highlight,
  rightElement,
  isEmpty,
  emptyLabel,
  defaultExpanded = true,
  storageKey,
  children,
}: CardProps) {
  const [expanded, setExpanded] = useState(() => readStoredExpanded(storageKey, defaultExpanded));

  // 没有 storageKey 时跟随 caller 控制（旧行为）；有 storageKey 时一旦用户主动操作就以 localStorage 为准
  useEffect(() => {
    if (storageKey) return;
    setExpanded(defaultExpanded);
  }, [defaultExpanded, storageKey]);

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      writeStoredExpanded(storageKey, next);
      return next;
    });
  };

  if (isEmpty) {
    return (
      <div className="bg-white/[0.02] rounded-lg border border-white/[0.04] px-3 py-2 flex items-center justify-between">
        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{title}</span>
        <span className="text-[10px] text-zinc-600">{emptyLabel || '0'}</span>
      </div>
    );
  }

  return (
    <div className={`bg-white/[0.02] backdrop-blur-sm rounded-lg border ${
      highlight ? 'border-yellow-500/20' : 'border-white/[0.04]'
    }`}>
      <div className="flex items-center w-full px-3 py-2 gap-1">
        <button
          onClick={toggle}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          type="button"
        >
          <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
            {title}
          </span>
          {count && (
            <span className="text-[10px] text-zinc-600">{count}</span>
          )}
        </button>
        {rightElement}
        <button
          onClick={toggle}
          className="flex items-center flex-shrink-0"
          type="button"
          aria-label={expanded ? '折叠' : '展开'}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2.5">
          {children}
        </div>
      )}
    </div>
  );
}
