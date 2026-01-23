// ============================================================================
// Markdown Export - Export sessions as formatted markdown files
// ============================================================================
// Converts sessions to readable markdown format:
// - Preserves conversation structure
// - Formats code blocks with syntax highlighting hints
// - Includes tool execution results
// - Supports multiple export styles (chat, document, minimal)
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';

const logger = createLogger('MarkdownExport');

/**
 * Export style
 */
export type ExportStyle = 'chat' | 'document' | 'minimal';

/**
 * Export options
 */
export interface ExportOptions {
  /** Export style */
  style?: ExportStyle;
  /** Include metadata header */
  includeMetadata?: boolean;
  /** Include timestamps */
  includeTimestamps?: boolean;
  /** Include token counts */
  includeTokenCounts?: boolean;
  /** Include tool execution details */
  includeToolDetails?: boolean;
  /** Maximum code block length before truncation */
  maxCodeBlockLength?: number;
  /** Custom title for the export */
  title?: string;
  /** Include table of contents */
  includeTableOfContents?: boolean;
  /** Filter messages by role */
  filterRoles?: Array<'user' | 'assistant' | 'system'>;
  /** Message range (start index) */
  fromIndex?: number;
  /** Message range (end index) */
  toIndex?: number;
}

/**
 * Export result
 */
export interface ExportResult {
  /** Whether export was successful */
  success: boolean;
  /** The markdown content */
  markdown?: string;
  /** File path if saved */
  filePath?: string;
  /** Error message if failed */
  error?: string;
  /** Export statistics */
  stats?: {
    /** Total messages exported */
    messageCount: number;
    /** Total characters in export */
    characterCount: number;
    /** Code blocks found */
    codeBlockCount: number;
    /** Tool executions included */
    toolExecutionCount: number;
  };
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format role for display
 */
function formatRole(role: string): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/**
 * Count code blocks in content
 */
function countCodeBlocks(content: string): number {
  const matches = content.match(/```/g);
  return matches ? Math.floor(matches.length / 2) : 0;
}

/**
 * Truncate code blocks if too long
 */
function truncateCodeBlocks(content: string, maxLength: number): string {
  if (maxLength <= 0) return content;

  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

  return content.replace(codeBlockRegex, (match, lang, code) => {
    if (code.length > maxLength) {
      const truncated = code.substring(0, maxLength);
      const lines = code.split('\n').length;
      const truncatedLines = truncated.split('\n').length;
      return `\`\`\`${lang}\n${truncated}\n... (truncated ${lines - truncatedLines} lines)\n\`\`\``;
    }
    return match;
  });
}

/**
 * Generate metadata header
 */
function generateMetadataHeader(session: CachedSession, options: ExportOptions): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push(`session_id: ${session.sessionId}`);
  lines.push(`started_at: ${formatTimestamp(session.startedAt)}`);
  lines.push(`last_activity: ${formatTimestamp(session.lastActivityAt)}`);
  lines.push(`message_count: ${session.messages.length}`);

  if (options.includeTokenCounts) {
    lines.push(`total_tokens: ${session.totalTokens}`);
  }

  if (session.metadata) {
    lines.push('metadata:');
    for (const [key, value] of Object.entries(session.metadata)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        lines.push(`  ${key}: ${value}`);
      }
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate table of contents
 */
function generateTableOfContents(messages: CachedMessage[]): string {
  const lines: string[] = [];
  lines.push('## Table of Contents\n');

  let userCount = 0;
  let assistantCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      userCount++;
      const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
      lines.push(`- [User #${userCount}](#user-${userCount}): ${preview}...`);
    } else if (msg.role === 'assistant') {
      assistantCount++;
      lines.push(`- [Assistant #${assistantCount}](#assistant-${assistantCount})`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Export message in chat style
 */
function exportChatStyle(
  messages: CachedMessage[],
  options: ExportOptions
): string {
  const lines: string[] = [];
  let userCount = 0;
  let assistantCount = 0;

  for (const msg of messages) {
    // Role header
    if (msg.role === 'user') {
      userCount++;
      lines.push(`### User {#user-${userCount}}`);
    } else if (msg.role === 'assistant') {
      assistantCount++;
      lines.push(`### Assistant {#assistant-${assistantCount}}`);
    } else {
      lines.push(`### ${formatRole(msg.role)}`);
    }

    // Timestamp if requested
    if (options.includeTimestamps && msg.timestamp) {
      lines.push(`*${formatTimestamp(msg.timestamp)}*`);
    }

    lines.push('');

    // Content (with code block truncation if needed)
    let content = msg.content;
    if (options.maxCodeBlockLength) {
      content = truncateCodeBlocks(content, options.maxCodeBlockLength);
    }
    lines.push(content);

    // Token count if requested
    if (options.includeTokenCounts && msg.tokens) {
      lines.push('');
      lines.push(`*Tokens: ${msg.tokens}*`);
    }

    // Tool execution details
    if (options.includeToolDetails && msg.metadata?.toolExecution) {
      const tool = msg.metadata.toolExecution as {
        tool?: string;
        input?: unknown;
        output?: unknown;
      };
      lines.push('');
      lines.push('<details>');
      lines.push(`<summary>Tool: ${tool.tool || 'unknown'}</summary>`);
      lines.push('');
      lines.push('**Input:**');
      lines.push('```json');
      lines.push(JSON.stringify(tool.input, null, 2));
      lines.push('```');
      if (tool.output) {
        lines.push('**Output:**');
        lines.push('```');
        lines.push(String(tool.output).substring(0, 1000));
        lines.push('```');
      }
      lines.push('</details>');
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export message in document style
 */
function exportDocumentStyle(
  messages: CachedMessage[],
  options: ExportOptions
): string {
  const lines: string[] = [];

  // Group by conversation turns
  let currentTurn = 0;
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      currentTurn++;
      lines.push(`## Turn ${currentTurn}`);
      lines.push('');

      // User question
      lines.push('### Question');
      if (options.includeTimestamps && msg.timestamp) {
        lines.push(`*${formatTimestamp(msg.timestamp)}*`);
      }
      lines.push('');
      lines.push(msg.content);
      lines.push('');

      // Look for assistant response
      i++;
      if (i < messages.length && messages[i].role === 'assistant') {
        lines.push('### Response');
        if (options.includeTimestamps && messages[i].timestamp) {
          lines.push(`*${formatTimestamp(messages[i].timestamp)}*`);
        }
        lines.push('');

        let content = messages[i].content;
        if (options.maxCodeBlockLength) {
          content = truncateCodeBlocks(content, options.maxCodeBlockLength);
        }
        lines.push(content);
        lines.push('');
        i++;
      }
    } else {
      // System or standalone assistant message
      lines.push(`## ${formatRole(msg.role)} Message`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      i++;
    }
  }

  return lines.join('\n');
}

/**
 * Export message in minimal style
 */
function exportMinimalStyle(
  messages: CachedMessage[],
  options: ExportOptions
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    // Simple role prefix
    const prefix = msg.role === 'user' ? '**You:**' : msg.role === 'assistant' ? '**AI:**' : `**${msg.role}:**`;
    lines.push(prefix);
    lines.push('');

    let content = msg.content;
    if (options.maxCodeBlockLength) {
      content = truncateCodeBlocks(content, options.maxCodeBlockLength);
    }
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export a session to markdown
 */
export function exportSessionToMarkdown(
  session: CachedSession,
  options: ExportOptions = {}
): ExportResult {
  const {
    style = 'chat',
    includeMetadata = true,
    includeTimestamps = true,
    includeTokenCounts = false,
    includeToolDetails = false,
    maxCodeBlockLength = 0,
    title,
    includeTableOfContents = false,
    filterRoles,
    fromIndex = 0,
    toIndex,
  } = options;

  try {
    // Filter and slice messages
    let messages = session.messages;

    if (filterRoles && filterRoles.length > 0) {
      messages = messages.filter(m => filterRoles.includes(m.role));
    }

    const endIndex = toIndex !== undefined ? Math.min(toIndex, messages.length) : messages.length;
    messages = messages.slice(fromIndex, endIndex);

    if (messages.length === 0) {
      return {
        success: false,
        error: 'No messages to export after filtering',
      };
    }

    // Build markdown
    const parts: string[] = [];

    // Title
    const exportTitle = title || `Session: ${session.sessionId}`;
    parts.push(`# ${exportTitle}`);
    parts.push('');

    // Metadata header
    if (includeMetadata) {
      parts.push(generateMetadataHeader(session, options));
    }

    // Table of contents
    if (includeTableOfContents && style === 'chat') {
      parts.push(generateTableOfContents(messages));
    }

    // Messages
    const fullOptions: ExportOptions = {
      ...options,
      includeTimestamps,
      includeTokenCounts,
      includeToolDetails,
      maxCodeBlockLength,
    };

    switch (style) {
      case 'document':
        parts.push(exportDocumentStyle(messages, fullOptions));
        break;
      case 'minimal':
        parts.push(exportMinimalStyle(messages, fullOptions));
        break;
      case 'chat':
      default:
        parts.push(exportChatStyle(messages, fullOptions));
    }

    const markdown = parts.join('\n');

    // Calculate stats
    let codeBlockCount = 0;
    let toolExecutionCount = 0;
    for (const msg of messages) {
      codeBlockCount += countCodeBlocks(msg.content);
      if (msg.metadata?.toolExecution) {
        toolExecutionCount++;
      }
    }

    return {
      success: true,
      markdown,
      stats: {
        messageCount: messages.length,
        characterCount: markdown.length,
        codeBlockCount,
        toolExecutionCount,
      },
    };
  } catch (error: any) {
    logger.error('Failed to export session', { error });
    return {
      success: false,
      error: error.message || 'Unknown export error',
    };
  }
}

/**
 * Export session to markdown file
 */
export async function exportSessionToFile(
  sessionId: string,
  filePath: string,
  options: ExportOptions = {},
  cache: SessionLocalCache = getDefaultCache()
): Promise<ExportResult> {
  // Get session
  const session = cache.getSession(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session "${sessionId}" not found`,
    };
  }

  // Export to markdown
  const result = exportSessionToMarkdown(session, options);
  if (!result.success || !result.markdown) {
    return result;
  }

  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(filePath, result.markdown, 'utf-8');

    logger.info('Session exported to file', {
      sessionId,
      filePath,
      characterCount: result.stats?.characterCount,
    });

    return {
      ...result,
      filePath,
    };
  } catch (error: any) {
    logger.error('Failed to write export file', { filePath, error });
    return {
      success: false,
      error: `Failed to write file: ${error.message}`,
    };
  }
}

/**
 * Generate suggested filename for export
 */
export function suggestExportFilename(session: CachedSession): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toISOString().split('T')[0];

  // Try to extract a topic from first user message
  const firstUser = session.messages.find(m => m.role === 'user');
  let topic = 'session';

  if (firstUser) {
    // Extract first few words
    const words = firstUser.content
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .slice(0, 4)
      .join('-')
      .toLowerCase();

    if (words.length > 3) {
      topic = words.substring(0, 50);
    }
  }

  return `${dateStr}-${topic}.md`;
}

/**
 * Markdown Export Manager class
 */
export class MarkdownExporter {
  private cache: SessionLocalCache;
  private defaultOptions: ExportOptions;

  constructor(options: {
    cache?: SessionLocalCache;
    defaultExportOptions?: ExportOptions;
  } = {}) {
    this.cache = options.cache || getDefaultCache();
    this.defaultOptions = options.defaultExportOptions || {};
  }

  /**
   * Export session to markdown string
   */
  export(sessionId: string, options?: ExportOptions): ExportResult {
    const session = this.cache.getSession(sessionId);
    if (!session) {
      return { success: false, error: `Session "${sessionId}" not found` };
    }
    return exportSessionToMarkdown(session, { ...this.defaultOptions, ...options });
  }

  /**
   * Export session to file
   */
  async exportToFile(
    sessionId: string,
    filePath: string,
    options?: ExportOptions
  ): Promise<ExportResult> {
    return exportSessionToFile(
      sessionId,
      filePath,
      { ...this.defaultOptions, ...options },
      this.cache
    );
  }

  /**
   * Export with auto-generated filename
   */
  async exportAuto(
    sessionId: string,
    directory: string,
    options?: ExportOptions
  ): Promise<ExportResult> {
    const session = this.cache.getSession(sessionId);
    if (!session) {
      return { success: false, error: `Session "${sessionId}" not found` };
    }

    const filename = suggestExportFilename(session);
    const filePath = path.join(directory, filename);

    return this.exportToFile(sessionId, filePath, options);
  }
}

/**
 * Default exporter instance
 */
let defaultExporter: MarkdownExporter | null = null;

export function getDefaultExporter(): MarkdownExporter {
  if (!defaultExporter) {
    defaultExporter = new MarkdownExporter();
  }
  return defaultExporter;
}
