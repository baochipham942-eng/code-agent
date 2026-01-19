// ============================================================================
// AssistantMessage - Display AI assistant messages
// ============================================================================

import React from 'react';
import { Bot } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay';
import { formatTime } from './utils';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  return (
    <div className="flex gap-3 animate-slideUp">
      {/* Avatar */}
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-lg bg-gradient-to-br from-accent-purple to-accent-pink shadow-purple-500/20">
        <Bot className="w-4 h-4 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl px-4 py-3 max-w-full shadow-lg bg-zinc-800/80 text-zinc-100 border border-zinc-700/50 shadow-black/20">
            <MessageContent content={message.content} isUser={false} />
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-3 space-y-2">
            {message.toolCalls.map((toolCall, index) => (
              <ToolCallDisplay
                key={toolCall.id}
                toolCall={toolCall}
                index={index}
                total={message.toolCalls!.length}
              />
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div className="text-xs text-zinc-500 mt-1.5">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};
