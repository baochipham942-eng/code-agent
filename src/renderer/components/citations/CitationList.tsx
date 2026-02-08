// ============================================================================
// CitationList - 可点击引用列表
// ============================================================================
// 展示从工具结果中提取的引用源（文件行号、URL、单元格等）

import React from 'react';
import type { Citation } from '@shared/types/citation';
import { IPC_CHANNELS } from '@shared/ipc';

interface CitationListProps {
  citations: Citation[];
  className?: string;
  onCitationClick?: (citation: Citation) => void;
}

export function CitationList({
  citations,
  className = '',
  onCitationClick,
}: CitationListProps) {
  if (citations.length === 0) return null;

  // 按类型分组
  const grouped = groupBy(citations, (c) => c.type);

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {citations.map((citation) => (
        <CitationChip
          key={citation.id}
          citation={citation}
          onClick={onCitationClick}
        />
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// CitationChip - 单个引用标签
// ----------------------------------------------------------------------------

interface CitationChipProps {
  citation: Citation;
  onClick?: (citation: Citation) => void;
}

const TYPE_STYLES: Record<string, { bg: string; text: string; icon: string }> = {
  file: { bg: 'bg-blue-500/10', text: 'text-blue-400', icon: '📄' },
  url: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', icon: '🔗' },
  cell: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', icon: '📊' },
  query: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: '🔍' },
  memory: { bg: 'bg-purple-500/10', text: 'text-purple-400', icon: '🧠' },
};

function CitationChip({ citation, onClick }: CitationChipProps) {
  const style = TYPE_STYLES[citation.type] || TYPE_STYLES.file;

  const handleClick = () => {
    if (onClick) {
      onClick(citation);
      return;
    }
    // 默认行为：文件类型尝试打开
    if (citation.type === 'file' && window.electronAPI?.invoke) {
      window.electronAPI.invoke(IPC_CHANNELS.SHELL_OPEN_PATH, citation.source);
    }
    // URL 类型在浏览器打开
    if (citation.type === 'url') {
      window.open(citation.source, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`
        inline-flex items-center gap-1 px-2 py-0.5 rounded
        ${style.bg} ${style.text}
        text-xs font-mono
        hover:opacity-80 transition-opacity
        max-w-48 truncate
      `}
      title={`${citation.source}${citation.location ? `:${citation.location}` : ''}`}
    >
      <span className="text-[10px]">{style.icon}</span>
      <span className="truncate">{citation.label}</span>
    </button>
  );
}

// ----------------------------------------------------------------------------
// CitationSummary - 紧凑引用摘要（用于消息气泡底部）
// ----------------------------------------------------------------------------

interface CitationSummaryProps {
  citations: Citation[];
  maxShow?: number;
  onViewAll?: () => void;
}

export function CitationSummary({
  citations,
  maxShow = 5,
  onViewAll,
}: CitationSummaryProps) {
  if (citations.length === 0) return null;

  const visible = citations.slice(0, maxShow);
  const remaining = citations.length - maxShow;

  return (
    <div className="flex items-center gap-1 mt-1.5">
      <span className="text-[10px] text-gray-500 mr-0.5">引用:</span>
      {visible.map((c) => (
        <CitationChip key={c.id} citation={c} />
      ))}
      {remaining > 0 && (
        <button
          onClick={onViewAll}
          className="text-[10px] text-gray-500 hover:text-gray-300 px-1"
        >
          +{remaining}
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}
