// ============================================================================
// MessageBubble - Individual Chat Message Display
// ============================================================================

import React, { useState } from 'react';
import { User, Bot, ChevronDown, ChevronRight, Terminal, FileText, Copy, Check } from 'lucide-react';
import type { Message, ToolCall, ToolResult } from '@shared/types';

interface MessageBubbleProps {
  message: Message;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div
      className={`flex gap-3 animate-slideUp ${
        isUser ? 'flex-row-reverse' : ''
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          isUser
            ? 'bg-blue-500'
            : 'bg-gradient-to-br from-purple-500 to-pink-500'
        }`}
      >
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-white" />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        {/* Text content */}
        {message.content && (
          <div
            className={`inline-block rounded-xl px-4 py-2.5 max-w-full ${
              isUser
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-800 text-zinc-100'
            }`}
          >
            <MessageContent content={message.content} />
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCallDisplay key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div
          className={`text-xs text-zinc-500 mt-1 ${
            isUser ? 'text-right' : ''
          }`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};

// Message content with markdown-like rendering
const MessageContent: React.FC<{ content: string }> = ({ content }) => {
  // Simple code block detection
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          return <CodeBlock key={index} content={part} />;
        }
        return <span key={index}>{part}</span>;
      })}
    </div>
  );
};

// Code block component
const CodeBlock: React.FC<{ content: string }> = ({ content }) => {
  const [copied, setCopied] = useState(false);

  // Extract language and code
  const match = content.match(/```(\w*)\n?([\s\S]*?)```/);
  const language = match?.[1] || '';
  const code = match?.[2]?.trim() || content.replace(/```/g, '').trim();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2 rounded-lg bg-zinc-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/50 border-b border-zinc-700">
        <span className="text-xs text-zinc-400">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
      {/* Code */}
      <pre className="p-3 overflow-x-auto">
        <code className="text-xs text-zinc-300">{code}</code>
      </pre>
    </div>
  );
};

// Tool call display component
const ToolCallDisplay: React.FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false);

  const getToolIcon = (name: string) => {
    if (name === 'bash') return <Terminal className="w-3.5 h-3.5" />;
    return <FileText className="w-3.5 h-3.5" />;
  };

  // Get status from result - ToolResult has 'success: boolean', not 'status: string'
  const getStatus = (): 'success' | 'error' | 'pending' | undefined => {
    if (!toolCall.result) return 'pending';
    return toolCall.result.success ? 'success' : 'error';
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'success':
        return 'text-green-400 bg-green-500/10';
      case 'error':
        return 'text-red-400 bg-red-500/10';
      case 'pending':
        return 'text-yellow-400 bg-yellow-500/10';
      default:
        return 'text-zinc-400 bg-zinc-500/10';
    }
  };

  const status = getStatus();

  return (
    <div className="rounded-lg bg-zinc-800/50 border border-zinc-700 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-700/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
        )}
        <span className={`p-1 rounded ${getStatusColor(status)}`}>
          {getToolIcon(toolCall.name)}
        </span>
        <span className="text-sm font-medium text-zinc-300">{toolCall.name}</span>
        {status && (
          <span
            className={`ml-auto text-xs px-2 py-0.5 rounded-full ${getStatusColor(status)}`}
          >
            {status}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-zinc-700/50">
          {/* Arguments */}
          <div className="mt-2">
            <div className="text-xs font-medium text-zinc-500 mb-1">Arguments</div>
            <pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 overflow-x-auto">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result && (
            <div className="mt-2">
              <div className="text-xs font-medium text-zinc-500 mb-1">Result</div>
              <pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 overflow-x-auto max-h-40">
                {toolCall.result.error
                  ? toolCall.result.error
                  : typeof toolCall.result.output === 'string'
                    ? toolCall.result.output
                    : JSON.stringify(toolCall.result.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Helper function
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}
