// ============================================================================
// UserMessage - Terminal style (Claude Code inspired)
// Left-aligned with > prefix and subtle background band
// ============================================================================

import React from 'react';
import type { UserMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentPreview';

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  return (
    <div
      className="py-3 px-4 border-t border-b select-text"
      style={{
        backgroundColor: 'var(--cc-user-bg)',
        borderColor: 'rgba(255,255,255,0.04)',
      }}
    >
      {/* Attachments above text, left-aligned */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentDisplay attachments={message.attachments} />
        </div>
      )}

      {/* Text content with > prefix */}
      {message.content && (
        <div className="flex gap-2">
          <span
            className="flex-shrink-0 font-bold text-base select-none"
            style={{ color: 'var(--cc-brand)' }}
          >
            &gt;
          </span>
          <div className="text-zinc-100 leading-relaxed min-w-0 flex-1">
            <MessageContent content={message.content} isUser={true} />
          </div>
        </div>
      )}
    </div>
  );
};
