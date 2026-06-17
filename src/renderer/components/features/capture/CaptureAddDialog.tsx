// ============================================================================
// CaptureAddDialog - 手动添加知识条目对话框
// ============================================================================

import React, { useState, useCallback } from 'react';
import { Modal, Button } from '../../primitives';
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

  return (
    <Modal
      isOpen={isAddDialogOpen}
      onClose={() => setAddDialogOpen(false)}
      title="添加知识条目"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => setAddDialogOpen(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={!title.trim() || !content.trim()}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">标题 *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入标题"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-cyan-600"
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
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-cyan-600 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">标签（逗号分隔）</label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="标签1, 标签2, ..."
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-cyan-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">URL（可选）</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-cyan-600"
            />
          </div>
        </div>
    </Modal>
  );
};
