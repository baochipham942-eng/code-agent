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
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-primary-500 to-accent-purple">
        <User className="w-3.5 h-3.5 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col items-end">
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentDisplay attachments={message.attachments} />
        )}

        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[85%] bg-gradient-to-br from-primary-600 to-primary-500 text-white">
            <MessageContent content={message.content} isUser={true} />
          </div>
        )}

        {/* Timestamp */}
        <div className="text-2xs text-zinc-600 mt-1 mr-1">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};
