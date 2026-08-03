// ============================================================================
// MessageBubble Types
// ============================================================================

import type { ToolCall, MessageAttachment } from '@shared/contract';
import type { SessionMediaContext } from '@shared/utils/sessionMediaAssets';

// Props types
export interface MessageContentProps {
  content: string;
  isUser?: boolean;
  isStreaming?: boolean;
  messageId?: string;
  mediaContext?: SessionMediaContext;
  /**
   * useSmoothStreamingText 上报的尾段起始下标：纯文本流式路径把该下标之后
   * 的最新段落包进淡入 span；null/越界时不拆分。markdown 路径忽略（块级淡入
   * 已由 .streaming-text > * 负责）。
   */
  streamingTailStart?: number | null;
}

export interface ToolCallDisplayProps {
  toolCall: ToolCall;
  index: number;
  total: number;
  /** Compact mode for Cowork display - simplified view */
  compact?: boolean;
}

export interface AttachmentDisplayProps {
  attachments: MessageAttachment[];
  mediaContext?: SessionMediaContext;
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
// - success: 工具执行成功
// - error: 工具执行失败
// - pending: 工具正在执行中
// - interrupted: 工具执行被中断（历史消息中未完成的工具调用）
export type ToolStatus = 'success' | 'error' | 'pending' | 'interrupted';

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
export type { Message, ToolCall, ToolResult, MessageAttachment, AttachmentCategory } from '@shared/contract';
