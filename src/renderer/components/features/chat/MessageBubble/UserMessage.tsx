// ============================================================================
// UserMessage - Display user messages with collapsible long content
// ============================================================================

import React, { useState, useMemo } from 'react';
import { User, ChevronDown, ChevronUp } from 'lucide-react';
import type { UserMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentPreview';
import { formatTime } from './utils';

const MAX_VISIBLE_LINES = 15;

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate line count and prepare collapsed content
  const { shouldCollapse, collapsedContent, remainingLines } = useMemo(() => {
    const content = message.content || '';
    const allLines = content.split('\n');
    const total = allLines.length;
    const needsCollapse = total > MAX_VISIBLE_LINES;

    return {
      shouldCollapse: needsCollapse,
      collapsedContent: needsCollapse ? allLines.slice(0, MAX_VISIBLE_LINES).join('\n') : content,
      remainingLines: needsCollapse ? total - MAX_VISIBLE_LINES : 0,
    };
  }, [message.content]);

  const displayContent = shouldCollapse && !isExpanded ? collapsedContent : message.content;

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
            <div
              className={`transition-all duration-300 ease-in-out ${
                shouldCollapse && !isExpanded ? 'relative' : ''
              }`}
            >
              <MessageContent content={displayContent} isUser={true} />

              {/* Fade overlay when collapsed */}
              {shouldCollapse && !isExpanded && (
                <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-primary-500/90 to-transparent pointer-events-none" />
              )}
            </div>

            {/* Expand/Collapse button */}
            {shouldCollapse && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="mt-2 flex items-center gap-1 text-xs text-white/80 hover:text-white transition-colors duration-200"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    <span>收起</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    <span>展开更多 (还有 {remainingLines} 行)</span>
                  </>
                )}
              </button>
            )}
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
