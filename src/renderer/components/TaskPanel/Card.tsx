// ============================================================================
// Card - TaskPanel 内部卡片外壳（与 TaskMonitor / Connectors 共用）
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CardProps {
  title: string;
  count?: string;
  highlight?: boolean;
  rightElement?: React.ReactNode;
  isEmpty?: boolean;
  emptyLabel?: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export function Card({
  title,
  count,
  highlight,
  rightElement,
  isEmpty,
  emptyLabel,
  defaultExpanded = true,
  children,
}: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

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
          onClick={() => setExpanded(!expanded)}
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
          onClick={() => setExpanded(!expanded)}
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

export function CardEmptyState({ text }: { text: string }) {
  return <div className="text-xs text-zinc-600 py-1">{text}</div>;
}
