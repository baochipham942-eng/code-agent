// ============================================================================
// CaptureAddDialog - 手动添加知识条目对话框
// ============================================================================

import React, { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { useCaptureStore } from '../../../stores/captureStore';

export const CaptureAddDialog: React.FC = () => {
  const { isAddDialogOpen, setAddDialogOpen, captureItem } = useCaptureStore();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [url, setUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !content.trim()) return;

    setIsSubmitting(true);
    try {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      const success = await captureItem({
        title: title.trim(),
        content: content.trim(),
        url: url.trim() || undefined,
        source: 'manual',
        tags: tagList,
      });
      if (success) {
        setTitle('');
        setContent('');
        setTags('');
        setUrl('');
        setAddDialogOpen(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [title, content, tags, url, captureItem, setAddDialogOpen]);

  if (!isAddDialogOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={() => setAddDialogOpen(false)}
    >
      <div
        className="w-[500px] bg-[#1e1e24] rounded-lg border border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h3 className="text-sm font-medium text-zinc-200">添加知识条目</h3>
          <button
            onClick={() => setAddDialogOpen(false)}
            className="p-1 text-zinc-500 hover:text-zinc-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单 */}
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">标题 *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入标题"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800/50 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-600"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">内容 *</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入内容..."
              rows={6}
              className="w-full px-3 py-1.5 text-sm bg-zinc-800/50 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-600 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">标签（逗号分隔）</label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="标签1, 标签2, ..."
              className="w-full px-3 py-1.5 text-sm bg-zinc-800/50 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">URL（可选）</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-1.5 text-sm bg-zinc-800/50 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-600"
            />
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          <button
            onClick={() => setAddDialogOpen(false)}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300 rounded-md hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || !content.trim() || isSubmitting}
            className="px-3 py-1.5 text-xs bg-cyan-600 text-white rounded-md hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? '添加中...' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
};
