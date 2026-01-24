// ============================================================================
// Pattern Extractor - 从会话中提取可复用的模式
// ============================================================================

import type { Message, ToolCall } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PatternExtractor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 提取的模式类型
 */
export type PatternType =
  | 'code_pattern'      // 代码模式（常用的代码结构）
  | 'workflow'          // 工作流模式（工具使用序列）
  | 'preference'        // 用户偏好
  | 'knowledge'         // 项目知识
  | 'error_recovery';   // 错误恢复模式

/**
 * 提取的模式
 */
export interface ExtractedPattern {
  /** 模式类型 */
  type: PatternType;
  /** 模式内容 */
  content: string;
  /** 模式上下文 */
  context: {
    sessionId: string;
    toolsUsed: string[];
    filesModified: string[];
    successIndicators: string[];
  };
  /** 置信度 (0-1) */
  confidence: number;
  /** 出现频率 */
  frequency: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 工具执行记录
 */
export interface ToolExecution {
  /** 工具名称 */
  name: string;
  /** 工具输入 */
  input: unknown;
  /** 工具输出 */
  output?: unknown;
  /** 是否成功 */
  success: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 执行时长 */
  duration?: number;
}

/**
 * 提取配置
 */
export interface ExtractionConfig {
  /** 最小置信度阈值 */
  minConfidence: number;
  /** 是否提取工作流 */
  extractWorkflows: boolean;
  /** 是否提取代码模式 */
  extractCodePatterns: boolean;
  /** 是否提取错误恢复 */
  extractErrorRecoveries: boolean;
  /** 是否提取用户偏好 */
  extractPreferences: boolean;
  /** 最大提取数量 */
  maxPatterns: number;
}

// ----------------------------------------------------------------------------
// Default Config
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: ExtractionConfig = {
  minConfidence: 0.6,
  extractWorkflows: true,
  extractCodePatterns: true,
  extractErrorRecoveries: true,
  extractPreferences: true,
  maxPatterns: 20,
};

// ----------------------------------------------------------------------------
// Pattern Extractor
// ----------------------------------------------------------------------------

/**
 * 模式提取器
 *
 * 从会话消息和工具执行记录中提取可复用的模式。
 */
export class PatternExtractor {
  private config: ExtractionConfig;

  constructor(config?: Partial<ExtractionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从会话中提取模式
   */
  async extractFromSession(
    sessionId: string,
    messages: Message[],
    toolExecutions?: ToolExecution[]
  ): Promise<ExtractedPattern[]> {
    const patterns: ExtractedPattern[] = [];
    const startTime = Date.now();

    logger.info(`Extracting patterns from session ${sessionId}`, {
      messageCount: messages.length,
      toolExecutionCount: toolExecutions?.length || 0,
    });

    try {
      // 1. 提取工作流模式
      if (this.config.extractWorkflows) {
        const workflows = this.extractWorkflowPatterns(sessionId, messages, toolExecutions);
        patterns.push(...workflows);
      }

      // 2. 提取代码模式
      if (this.config.extractCodePatterns) {
        const codePatterns = this.extractCodePatterns(sessionId, messages);
        patterns.push(...codePatterns);
      }

      // 3. 提取错误恢复模式
      if (this.config.extractErrorRecoveries) {
        const errorRecoveries = this.extractErrorRecoveryPatterns(sessionId, messages);
        patterns.push(...errorRecoveries);
      }

      // 4. 提取用户偏好
      if (this.config.extractPreferences) {
        const preferences = this.extractPreferencePatterns(sessionId, messages);
        patterns.push(...preferences);
      }

      // 过滤低置信度模式
      const filteredPatterns = patterns
        .filter(p => p.confidence >= this.config.minConfidence)
        .slice(0, this.config.maxPatterns);

      logger.info(`Extracted ${filteredPatterns.length} patterns from session`, {
        sessionId,
        duration: Date.now() - startTime,
        byType: this.countByType(filteredPatterns),
      });

      return filteredPatterns;
    } catch (error) {
      logger.error('Pattern extraction failed:', error);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Workflow Pattern Extraction
  // --------------------------------------------------------------------------

  /**
   * 提取工作流模式
   */
  private extractWorkflowPatterns(
    sessionId: string,
    messages: Message[],
    toolExecutions?: ToolExecution[]
  ): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];
    const toolSequences: string[][] = [];
    let currentSequence: string[] = [];
    const filesModified = new Set<string>();

    // 从消息中提取工具调用序列
    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          currentSequence.push(toolCall.name);

          // 记录修改的文件
          const filePath = toolCall.arguments?.file_path as string;
          if (filePath) {
            filesModified.add(filePath);
          }
        }
      } else if (message.role === 'user' && currentSequence.length >= 2) {
        // 用户消息表示一个任务的结束
        toolSequences.push([...currentSequence]);
        currentSequence = [];
      }
    }

    // 如果还有未结束的序列
    if (currentSequence.length >= 2) {
      toolSequences.push(currentSequence);
    }

    // 统计序列出现频率
    const sequenceFrequency = new Map<string, { count: number; tools: string[] }>();
    for (const seq of toolSequences) {
      const key = seq.join(' -> ');
      const existing = sequenceFrequency.get(key);
      if (existing) {
        existing.count++;
      } else {
        sequenceFrequency.set(key, { count: 1, tools: seq });
      }
    }

    // 创建模式
    for (const [sequence, { count, tools }] of sequenceFrequency) {
      if (count >= 1 || tools.length >= 3) {
        const confidence = Math.min(0.5 + count * 0.1 + tools.length * 0.05, 0.95);
        patterns.push({
          type: 'workflow',
          content: `工具序列: ${sequence}`,
          context: {
            sessionId,
            toolsUsed: tools,
            filesModified: Array.from(filesModified),
            successIndicators: [],
          },
          confidence,
          frequency: count,
          timestamp: Date.now(),
        });
      }
    }

    // 从 toolExecutions 提取成功的工作流
    if (toolExecutions && toolExecutions.length >= 2) {
      const successfulTools = toolExecutions
        .filter(t => t.success)
        .map(t => t.name);

      if (successfulTools.length >= 3) {
        patterns.push({
          type: 'workflow',
          content: `成功工具序列: ${successfulTools.join(' -> ')}`,
          context: {
            sessionId,
            toolsUsed: successfulTools,
            filesModified: Array.from(filesModified),
            successIndicators: ['all_success'],
          },
          confidence: 0.8,
          frequency: 1,
          timestamp: Date.now(),
        });
      }
    }

    return patterns;
  }

  // --------------------------------------------------------------------------
  // Code Pattern Extraction
  // --------------------------------------------------------------------------

  /**
   * 提取代码模式
   */
  private extractCodePatterns(
    sessionId: string,
    messages: Message[]
  ): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];
    const codeBlocks: Array<{ content: string; language: string; file?: string }> = [];

    // 从助手消息中提取代码块
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.content) continue;

      // 匹配代码块
      const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
      let match;
      while ((match = codeBlockRegex.exec(message.content)) !== null) {
        codeBlocks.push({
          language: match[1] || 'text',
          content: match[2],
        });
      }

      // 从工具调用中提取代码
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          if (toolCall.name === 'write_file' || toolCall.name === 'edit_file') {
            const content = toolCall.arguments?.content as string;
            const filePath = toolCall.arguments?.file_path as string;
            if (content && content.length > 50) {
              const language = this.inferLanguage(filePath);
              codeBlocks.push({
                language,
                content: content.substring(0, 500), // 限制长度
                file: filePath,
              });
            }
          }
        }
      }
    }

    // 分析代码模式
    for (const block of codeBlocks) {
      const codePatterns = this.analyzeCodeBlock(block.content, block.language);
      for (const pattern of codePatterns) {
        patterns.push({
          type: 'code_pattern',
          content: `${block.language}: ${pattern}`,
          context: {
            sessionId,
            toolsUsed: ['write_file', 'edit_file'],
            filesModified: block.file ? [block.file] : [],
            successIndicators: [],
          },
          confidence: 0.7,
          frequency: 1,
          timestamp: Date.now(),
        });
      }
    }

    return patterns;
  }

  /**
   * 分析代码块中的模式
   */
  private analyzeCodeBlock(content: string, language: string): string[] {
    const patterns: string[] = [];

    // TypeScript/JavaScript 模式
    if (['typescript', 'javascript', 'ts', 'js'].includes(language)) {
      // 检测常用模式
      if (content.includes('async') && content.includes('await')) {
        patterns.push('async/await 异步模式');
      }
      if (content.includes('try {') && content.includes('catch')) {
        patterns.push('try-catch 错误处理');
      }
      if (content.includes('interface ') || content.includes('type ')) {
        patterns.push('TypeScript 类型定义');
      }
      if (content.includes('useState') || content.includes('useEffect')) {
        patterns.push('React Hooks 使用');
      }
      if (content.includes('export default') || content.includes('export {')) {
        patterns.push('ES6 模块导出');
      }
    }

    // 通用模式
    if (content.includes('// TODO') || content.includes('// FIXME')) {
      patterns.push('TODO/FIXME 注释');
    }
    if (content.match(/\/\*\*[\s\S]*?\*\//)) {
      patterns.push('JSDoc 文档注释');
    }

    return patterns;
  }

  /**
   * 从文件路径推断语言
   */
  private inferLanguage(filePath?: string): string {
    if (!filePath) return 'text';

    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
    };

    return langMap[ext || ''] || 'text';
  }

  // --------------------------------------------------------------------------
  // Error Recovery Pattern Extraction
  // --------------------------------------------------------------------------

  /**
   * 提取错误恢复模式
   */
  private extractErrorRecoveryPatterns(
    sessionId: string,
    messages: Message[]
  ): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    for (let i = 1; i < messages.length; i++) {
      const current = messages[i];
      const previous = messages[i - 1];

      // 检查是否有工具错误
      if (
        previous.role === 'tool' &&
        previous.content &&
        (previous.content.toLowerCase().includes('error') ||
          previous.content.toLowerCase().includes('failed') ||
          previous.content.toLowerCase().includes('exception'))
      ) {
        // 检查下一个消息是否是恢复尝试
        if (current.role === 'assistant') {
          const nextToolMsg = messages[i + 1];
          const recovered =
            nextToolMsg?.role === 'tool' &&
            nextToolMsg.content &&
            !nextToolMsg.content.toLowerCase().includes('error');

          if (recovered) {
            const errorSummary = previous.content.substring(0, 100);
            const recoverySummary = current.content?.substring(0, 100) || '';
            const toolsUsed = current.toolCalls?.map(tc => tc.name) || [];

            patterns.push({
              type: 'error_recovery',
              content: `错误: ${errorSummary}\n恢复: ${recoverySummary}`,
              context: {
                sessionId,
                toolsUsed,
                filesModified: [],
                successIndicators: ['recovered'],
              },
              confidence: 0.75,
              frequency: 1,
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    return patterns;
  }

  // --------------------------------------------------------------------------
  // Preference Pattern Extraction
  // --------------------------------------------------------------------------

  /**
   * 提取用户偏好模式
   */
  private extractPreferencePatterns(
    sessionId: string,
    messages: Message[]
  ): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];
    const userMessages = messages.filter(m => m.role === 'user');

    // 偏好关键词及其类别
    const preferenceKeywords: Record<string, string[]> = {
      '代码风格': ['简洁', '详细', '注释', '文档', '清晰', 'clean', 'readable'],
      '语言偏好': ['中文', '英文', 'English', 'Chinese'],
      '测试偏好': ['测试', '单元测试', 'test', 'unit test', 'coverage'],
      '类型偏好': ['类型', 'TypeScript', 'type', 'interface'],
      '格式偏好': ['格式', '缩进', 'format', 'prettier', 'eslint'],
    };

    for (const [category, keywords] of Object.entries(preferenceKeywords)) {
      const mentionCount = userMessages.filter(m =>
        keywords.some(kw => m.content?.toLowerCase().includes(kw.toLowerCase()))
      ).length;

      if (mentionCount >= 2) {
        patterns.push({
          type: 'preference',
          content: `${category}偏好（提及 ${mentionCount} 次）`,
          context: {
            sessionId,
            toolsUsed: [],
            filesModified: [],
            successIndicators: keywords.filter(kw =>
              userMessages.some(m => m.content?.toLowerCase().includes(kw.toLowerCase()))
            ),
          },
          confidence: Math.min(0.5 + mentionCount * 0.1, 0.9),
          frequency: mentionCount,
          timestamp: Date.now(),
        });
      }
    }

    // 检测正面反馈模式
    const positiveIndicators = ['谢谢', '很好', 'great', 'thanks', 'perfect', '完美', 'excellent'];
    const positiveCount = userMessages.filter(m =>
      positiveIndicators.some(ind => m.content?.toLowerCase().includes(ind.toLowerCase()))
    ).length;

    if (positiveCount >= 1) {
      patterns.push({
        type: 'preference',
        content: `用户满意度高（正面反馈 ${positiveCount} 次）`,
        context: {
          sessionId,
          toolsUsed: [],
          filesModified: [],
          successIndicators: ['positive_feedback'],
        },
        confidence: 0.8,
        frequency: positiveCount,
        timestamp: Date.now(),
      });
    }

    return patterns;
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /**
   * 按类型统计模式数量
   */
  private countByType(patterns: ExtractedPattern[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const pattern of patterns) {
      counts[pattern.type] = (counts[pattern.type] || 0) + 1;
    }
    return counts;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let extractorInstance: PatternExtractor | null = null;

/**
 * 获取 PatternExtractor 单例
 */
export function getPatternExtractor(): PatternExtractor {
  if (!extractorInstance) {
    extractorInstance = new PatternExtractor();
  }
  return extractorInstance;
}

/**
 * 创建新的 PatternExtractor 实例
 */
export function createPatternExtractor(config?: Partial<ExtractionConfig>): PatternExtractor {
  return new PatternExtractor(config);
}
