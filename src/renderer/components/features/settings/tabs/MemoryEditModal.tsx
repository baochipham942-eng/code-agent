// ============================================================================
// MemoryEditModal - Edit Memory Content
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Edit2 } from 'lucide-react';
import { Modal, ModalFooter, Button, Textarea } from '../../../primitives';
import type { MemoryItem } from '@shared/types';

// ============================================================================
// Types
// ============================================================================

export interface MemoryEditModalProps {
  isOpen: boolean;
  memory: MemoryItem;
  onClose: () => void;
  onSave: (id: string, content: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export const MemoryEditModal: React.FC<MemoryEditModalProps> = ({
  isOpen,
  memory,
  onClose,
  onSave,
}) => {
  const [content, setContent] = useState(memory.content);
  const [isSaving, setIsSaving] = useState(false);

  // Reset content when memory changes
  useEffect(() => {
    setContent(memory.content);
  }, [memory]);

  const handleSave = async () => {
    if (!content.trim() || content === memory.content) {
      onClose();
      return;
    }

    setIsSaving(true);
    try {
      await onSave(memory.id, content.trim());
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="编辑记忆"
      size="md"
      headerIcon={<Edit2 className="w-5 h-5 text-indigo-400" />}
      zIndex={70}
      footer={
        <ModalFooter
          cancelText="取消"
          confirmText={isSaving ? '保存中...' : '保存'}
          onCancel={onClose}
          onConfirm={handleSave}
          confirmDisabled={isSaving || !content.trim() || content === memory.content}
        />
      }
    >
      <div className="space-y-3">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入记忆内容..."
          rows={4}
          autoFocus
        />

        {/* Meta info */}
        <div className="text-xs text-zinc-500 space-y-1">
          <div className="flex justify-between">
            <span>来源</span>
            <span className="text-zinc-400">
              {memory.source === 'learned' ? 'AI 学习' : '手动添加'}
            </span>
          </div>
          {memory.source === 'learned' && (
            <div className="flex justify-between">
              <span>置信度</span>
              <span className="text-zinc-400">
                {Math.round(memory.confidence * 100)}%
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span>创建时间</span>
            <span className="text-zinc-400">
              {new Date(memory.createdAt).toLocaleDateString('zh-CN')}
            </span>
          </div>
        </div>

        <p className="text-xs text-zinc-500">
          提示: 按 Cmd/Ctrl + Enter 快速保存
        </p>
      </div>
    </Modal>
  );
};
