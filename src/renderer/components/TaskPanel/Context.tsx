// ============================================================================
// Context - Display context items (files, tools, etc.) with expandable details
// ============================================================================

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Wrench, Image, FolderArchive, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useI18n } from '../../hooks/useI18n';

interface ContextItem {
  type: 'file' | 'image' | 'tool';
  name: string;
  icon: React.ReactNode;
  details?: Record<string, unknown>;
}

export const Context: React.FC = () => {
  const { messages } = useSessionStore();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Extract context from recent messages
  const contextItems: ContextItem[] = [];

  // Check last few messages for attachments and tool calls
  const recentMessages = messages.slice(-10);
  const seenItems = new Set<string>();

  for (const message of recentMessages) {
    // Check attachments
    if (message.attachments) {
      for (const attachment of message.attachments) {
        const key = `${attachment.type}-${attachment.name}`;
        if (!seenItems.has(key)) {
          seenItems.add(key);
          let icon: React.ReactNode;
          // Use category for folder detection, type for image/file
          if (attachment.type === 'image') {
            icon = <Image className="w-3.5 h-3.5 text-purple-400" />;
          } else if (attachment.category === 'folder') {
            icon = <FolderArchive className="w-3.5 h-3.5 text-amber-400" />;
          } else {
            icon = <FileText className="w-3.5 h-3.5 text-zinc-400" />;
          }
          contextItems.push({
            type: attachment.type,
            name: attachment.name,
            icon,
          });
        }
      }
    }

    // Check tool calls (show unique tools used with details)
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        const key = `tool-${toolCall.name}-${contextItems.length}`;
        if (!seenItems.has(`tool-${toolCall.name}`)) {
          seenItems.add(`tool-${toolCall.name}`);
          contextItems.push({
            type: 'tool',
            name: toolCall.name,
            icon: <Wrench className="w-3.5 h-3.5 text-primary-400" />,
            details: toolCall.arguments as Record<string, unknown>,
          });
        }
      }
    }
  }

  // Limit to 8 items
  const displayItems = contextItems.slice(0, 8);

  const toggleExpand = (name: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Render details with markdown support for string values
  const renderDetails = (details: Record<string, unknown>) => {
    return Object.entries(details).map(([key, value]) => {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      const isLongText = typeof value === 'string' && value.length > 100;

      return (
        <div key={key} className="mb-2 last:mb-0">
          <div className="text-zinc-500 font-medium mb-0.5">{key}:</div>
          {isLongText ? (
            <div className="text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-code:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {stringValue}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
              {stringValue}
            </pre>
          )}
        </div>
      );
    });
  };

  if (displayItems.length === 0) {
    return null;
  }

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full mb-2"
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary-400" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.context}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
        )}
      </button>

      {/* Vertical list with expandable items */}
      {expanded && (
      <div className="space-y-1">
        {displayItems.map((item, index) => {
          const isExpanded = expandedItems.has(item.name);
          const hasDetails = item.details && Object.keys(item.details).length > 0;

          return (
            <div key={index} className="rounded overflow-hidden">
              <button
                onClick={() => hasDetails && toggleExpand(item.name)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                  hasDetails ? 'hover:bg-zinc-800/50 cursor-pointer' : 'cursor-default'
                }`}
              >
                {item.icon}
                <span className="flex-1 text-sm text-zinc-300 truncate">{item.name}</span>
                {hasDetails && (
                  isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-zinc-500" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-zinc-500" />
                  )
                )}
              </button>

              {/* Expanded details with scroll and markdown support */}
              {isExpanded && hasDetails && (
                <div className="px-2 py-2 bg-zinc-900/50 text-xs max-h-48 overflow-y-auto custom-scrollbar">
                  {renderDetails(item.details!)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
};
