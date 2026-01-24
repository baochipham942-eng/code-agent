// ============================================================================
// Context Injector - 上下文注入器
// ============================================================================
// 将历史会话的关键上下文注入到新会话中，实现 Smart Forking 的上下文继承。
// 支持摘要注入、关键消息提取和防漂移警告。
// ============================================================================

import type { Message } from '../../shared/types';
import { getDatabase } from '../services';
import { createLogger } from '../services/infra/logger';
import type { SessionSummary } from './sessionSummarizer';
import * as fs from 'fs';

const logger = createLogger('ContextInjector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 注入的上下文
 */
export interface InjectedContext {
  /** 来源会话信息 */
  fromSession: {
    id: string;
    title: string;
    createdAt: number;
  };
  /** 会话摘要 */
  summary: string;
  /** 关键消息（最多 5 条） */
  keyMessages: Message[];
  /** 已做的决策 */
  decisions: string[];
  /** 相关代码片段 */
  codeContext: string[];
  /** 警告信息 */
  warnings: string[];
}

/**
 * 注入配置
 */
export interface InjectorConfig {
  /** 最大关键消息数 */
  maxKeyMessages: number;
  /** 最大代码片段数 */
  maxCodeSnippets: number;
  /** 旧会话警告天数阈值 */
  staleWarningDays: number;
  /** 是否验证文件存在性 */
  validateFileExistence: boolean;
}

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: InjectorConfig = {
  maxKeyMessages: 5,
  maxCodeSnippets: 3,
  staleWarningDays: 30,
  validateFileExistence: true,
};

// 关键消息标识关键词
const KEY_MESSAGE_INDICATORS = [
  // 决策
  '决定', '选择', '采用', '最终', 'decided', 'choose', 'final',
  // 重要
  '重要', '注意', '关键', 'important', 'note', 'key',
  // 总结
  '总结', '结论', '综上', 'summary', 'conclusion', 'in summary',
];

// ----------------------------------------------------------------------------
// Context Injector Class
// ----------------------------------------------------------------------------

export class ContextInjector {
  private config: InjectorConfig;

  constructor(config?: Partial<InjectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从历史会话构建注入上下文
   *
   * @param sessionId - 要 Fork 的历史会话 ID
   * @param summary - 会话摘要（可选，如果没有会从数据库获取消息）
   */
  async buildInjectedContext(
    sessionId: string,
    summary?: SessionSummary
  ): Promise<InjectedContext | null> {
    logger.info('Building injected context', { sessionId });

    // 1. 获取会话消息
    const db = getDatabase();
    const messages = await db.getMessages(sessionId);

    if (!messages || messages.length === 0) {
      logger.warn('No messages found for session', { sessionId });
      return null;
    }

    // 2. 获取会话信息
    const session = await db.getSession(sessionId);
    const sessionTitle = summary?.title || session?.title || '历史会话';
    const sessionCreatedAt = summary?.createdAt || session?.createdAt || Date.now();

    // 3. 提取关键消息
    const keyMessages = this.extractKeyMessages(messages);

    // 4. 提取代码片段
    const codeContext = this.extractCodeSnippets(messages);

    // 5. 生成警告
    const warnings = await this.generateWarnings(
      sessionCreatedAt,
      summary?.codeChanges || []
    );

    const injectedContext: InjectedContext = {
      fromSession: {
        id: sessionId,
        title: sessionTitle,
        createdAt: sessionCreatedAt,
      },
      summary: summary?.summaryText || this.generateQuickSummary(messages),
      keyMessages,
      decisions: summary?.keyDecisions || [],
      codeContext,
      warnings,
    };

    logger.info('Injected context built', {
      sessionId,
      keyMessages: keyMessages.length,
      warnings: warnings.length,
    });

    return injectedContext;
  }

  /**
   * 格式化注入上下文为 System Prompt 片段
   */
  formatForSystemPrompt(context: InjectedContext): string {
    const lines: string[] = [];

    lines.push('## 历史上下文（自动继承）');
    lines.push('');
    lines.push(`> 以下上下文继承自会话 "${context.fromSession.title}"（${this.formatDate(context.fromSession.createdAt)}）`);
    lines.push('');

    // 警告
    if (context.warnings.length > 0) {
      lines.push('### 注意事项');
      context.warnings.forEach((w) => lines.push(`- ${w}`));
      lines.push('');
    }

    // 摘要
    if (context.summary) {
      lines.push('### 会话摘要');
      lines.push(context.summary);
      lines.push('');
    }

    // 关键决策
    if (context.decisions.length > 0) {
      lines.push('### 已做决策');
      context.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push('');
    }

    // 关键消息
    if (context.keyMessages.length > 0) {
      lines.push('### 关键对话片段');
      context.keyMessages.forEach((msg, i) => {
        const role = msg.role === 'user' ? '用户' : '助手';
        const content = this.truncateContent(msg.content, 300);
        lines.push(`**${role}**: ${content}`);
        if (i < context.keyMessages.length - 1) lines.push('');
      });
      lines.push('');
    }

    // 代码上下文
    if (context.codeContext.length > 0) {
      lines.push('### 相关代码');
      context.codeContext.forEach((code) => {
        lines.push(code);
        lines.push('');
      });
    }

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 格式化为用户可见的消息
   */
  formatForUserMessage(context: InjectedContext): string {
    const date = this.formatDate(context.fromSession.createdAt);
    const lines: string[] = [];

    lines.push(`**已加载历史上下文**`);
    lines.push('');
    lines.push(`来自会话: "${context.fromSession.title}" (${date})`);
    lines.push('');

    if (context.warnings.length > 0) {
      lines.push('**注意:**');
      context.warnings.forEach((w) => lines.push(`  - ${w}`));
      lines.push('');
    }

    if (context.decisions.length > 0) {
      lines.push('**之前的决策:**');
      context.decisions.slice(0, 3).forEach((d) => lines.push(`  - ${d}`));
      lines.push('');
    }

    lines.push('---');
    lines.push('你可以基于这些历史上下文继续工作，无需重复解释背景。');

    return lines.join('\n');
  }

  /**
   * 提取关键消息
   */
  private extractKeyMessages(messages: Message[]): Message[] {
    const keyMessages: Message[] = [];
    const conversationMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    // 1. 找包含关键词的消息
    for (const msg of conversationMessages) {
      const hasKeyIndicator = KEY_MESSAGE_INDICATORS.some((kw) =>
        msg.content.toLowerCase().includes(kw.toLowerCase())
      );

      if (hasKeyIndicator && keyMessages.length < this.config.maxKeyMessages - 2) {
        keyMessages.push(msg);
      }
    }

    // 2. 添加最后两条消息（保持连续性）
    const lastTwo = conversationMessages.slice(-2);
    for (const msg of lastTwo) {
      if (!keyMessages.includes(msg)) {
        keyMessages.push(msg);
      }
    }

    // 3. 按原始顺序排序
    const msgIndexMap = new Map(messages.map((m, i) => [m, i]));
    keyMessages.sort((a, b) => (msgIndexMap.get(a) || 0) - (msgIndexMap.get(b) || 0));

    return keyMessages.slice(0, this.config.maxKeyMessages);
  }

  /**
   * 提取代码片段
   */
  private extractCodeSnippets(messages: Message[]): string[] {
    const codeBlocks: string[] = [];
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      let match;
      while ((match = codeBlockRegex.exec(msg.content)) !== null) {
        const [fullBlock, , code] = match;
        // 只保留较短的、有意义的代码块
        if (code.trim().length > 20 && code.trim().length < 500) {
          codeBlocks.push(fullBlock);
        }
      }
    }

    // 返回最后几个代码块（通常是最终版本）
    return codeBlocks.slice(-this.config.maxCodeSnippets);
  }

  /**
   * 生成警告
   */
  private async generateWarnings(
    sessionCreatedAt: number,
    codeChanges: string[]
  ): Promise<string[]> {
    const warnings: string[] = [];
    const now = Date.now();
    const ageInDays = (now - sessionCreatedAt) / (24 * 60 * 60 * 1000);

    // 1. 时效性警告
    if (ageInDays > this.config.staleWarningDays) {
      warnings.push(
        `此上下文来自 ${Math.floor(ageInDays)} 天前，代码和需求可能已变更`
      );
    }

    // 2. 文件存在性检查
    if (this.config.validateFileExistence && codeChanges.length > 0) {
      const missingFiles: string[] = [];

      for (const filePath of codeChanges.slice(0, 5)) {
        try {
          // 尝试检查文件是否存在
          if (!fs.existsSync(filePath)) {
            missingFiles.push(filePath);
          }
        } catch {
          // 忽略检查错误
        }
      }

      if (missingFiles.length > 0) {
        warnings.push(
          `以下文件可能已被移动或删除: ${missingFiles.join(', ')}`
        );
      }
    }

    return warnings;
  }

  /**
   * 生成快速摘要（当没有预生成摘要时）
   */
  private generateQuickSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return '';

    // 使用第一条和最后一条用户消息
    const first = this.truncateContent(userMessages[0].content, 100);
    const last =
      userMessages.length > 1
        ? this.truncateContent(userMessages[userMessages.length - 1].content, 100)
        : '';

    let summary = `开始: ${first}`;
    if (last && last !== first) {
      summary += `\n最后: ${last}`;
    }

    return summary;
  }

  /**
   * 截断内容
   */
  private truncateContent(content: string, maxLength: number): string {
    // 移除代码块
    const cleaned = content
      .replace(/```[\s\S]*?```/g, '[代码块]')
      .replace(/\n+/g, ' ')
      .trim();

    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return cleaned.substring(0, maxLength - 3) + '...';
  }

  /**
   * 格式化日期
   */
  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let injectorInstance: ContextInjector | null = null;

export function getContextInjector(): ContextInjector {
  if (!injectorInstance) {
    injectorInstance = new ContextInjector();
  }
  return injectorInstance;
}

export function initContextInjector(
  config?: Partial<InjectorConfig>
): ContextInjector {
  injectorInstance = new ContextInjector(config);
  return injectorInstance;
}
