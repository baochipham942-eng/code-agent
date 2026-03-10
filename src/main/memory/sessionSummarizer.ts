// ============================================================================
// Session Summarizer - 会话摘要生成器
// ============================================================================
// 在会话结束时自动生成结构化摘要，用于后续检索和 Fork。
// 支持规则提取（免费）和 LLM 增强（高质量）两种模式。
// ============================================================================

import type { Message } from '../../shared/types';
import { getVectorStore } from './vectorStore';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionSummarizer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 会话摘要结构
 */
export interface SessionSummary {
  /** 会话 ID */
  sessionId: string;
  /** 一句话标题 */
  title: string;
  /** 讨论主题标签 */
  topics: string[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 修改的文件列表 */
  codeChanges: string[];
  /** 未解决的问题 */
  openQuestions: string[];
  /** 创建时间 */
  createdAt: number;
  /** 消息数量 */
  messageCount: number;
  /** 项目路径 */
  projectPath?: string;
  /** 摘要文本（用于向量检索） */
  summaryText: string;
  /** 生成方式 */
  generatedBy: 'rules' | 'llm';
}

/**
 * 摘要生成配置
 */
export interface SummarizerConfig {
  /** 最小消息数才生成摘要 */
  minMessagesForSummary: number;
  /** 是否使用 LLM 增强 */
  useLLMEnhancement: boolean;
  /** LLM 生成函数（可选） */
  llmSummarizer?: (messages: Message[]) => Promise<Partial<SessionSummary>>;
}

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: SummarizerConfig = {
  minMessagesForSummary: 4,
  useLLMEnhancement: false,
};

// 决策性关键词
const DECISION_KEYWORDS = [
  '决定', '选择', '使用', '采用', '最终',
  'decided', 'choose', 'use', 'adopt', 'finally', "let's go with",
  '我们用', '就用', '那就', '好的，',
];

// 问题关键词
const QUESTION_KEYWORDS = [
  '待定', '之后再', '后续', '暂时', '先不',
  'TODO', 'later', 'pending', 'TBD', 'to be determined',
  '？', '?',
];

// 主题提取正则
const TOPIC_PATTERNS = [
  // 技术栈
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|TypeScript|JavaScript|Python|Go|Rust|Node\.js)\b/gi,
  // 功能模块
  /\b(auth|认证|登录|authentication|API|database|数据库|routing|路由|state|状态管理)\b/gi,
  // 操作类型
  /\b(重构|refactor|优化|optimize|修复|fix|添加|add|实现|implement|测试|test)\b/gi,
];

// 文件路径提取正则
const FILE_PATH_PATTERN = /(?:^|\s)([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})(?:\s|$|:|\)|,)/g;

// ----------------------------------------------------------------------------
// Session Summarizer Class
// ----------------------------------------------------------------------------

export class SessionSummarizer {
  private config: SummarizerConfig;

  constructor(config?: Partial<SummarizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成会话摘要
   */
  async generateSummary(
    sessionId: string,
    messages: Message[],
    projectPath?: string
  ): Promise<SessionSummary | null> {
    // 过滤掉系统消息，只保留用户和助手消息
    const conversationMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    if (conversationMessages.length < this.config.minMessagesForSummary) {
      logger.debug('Not enough messages for summary', {
        count: conversationMessages.length,
        minimum: this.config.minMessagesForSummary,
      });
      return null;
    }

    logger.info('Generating session summary', {
      sessionId,
      messageCount: conversationMessages.length,
    });

    // 1. 规则提取基础信息
    const ruleBased = this.extractByRules(conversationMessages);

    // 2. 可选：LLM 增强
    let llmEnhanced: Partial<SessionSummary> = {};
    if (this.config.useLLMEnhancement && this.config.llmSummarizer) {
      try {
        llmEnhanced = await this.config.llmSummarizer(conversationMessages);
      } catch (error) {
        logger.warn('LLM enhancement failed, using rules only', { error });
      }
    }

    // 3. 合并结果
    const summary: SessionSummary = {
      sessionId,
      title: llmEnhanced.title || ruleBased.title,
      topics: [...new Set([...(llmEnhanced.topics || []), ...ruleBased.topics])],
      keyDecisions: llmEnhanced.keyDecisions || ruleBased.keyDecisions,
      codeChanges: ruleBased.codeChanges, // 文件路径始终用规则提取
      openQuestions: llmEnhanced.openQuestions || ruleBased.openQuestions,
      createdAt: Date.now(),
      messageCount: conversationMessages.length,
      projectPath,
      summaryText: this.buildSummaryText(ruleBased, llmEnhanced),
      generatedBy: llmEnhanced.title ? 'llm' : 'rules',
    };

    logger.info('Summary generated', {
      sessionId,
      title: summary.title,
      topics: summary.topics.length,
      decisions: summary.keyDecisions.length,
    });

    return summary;
  }

  /**
   * 保存摘要到向量库
   */
  async saveSummary(summary: SessionSummary): Promise<void> {
    const vectorStore = getVectorStore();

    await vectorStore.add(summary.summaryText, {
      source: 'session_summary',
      type: 'session_summary',
      sessionId: summary.sessionId,
      title: summary.title,
      topics: summary.topics,
      projectPath: summary.projectPath,
      createdAt: summary.createdAt,
      messageCount: summary.messageCount,
    });

    logger.info('Summary saved to vector store', {
      sessionId: summary.sessionId,
    });
  }

  /**
   * 规则提取
   */
  private extractByRules(messages: Message[]): Omit<SessionSummary, 'sessionId' | 'createdAt' | 'projectPath' | 'summaryText' | 'generatedBy'> {
    const allText = messages.map((m) => m.content).join('\n');
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    // 提取标题（使用第一条用户消息的前 50 字符）
    const firstUserMessage = userMessages[0]?.content || '';
    const title = this.extractTitle(firstUserMessage);

    // 提取主题
    const topics = this.extractTopics(allText);

    // 提取关键决策
    const keyDecisions = this.extractDecisions(assistantMessages);

    // 提取代码变更
    const codeChanges = this.extractCodeChanges(allText);

    // 提取未解决问题
    const openQuestions = this.extractOpenQuestions(messages);

    return {
      title,
      topics,
      keyDecisions,
      codeChanges,
      openQuestions,
      messageCount: messages.length,
    };
  }

  /**
   * 提取标题
   */
  private extractTitle(firstMessage: string): string {
    // 清理消息
    let title = firstMessage
      .replace(/```[\s\S]*?```/g, '') // 移除代码块
      .replace(/\n/g, ' ')
      .trim();

    // 截取前 50 字符
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    // 如果太短，使用默认标题
    if (title.length < 5) {
      title = '对话会话';
    }

    return title;
  }

  /**
   * 提取主题标签
   */
  private extractTopics(text: string): string[] {
    const topics = new Set<string>();

    for (const pattern of TOPIC_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach((m) => topics.add(m.toLowerCase()));
      }
    }

    return Array.from(topics).slice(0, 10); // 最多 10 个主题
  }

  /**
   * 提取关键决策
   */
  private extractDecisions(assistantMessages: Message[]): string[] {
    const decisions: string[] = [];

    for (const msg of assistantMessages) {
      const sentences = msg.content.split(/[.。!！\n]/);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < 10 || trimmed.length > 200) continue;

        // 检查是否包含决策关键词
        const hasDecisionKeyword = DECISION_KEYWORDS.some((kw) =>
          trimmed.toLowerCase().includes(kw.toLowerCase())
        );

        if (hasDecisionKeyword) {
          decisions.push(trimmed);
        }
      }
    }

    // 去重并限制数量
    return [...new Set(decisions)].slice(0, 5);
  }

  /**
   * 提取代码变更文件
   */
  private extractCodeChanges(text: string): string[] {
    const files = new Set<string>();

    // 匹配文件路径
    let match;
    while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
      const path = match[1];
      // 过滤掉明显不是文件的匹配
      if (
        path.includes('/') &&
        !path.startsWith('http') &&
        !path.startsWith('www.')
      ) {
        files.add(path);
      }
    }

    // 匹配代码块中的文件名注释
    const codeBlockFiles = text.match(/```\w*\s*\/\/\s*([^\n]+)/g);
    if (codeBlockFiles) {
      codeBlockFiles.forEach((cb) => {
        const filePath = cb.replace(/```\w*\s*\/\/\s*/, '').trim();
        if (filePath.includes('.')) {
          files.add(filePath);
        }
      });
    }

    return Array.from(files).slice(0, 20);
  }

  /**
   * 提取未解决问题
   */
  private extractOpenQuestions(messages: Message[]): string[] {
    const questions: string[] = [];
    const lastMessages = messages.slice(-6); // 只看最后几条消息

    for (const msg of lastMessages) {
      const sentences = msg.content.split(/[.。!！\n]/);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < 5 || trimmed.length > 150) continue;

        const hasQuestionKeyword = QUESTION_KEYWORDS.some((kw) =>
          trimmed.includes(kw)
        );

        if (hasQuestionKeyword) {
          questions.push(trimmed);
        }
      }
    }

    return [...new Set(questions)].slice(0, 3);
  }

  /**
   * 构建摘要文本（用于向量检索）
   */
  private buildSummaryText(
    ruleBased: Partial<SessionSummary>,
    llmEnhanced: Partial<SessionSummary>
  ): string {
    const parts: string[] = [];

    // 标题
    const title = llmEnhanced.title || ruleBased.title;
    if (title) parts.push(`标题: ${title}`);

    // 主题
    const topics = [...new Set([
      ...(llmEnhanced.topics || []),
      ...(ruleBased.topics || []),
    ])];
    if (topics.length > 0) {
      parts.push(`主题: ${topics.join(', ')}`);
    }

    // 决策
    const decisions = llmEnhanced.keyDecisions || ruleBased.keyDecisions || [];
    if (decisions.length > 0) {
      parts.push(`关键决策: ${decisions.join('; ')}`);
    }

    // 文件
    const files = ruleBased.codeChanges || [];
    if (files.length > 0) {
      parts.push(`涉及文件: ${files.slice(0, 10).join(', ')}`);
    }

    return parts.join('\n');
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let summarizerInstance: SessionSummarizer | null = null;

export function getSessionSummarizer(): SessionSummarizer {
  if (!summarizerInstance) {
    summarizerInstance = new SessionSummarizer();
  }
  return summarizerInstance;
}

export function initSessionSummarizer(
  config?: Partial<SummarizerConfig>
): SessionSummarizer {
  summarizerInstance = new SessionSummarizer(config);
  return summarizerInstance;
}
