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

// Main MessageBubble component - routes to appropriate display
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  if (isUser) {
    return <UserMessage message={message} />;
  }

  return <AssistantMessage message={message} />;
};

// Re-export sub-components for direct use if needed
export { UserMessage } from './UserMessage';
export { AssistantMessage } from './AssistantMessage';
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
