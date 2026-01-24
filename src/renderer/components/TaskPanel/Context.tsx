// ============================================================================
// Context - Display context items (files, tools, etc.)
// ============================================================================

import React from 'react';
import { FileText, Wrench, Image, FolderArchive } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';

interface ContextItem {
  type: 'file' | 'image' | 'tool';
  name: string;
  icon: React.ReactNode;
}

export const Context: React.FC = () => {
  const { messages } = useSessionStore();

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

    // Check tool calls (show unique tools used)
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        const key = `tool-${toolCall.name}`;
        if (!seenItems.has(key)) {
          seenItems.add(key);
          contextItems.push({
            type: 'tool',
            name: toolCall.name,
            icon: <Wrench className="w-3.5 h-3.5 text-primary-400" />,
          });
        }
      }
    }
  }

  // Limit to 6 items
  const displayItems = contextItems.slice(0, 6);

  if (displayItems.length === 0) {
    return null;
  }

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <div className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">
        Context
      </div>

      {/* Icon grid */}
      <div className="flex flex-wrap gap-2">
        {displayItems.map((item, index) => (
          <div
            key={index}
            className="flex items-center gap-1.5 px-2 py-1 bg-zinc-800/50 rounded text-xs text-zinc-300"
            title={item.name}
          >
            {item.icon}
            <span className="max-w-20 truncate">{item.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
