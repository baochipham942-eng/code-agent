// ============================================================================
// UserMessage - Display user messages
// ============================================================================

import React from 'react';
import { User } from 'lucide-react';
import type { UserMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentPreview';
import { formatTime } from './utils';

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  return (
    <div className="flex gap-3 animate-slideUp flex-row-reverse">
      {/* Avatar */}
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-lg bg-gradient-to-br from-primary-500 to-primary-600 shadow-primary-500/20">
        <User className="w-4 h-4 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 text-right">
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentDisplay attachments={message.attachments} />
        )}

        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl px-4 py-3 max-w-full shadow-lg bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-primary-500/10">
            <MessageContent content={message.content} isUser={true} />
          </div>
        )}

        {/* Timestamp */}
        <div className="text-xs text-zinc-500 mt-1.5 text-right">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};
