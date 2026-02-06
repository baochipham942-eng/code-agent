// ============================================================================
// MessageBubble - Individual Chat Message Display
// ============================================================================
// This is the main entry point that routes messages to the appropriate
// component based on the message role (user or assistant).
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Archive } from 'lucide-react';
import type { MessageBubbleProps } from './types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { CoworkMessageBubble } from './CoworkMessageBubble';
import { SkillStatusMessage, isSkillStatusContent } from './SkillStatusMessage';
import { useIsCoworkMode } from '../../../../stores/modeStore';

// CompactionBlock 渲染组件（折叠摘要卡片）
const CompactionBlockDisplay: React.FC<{ message: MessageBubbleProps['message'] }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);
  const compaction = message.compaction;

  if (!compaction) return null;

  return (
    <div className="py-2 px-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors"
      >
        <Archive className="w-4 h-4 text-amber-400" />
        <span className="text-xs font-medium text-amber-300">
          已压缩 {compaction.compactedMessageCount} 条消息，节省 {compaction.compactedTokenCount.toLocaleString()} tokens
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400 ml-auto" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-amber-400 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 px-3 py-2.5 rounded-md bg-amber-500/5 border border-amber-500/10">
          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {compaction.content}
          </p>
        </div>
      )}
    </div>
  );
};

// Main MessageBubble component - routes to appropriate display
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isCoworkMode = useIsCoworkMode();

  // CompactionBlock: 渲染压缩摘要卡片
  if (message.compaction) {
    return <CompactionBlockDisplay message={message} />;
  }

  // Skill 系统：检测并渲染 Skill 状态消息
  if (message.source === 'skill' && isSkillStatusContent(message.content)) {
    return <SkillStatusMessage content={message.content} />;
  }

  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }

  // Assistant message - choose component based on mode
  if (isCoworkMode) {
    return <CoworkMessageBubble message={message} />;
  }

  return <AssistantMessage message={message} />;
};

// Re-export sub-components for direct use if needed
export { UserMessage } from './UserMessage';
export { AssistantMessage } from './AssistantMessage';
export { CoworkMessageBubble } from './CoworkMessageBubble';
export { SkillStatusMessage, isSkillStatusContent } from './SkillStatusMessage';
export { MessageContent, CodeBlock, InlineTextWithCode } from './MessageContent';
export { ToolCallDisplay } from './ToolCallDisplay/index';
export { AttachmentDisplay } from './AttachmentPreview';

// Re-export types
export type {
  MessageBubbleProps,
  UserMessageProps,
  AssistantMessageProps,
  MessageContentProps,
  ToolCallDisplayProps,
  AttachmentDisplayProps,
  CodeBlockProps,
} from './types';

// Re-export utilities
export { formatTime, formatFileSize, languageConfig, parseMarkdownBlocks } from './utils';
