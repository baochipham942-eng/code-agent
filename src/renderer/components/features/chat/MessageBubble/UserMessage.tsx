// ============================================================================
// UserMessage - Display user messages (Claude/ChatGPT style)
// 右对齐，带背景色区分
// ============================================================================

import React from 'react';
import type { UserMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentPreview';

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  return (
    <div className="py-3 px-4 flex justify-end">
      <div className="max-w-[85%]">
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 flex justify-end">
            <AttachmentDisplay attachments={message.attachments} />
          </div>
        )}

        {/* Text content - 用户消息带背景 (teal/cyan style like Claude Cowork) */}
        {message.content && (
          <div className="bg-teal-700/80 text-white rounded-2xl px-4 py-3 select-text">
            <MessageContent content={message.content} isUser={true} />
          </div>
        )}
      </div>
    </div>
  );
};
