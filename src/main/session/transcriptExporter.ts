// ============================================================================
// Transcript Exporter - 生成可分享的会话记录
// ============================================================================
// 支持多种模板格式，用于 PR 评审、协作交接等场景
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import { compactModelSummarize } from '../context/compactModel';
import { estimateTokens } from '../context/tokenEstimator';
import {
  MarkdownExporter,
  ExportOptions,
  ExportResult,
  exportSessionToMarkdown,
} from './exportMarkdown';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';

const logger = createLogger('TranscriptExporter');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type TranscriptFormat = 'markdown' | 'json' | 'html';

export type TranscriptTemplate = 'default' | 'minimal' | 'share' | 'pr-review';

export interface TranscriptExportOptions extends ExportOptions {
  /** 导出格式 */
  format?: TranscriptFormat;
  /** 模板类型 */
  template?: TranscriptTemplate;
  /** 是否在开头添加 AI 摘要 */
  prependSummary?: boolean;
  /** 是否包含成本信息 */
  includeCost?: boolean;
  /** 是否匿名化敏感信息 */
  anonymize?: boolean;
  /** PR 关联信息 */
  prLink?: {
    owner: string;
    repo: string;
    number: number;
  };
}

export interface TranscriptExportResult extends ExportResult {
  /** AI 生成的摘要 */
  summary?: string;
  /** 是否进行了匿名化 */
  wasAnonymized?: boolean;
  /** 使用的模板 */
  template?: TranscriptTemplate;
}

// ----------------------------------------------------------------------------
// Anonymization Patterns
// ----------------------------------------------------------------------------

const ANONYMIZE_PATTERNS = [
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  // API Keys (generic patterns)
  { pattern: /(?:sk|pk|api|key|secret|token)[-_]?[a-zA-Z0-9]{20,}/gi, replacement: '[API_KEY]' },
  // AWS Access Keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[AWS_KEY]' },
  // GitHub Tokens
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, replacement: '[GITHUB_TOKEN]' },
  { pattern: /gho_[a-zA-Z0-9]{36}/g, replacement: '[GITHUB_TOKEN]' },
  // IP Addresses
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP]' },
  // User paths (Mac/Linux/Windows)
  { pattern: /\/Users\/[a-zA-Z0-9_-]+/g, replacement: '/Users/[USER]' },
  { pattern: /\/home\/[a-zA-Z0-9_-]+/g, replacement: '/home/[USER]' },
  { pattern: /C:\\Users\\[a-zA-Z0-9_-]+/gi, replacement: 'C:\\Users\\[USER]' },
  // Database URLs
  { pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi, replacement: '[DATABASE_URL]' },
  // JWT tokens
  { pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: '[JWT_TOKEN]' },
];

// ----------------------------------------------------------------------------
// Template Renderers
// ----------------------------------------------------------------------------

function renderDefaultTemplate(
  session: CachedSession,
  messages: CachedMessage[],
  options: TranscriptExportOptions,
  summary?: string
): string {
  const lines: string[] = [];

  // Title
  lines.push(`# Transcript: ${options.title || session.sessionId}`);
  lines.push('');

  // Summary if provided
  if (summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  // Metadata
  lines.push('## Metadata');
  lines.push('');
  lines.push(`- **Session ID**: ${session.sessionId}`);
  lines.push(`- **Started**: ${new Date(session.startedAt).toLocaleString()}`);
  lines.push(`- **Messages**: ${messages.length}`);
  if (options.includeCost && session.metadata?.cost) {
    lines.push(`- **Cost**: $${(session.metadata.cost as number).toFixed(4)}`);
  }
  lines.push('');

  // Conversation
  lines.push('## Conversation');
  lines.push('');

  for (const msg of messages) {
    const role = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : `**${msg.role}**`;
    lines.push(`### ${role}`);
    if (options.includeTimestamps && msg.timestamp) {
      lines.push(`*${new Date(msg.timestamp).toLocaleString()}*`);
    }
    lines.push('');
    lines.push(msg.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function renderMinimalTemplate(
  session: CachedSession,
  messages: CachedMessage[],
  options: TranscriptExportOptions,
  summary?: string
): string {
  const lines: string[] = [];

  if (summary) {
    lines.push(`> ${summary.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }

  for (const msg of messages) {
    const prefix = msg.role === 'user' ? '**Q:**' : '**A:**';
    lines.push(prefix);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

function renderShareTemplate(
  session: CachedSession,
  messages: CachedMessage[],
  options: TranscriptExportOptions,
  summary?: string
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${options.title || 'Shared Conversation'}`);
  lines.push('');

  // Summary (prominent position for share template)
  if (summary) {
    lines.push('> **TL;DR**');
    lines.push(`> ${summary.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }

  // Stats bar
  const duration = session.lastActivityAt - session.startedAt;
  const durationMin = Math.round(duration / 60000);
  lines.push(`📅 ${new Date(session.startedAt).toLocaleDateString()} | 💬 ${messages.length} messages | ⏱️ ${durationMin} min`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Conversation
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const emoji = msg.role === 'user' ? '👤' : '🤖';
    lines.push(`${emoji} **${msg.role === 'user' ? 'User' : 'Assistant'}**`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
    if (i < messages.length - 1) {
      lines.push('---');
      lines.push('');
    }
  }

  // Footer
  lines.push('');
  lines.push('---');
  lines.push('*Generated by Code Agent*');

  return lines.join('\n');
}

function renderPRReviewTemplate(
  session: CachedSession,
  messages: CachedMessage[],
  options: TranscriptExportOptions,
  summary?: string
): string {
  const lines: string[] = [];

  // PR Header
  if (options.prLink) {
    lines.push(`# Code Review Session for PR #${options.prLink.number}`);
    lines.push('');
    lines.push(`**Repository**: ${options.prLink.owner}/${options.prLink.repo}`);
    lines.push('');
  } else {
    lines.push('# Code Review Session');
    lines.push('');
  }

  // Summary
  if (summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  // Key decisions/changes
  lines.push('## Key Points');
  lines.push('');

  // Extract key points from conversation (simple heuristic)
  const keyPoints: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Look for list items or decisions
      const listItems = msg.content.match(/^[-*]\s+.+$/gm);
      if (listItems) {
        keyPoints.push(...listItems.slice(0, 3));
      }
    }
  }
  if (keyPoints.length > 0) {
    lines.push(...keyPoints.slice(0, 5));
  } else {
    lines.push('- See conversation below');
  }
  lines.push('');

  // Files discussed
  const filesDiscussed = new Set<string>();
  for (const msg of messages) {
    const fileMatches = msg.content.match(/`([^`]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|hpp|md|json|yaml|yml))`/g);
    if (fileMatches) {
      fileMatches.forEach(m => filesDiscussed.add(m.replace(/`/g, '')));
    }
  }
  if (filesDiscussed.size > 0) {
    lines.push('## Files Discussed');
    lines.push('');
    for (const file of filesDiscussed) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  // Conversation (collapsible)
  lines.push('<details>');
  lines.push('<summary>Full Conversation</summary>');
  lines.push('');

  for (const msg of messages) {
    const role = msg.role === 'user' ? '**User**' : '**Assistant**';
    lines.push(`### ${role}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Session: ${session.sessionId} | ${new Date(session.startedAt).toLocaleString()}*`);

  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Transcript Exporter Class
// ----------------------------------------------------------------------------

export class TranscriptExporter extends MarkdownExporter {
  /**
   * 导出 Transcript
   */
  async exportTranscript(
    sessionId: string,
    options: TranscriptExportOptions = {}
  ): Promise<TranscriptExportResult> {
    const cache = getDefaultCache();
    const session = cache.getSession(sessionId);

    if (!session) {
      return {
        success: false,
        error: `Session "${sessionId}" not found`,
      };
    }

    try {
      // Get messages
      let messages = [...session.messages];

      // Filter by role if specified
      if (options.filterRoles && options.filterRoles.length > 0) {
        messages = messages.filter(m => options.filterRoles!.includes(m.role));
      }

      // Apply range if specified
      if (options.fromIndex !== undefined || options.toIndex !== undefined) {
        const start = options.fromIndex || 0;
        const end = options.toIndex || messages.length;
        messages = messages.slice(start, end);
      }

      if (messages.length === 0) {
        return {
          success: false,
          error: 'No messages to export',
        };
      }

      // Anonymize if requested
      let wasAnonymized = false;
      if (options.anonymize) {
        messages = this.anonymizeMessages(messages);
        wasAnonymized = true;
      }

      // Generate summary if requested
      let summary: string | undefined;
      if (options.prependSummary) {
        summary = await this.generateSummary(messages);
      }

      // Render template
      const template = options.template || 'default';
      let markdown: string;

      switch (template) {
        case 'minimal':
          markdown = renderMinimalTemplate(session, messages, options, summary);
          break;
        case 'share':
          markdown = renderShareTemplate(session, messages, options, summary);
          break;
        case 'pr-review':
          markdown = renderPRReviewTemplate(session, messages, options, summary);
          break;
        case 'default':
        default:
          markdown = renderDefaultTemplate(session, messages, options, summary);
      }

      // Convert format if needed
      if (options.format === 'json') {
        const jsonResult = {
          sessionId: session.sessionId,
          summary,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
          metadata: {
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            messageCount: messages.length,
          },
        };
        return {
          success: true,
          markdown: JSON.stringify(jsonResult, null, 2),
          summary,
          wasAnonymized,
          template,
          stats: {
            messageCount: messages.length,
            characterCount: JSON.stringify(jsonResult).length,
            codeBlockCount: 0,
            toolExecutionCount: 0,
          },
        };
      }

      // Calculate stats
      let codeBlockCount = 0;
      for (const msg of messages) {
        const matches = msg.content.match(/```/g);
        if (matches) {
          codeBlockCount += Math.floor(matches.length / 2);
        }
      }

      return {
        success: true,
        markdown,
        summary,
        wasAnonymized,
        template,
        stats: {
          messageCount: messages.length,
          characterCount: markdown.length,
          codeBlockCount,
          toolExecutionCount: 0,
        },
      };
    } catch (error: any) {
      logger.error('Failed to export transcript', { sessionId, error });
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * 导出 Transcript 到文件
   */
  async exportTranscriptToFile(
    sessionId: string,
    filePath: string,
    options: TranscriptExportOptions = {}
  ): Promise<TranscriptExportResult> {
    const result = await this.exportTranscript(sessionId, options);

    if (!result.success || !result.markdown) {
      return result;
    }

    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, result.markdown, 'utf-8');

      logger.info('Transcript exported to file', {
        sessionId,
        filePath,
        template: result.template,
      });

      return {
        ...result,
        filePath,
      };
    } catch (error: any) {
      logger.error('Failed to write transcript file', { filePath, error });
      return {
        success: false,
        error: `Failed to write file: ${error.message}`,
      };
    }
  }

  /**
   * 匿名化消息中的敏感信息
   */
  private anonymizeMessages(messages: CachedMessage[]): CachedMessage[] {
    return messages.map(msg => ({
      ...msg,
      content: this.anonymizeContent(msg.content),
    }));
  }

  /**
   * 匿名化内容
   */
  private anonymizeContent(content: string): string {
    let result = content;
    for (const { pattern, replacement } of ANONYMIZE_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  /**
   * 生成 AI 摘要
   */
  private async generateSummary(messages: CachedMessage[]): Promise<string> {
    try {
      // Build conversation context
      const conversation = messages
        .map(m => `[${m.role}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`)
        .join('\n\n');

      const totalTokens = estimateTokens(conversation);

      // If too long, truncate
      const maxTokens = 4000;
      let contextToSummarize = conversation;
      if (totalTokens > maxTokens) {
        // Take first and last parts
        const firstPart = messages.slice(0, 3)
          .map(m => `[${m.role}]: ${m.content.substring(0, 300)}...`)
          .join('\n\n');
        const lastPart = messages.slice(-3)
          .map(m => `[${m.role}]: ${m.content.substring(0, 300)}...`)
          .join('\n\n');
        contextToSummarize = `${firstPart}\n\n[... ${messages.length - 6} messages omitted ...]\n\n${lastPart}`;
      }

      const prompt = `请为以下对话生成一个简洁的摘要（2-3 句话），重点概括：
1. 用户的主要需求
2. 完成了什么
3. 关键决策或结论

对话内容：
${contextToSummarize}

摘要：`;

      const summary = await compactModelSummarize(prompt, 200);
      return summary.trim();
    } catch (error) {
      logger.error('Failed to generate summary', { error });
      return '';
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let transcriptExporterInstance: TranscriptExporter | null = null;

export function getTranscriptExporter(): TranscriptExporter {
  if (!transcriptExporterInstance) {
    transcriptExporterInstance = new TranscriptExporter();
  }
  return transcriptExporterInstance;
}
