// ============================================================================
// MessageBubble - Individual Chat Message Display
// ============================================================================
// This is the main entry point that routes messages to the appropriate
// component based on the message role (user or assistant).
// ============================================================================

import React from 'react';
import type { MessageBubbleProps } from './types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { CoworkMessageBubble } from './CoworkMessageBubble';
import { useIsCoworkMode } from '../../../../stores/modeStore';

// Main MessageBubble component - routes to appropriate display
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isCoworkMode = useIsCoworkMode();

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
export { MessageContent, CodeBlock, InlineTextWithCode } from './MessageContent';
export { ToolCallDisplay } from './ToolCallDisplay';
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
