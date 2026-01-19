// ============================================================================
// MessageBubble Types
// ============================================================================

import type { Message, ToolCall, MessageAttachment, AttachmentCategory } from '@shared/types';

// Props types
export interface MessageBubbleProps {
  message: Message;
}

export interface UserMessageProps {
  message: Message;
}

export interface AssistantMessageProps {
  message: Message;
}

export interface MessageContentProps {
  content: string;
  isUser?: boolean;
}

export interface ToolCallDisplayProps {
  toolCall: ToolCall;
  index: number;
  total: number;
}

export interface AttachmentDisplayProps {
  attachments: MessageAttachment[];
}

export interface CodeBlockProps {
  content: string;
}

// Block types for markdown parsing
export type BlockType = 'paragraph' | 'heading' | 'table' | 'list' | 'blockquote' | 'hr';

export interface MarkdownBlockData {
  type: BlockType;
  content: string;
  level?: number; // for headings (1-6) and lists
  items?: string[]; // for lists
  ordered?: boolean; // for lists
}

// Tool status
export type ToolStatus = 'success' | 'error' | 'pending';

export interface ToolStatusConfig {
  bg: string;
  text: string;
  border: string;
  icon: React.ReactNode;
  label: string;
}

// Language config for code blocks
export interface LanguageConfig {
  color: string;
  icon?: React.ReactNode;
}

// Attachment icon config
export interface AttachmentIconConfig {
  icon: React.ReactNode;
  color: string;
  label: string;
}

// Re-export types from shared
export type { Message, ToolCall, ToolResult, MessageAttachment, AttachmentCategory } from '@shared/types';
