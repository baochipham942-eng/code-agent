// ============================================================================
// UserMessage - Terminal style (Claude Code inspired)
// Left-aligned with > prefix and subtle background band
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import type { UserMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentPreview';

export const UserMessage: React.FC<UserMessageProps> = ({ message, onEdit }) => {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const handleSave = () => {
    if (onEdit && message.id && editContent.trim()) {
      onEdit(message.id, editContent.trim());
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditContent(message.content || '');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div
      className="py-3 px-4 select-text relative"
      aria-label="用户消息"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Edit button - top right on hover */}
      {hovered && !editing && onEdit && (
        <button
          onClick={() => setEditing(true)}
          className="absolute top-2 right-4 w-6 h-6 flex items-center justify-center bg-zinc-800/80 hover:bg-zinc-700 rounded-md text-zinc-400 hover:text-zinc-200 transition-colors z-10"
          title="编辑"
          aria-label="编辑消息"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Attachments above text */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentDisplay attachments={message.attachments} />
        </div>
      )}

      {/* Text content - 左侧色条 + 现代风格 */}
      {message.content && (
        <div
          className="pl-3 border-l-2 rounded-r-lg py-2 pr-3"
          style={{
            borderColor: 'var(--cc-brand)',
            backgroundColor: 'var(--cc-user-bg)',
          }}
        >
          {editing ? (
            <div>
              <textarea
                ref={textareaRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full bg-zinc-900 border border-zinc-600 rounded-md p-2 text-zinc-200 leading-relaxed resize-y min-h-[60px] focus:outline-none focus:border-zinc-500"
                rows={3}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleSave}
                  className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-md transition-colors"
                >
                  保存
                </button>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-md transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="text-zinc-200 leading-relaxed">
              <MessageContent content={message.content} isUser={true} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
