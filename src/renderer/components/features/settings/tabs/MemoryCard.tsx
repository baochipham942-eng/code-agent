// ============================================================================
// MemoryCard - 单条记忆卡片组件
// ============================================================================

import React, { useState } from 'react';
import { Edit3, Trash2, ChevronDown, ChevronUp, Brain, User } from 'lucide-react';
import { Button } from '../../../primitives';
import type { MemoryItem, MemoryCategory } from '@shared/types';

interface MemoryCardProps {
  memory: MemoryItem;
  onEdit: (memory: MemoryItem) => void;
  onDelete: (id: string) => void;
  compact?: boolean;
}

// 分类配置
const CATEGORY_CONFIG: Record<MemoryCategory, { icon: string; color: string; bgColor: string }> = {
  about_me: { icon: '👤', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  preference: { icon: '⭐', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  frequent_info: { icon: '📋', color: 'text-green-400', bgColor: 'bg-green-500/10' },
  learned: { icon: '💡', color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
};

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return '昨天';
  } else if (diffDays < 7) {
    return `${diffDays} 天前`;
  } else {
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  onEdit,
  onDelete,
  compact = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const config = CATEGORY_CONFIG[memory.category] || CATEGORY_CONFIG.learned;
  const isLearned = memory.source === 'learned';
  const contentPreview = memory.content.length > 100 && !isExpanded
    ? memory.content.slice(0, 100) + '...'
    : memory.content;
  const hasMoreContent = memory.content.length > 100;

  const handleDelete = () => {
    if (showDeleteConfirm) {
      onDelete(memory.id);
      setShowDeleteConfirm(false);
    } else {
      setShowDeleteConfirm(true);
      // 3秒后自动取消确认状态
      setTimeout(() => setShowDeleteConfirm(false), 3000);
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors">
        <span className={`text-sm ${config.bgColor} rounded p-1`}>
          {config.icon}
        </span>
        <span className="flex-1 text-sm text-zinc-300 truncate">
          {memory.content}
        </span>
        <span className="text-xs text-zinc-500">
          {formatTime(memory.updatedAt)}
        </span>
      </div>
    );
  }

  return (
    <div className="group p-3 rounded-lg bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors border border-zinc-700/50">
      {/* Header */}
      <div className="flex items-start gap-2">
        {/* Category icon */}
        <span className={`text-lg ${config.bgColor} rounded p-1.5 shrink-0`}>
          {config.icon}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
            {contentPreview}
          </p>

          {/* Expand/Collapse button */}
          {hasMoreContent && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mt-1 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="w-3 h-3" />
                  收起
                </>
              ) : (
                <>
                  <ChevronDown className="w-3 h-3" />
                  展开更多
                </>
              )}
            </button>
          )}

          {/* Meta info */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {/* Source badge */}
            <span className={`text-xs px-1.5 py-0.5 rounded flex items-center gap-1 ${
              isLearned
                ? 'bg-purple-500/10 text-purple-400'
                : 'bg-blue-500/10 text-blue-400'
            }`}>
              {isLearned ? <Brain className="w-3 h-3" /> : <User className="w-3 h-3" />}
              {isLearned ? 'AI 学习' : '用户定义'}
            </span>

            {/* Confidence */}
            {isLearned && memory.confidence < 1 && (
              <span className="text-xs text-zinc-500">
                置信度 {Math.round(memory.confidence * 100)}%
              </span>
            )}

            {/* Time */}
            <span className="text-xs text-zinc-500">
              {formatTime(memory.updatedAt)}
            </span>

            {/* Project path */}
            {memory.projectPath && (
              <span className="text-xs text-zinc-600 truncate max-w-[150px]" title={memory.projectPath}>
                {memory.projectPath}
              </span>
            )}

            {/* Tags */}
            {memory.tags && memory.tags.length > 0 && (
              <div className="flex gap-1">
                {memory.tags.slice(0, 3).map((tag, i) => (
                  <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(memory)}
            className="p-1.5 h-auto"
            title="编辑"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            className={`p-1.5 h-auto ${showDeleteConfirm ? 'text-red-400 bg-red-500/10' : ''}`}
            title={showDeleteConfirm ? '点击确认删除' : '删除'}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
};
