// ============================================================================
// MemoryCard - Individual Memory Item Display
// ============================================================================

import React from 'react';
import { Edit2, Trash2, Clock, Sparkles, User } from 'lucide-react';
import type { MemoryItem } from '@shared/types';

// ============================================================================
// Types
// ============================================================================

export interface MemoryCardProps {
  memory: MemoryItem;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  onEdit,
  onDelete,
  isDeleting,
  onConfirmDelete,
  onCancelDelete,
}) => {
  // Format date
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays} 天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  // Get source icon and label
  const getSourceInfo = () => {
    if (memory.source === 'learned') {
      return {
        icon: <Sparkles className="w-3 h-3" />,
        label: `AI 学习`,
        color: 'text-cyan-400',
      };
    }
    return {
      icon: <User className="w-3 h-3" />,
      label: '手动添加',
      color: 'text-zinc-400',
    };
  };

  const sourceInfo = getSourceInfo();

  // Show delete confirmation
  if (isDeleting) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2">
        <p className="text-xs text-red-300 mb-2">确定要删除这条记忆吗？</p>
        <div className="flex gap-2">
          <button
            onClick={onCancelDelete}
            className="flex-1 px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirmDelete}
            className="flex-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group bg-zinc-800/50 hover:bg-zinc-800 rounded-lg p-2 transition-colors">
      {/* Content */}
      <p className="text-sm text-zinc-200 mb-1.5 line-clamp-2">{memory.content}</p>

      {/* Meta & Actions */}
      <div className="flex items-center justify-between">
        {/* Meta info */}
        <div className="flex items-center gap-3 text-xs">
          {/* Source */}
          <span className={`flex items-center gap-1 ${sourceInfo.color}`}>
            {sourceInfo.icon}
            {sourceInfo.label}
            {memory.source === 'learned' && memory.confidence < 1 && (
              <span className="text-zinc-500">
                ({Math.round(memory.confidence * 100)}%)
              </span>
            )}
          </span>

          {/* Date */}
          <span className="flex items-center gap-1 text-zinc-500">
            <Clock className="w-3 h-3" />
            {formatDate(memory.updatedAt)}
          </span>
        </div>

        {/* Actions - show on hover */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
            title="编辑"
          >
            <Edit2 className="w-3 h-3" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Tags */}
      {memory.tags && memory.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {memory.tags.map((tag: string, index: number) => (
            <span
              key={index}
              className="px-1.5 py-0.5 text-xs bg-zinc-700/50 text-zinc-400 rounded"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
