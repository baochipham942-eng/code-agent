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
    <div className="py-3 px-4 select-text">
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
          <div className="text-zinc-100 leading-relaxed">
            <MessageContent content={message.content} isUser={true} />
          </div>
        </div>
      )}
    </div>
  );
};
