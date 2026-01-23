// ============================================================================
// MemoryEditModal - 记忆编辑弹窗
// ============================================================================

import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { Button, Textarea, Select } from '../../../primitives';
import type { MemoryItem, MemoryCategory } from '@shared/types';

interface MemoryEditModalProps {
  memory: MemoryItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: string, content: string) => Promise<void>;
}

// 分类选项
const CATEGORY_OPTIONS: Array<{ value: MemoryCategory; label: string; icon: string }> = [
  { value: 'about_me', label: '关于我', icon: '👤' },
  { value: 'preference', label: '我的偏好', icon: '⭐' },
  { value: 'frequent_info', label: '常用信息', icon: '📋' },
  { value: 'learned', label: '学到的经验', icon: '💡' },
];

export const MemoryEditModal: React.FC<MemoryEditModalProps> = ({
  memory,
  isOpen,
  onClose,
  onSave,
}) => {
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 当 memory 变化时重置表单
  useEffect(() => {
    if (memory) {
      setContent(memory.content);
      setError(null);
    }
  }, [memory]);

  const handleSave = async () => {
    if (!memory || !content.trim()) {
      setError('内容不能为空');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onSave(memory.id, content.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave();
    }
  };

  if (!isOpen || !memory) return null;

  const categoryInfo = CATEGORY_OPTIONS.find(c => c.value === memory.category);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-lg mx-4 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="flex items-center gap-2">
            <span className="text-lg">{categoryInfo?.icon}</span>
            <h3 className="text-lg font-medium text-zinc-100">编辑记忆</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="p-1.5 h-auto"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Category display (read-only) */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">分类</label>
            <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
              <span>{categoryInfo?.icon}</span>
              <span className="text-zinc-300">{categoryInfo?.label}</span>
            </div>
          </div>

          {/* Content textarea */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">内容</label>
            <Textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="输入记忆内容..."
              rows={6}
              className="w-full"
              autoFocus
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-zinc-500">
                {content.length} 字符
              </span>
              <span className="text-xs text-zinc-500">
                Cmd/Ctrl + Enter 保存
              </span>
            </div>
          </div>

          {/* Source info */}
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span>
              来源: {memory.source === 'learned' ? 'AI 学习' : '用户定义'}
            </span>
            {memory.source === 'learned' && (
              <span>
                置信度: {Math.round(memory.confidence * 100)}%
              </span>
            )}
            <span>
              创建于: {new Date(memory.createdAt).toLocaleDateString('zh-CN')}
            </span>
          </div>

          {/* Error message */}
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isSaving}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={isSaving || !content.trim()}
            className="flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" />
            {isSaving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
};
