// ============================================================================
// Token Manager - 上下文窗口管理和 Token 计数
// ============================================================================

import type { Message, ModelProvider } from '../../../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface TokenCount {
  input: number;
  output: number;
  total: number;
}

export interface ContextWindow {
  maxTokens: number;
  currentTokens: number;
  reservedForOutput: number;
  availableForInput: number;
}

export interface PruneResult {
  originalCount: number;
  prunedCount: number;
  removedMessages: number;
  tokensSaved: number;
}

// 不同模型的上下文窗口大小
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // DeepSeek
  'deepseek-chat': 64000,
  'deepseek-coder': 64000,
  'deepseek-reasoner': 64000,
  // Claude
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  // Groq
  'llama-3.3-70b-versatile': 128000,
  'llama-3.1-8b-instant': 128000,
  'mixtral-8x7b-32768': 32768,
  // Default
  'default': 8000,
};

// ----------------------------------------------------------------------------
// Token Counter (简化实现，生产环境应使用 tiktoken)
// ----------------------------------------------------------------------------

/**
 * 简化的 token 计数
 * 规则：约 4 个字符 = 1 token (英文)，中文约 1.5 字符 = 1 token
 */
function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // 非中文字符数
  const otherChars = text.length - chineseChars;

  // 中文字符约 1.5 字符/token，其他约 4 字符/token
  const chineseTokens = Math.ceil(chineseChars / 1.5);
  const otherTokens = Math.ceil(otherChars / 4);

  return chineseTokens + otherTokens;
}

/**
 * 计算消息的 token 数
 */
function countMessageTokens(message: Message): number {
  let tokens = 0;

  // 角色标记
  tokens += 4; // <role>

  // 内容
  tokens += estimateTokens(message.content);

  // 工具调用
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      tokens += estimateTokens(tc.name);
      tokens += estimateTokens(JSON.stringify(tc.arguments));
      tokens += 10; // 结构开销
    }
  }

  // 工具结果
  if (message.toolResults) {
    for (const tr of message.toolResults) {
      tokens += estimateTokens(tr.output || '');
      tokens += estimateTokens(tr.error || '');
      tokens += 10; // 结构开销
    }
  }

  return tokens;
}

// ----------------------------------------------------------------------------
// Token Manager
// ----------------------------------------------------------------------------

export class TokenManager {
  private model: string;
  private maxContextTokens: number;
  private reservedOutputTokens: number;
  private usageHistory: TokenCount[] = [];

  constructor(model: string = 'default', reservedOutputTokens: number = 4096) {
    this.model = model;
    this.maxContextTokens = MODEL_CONTEXT_LIMITS[model] || MODEL_CONTEXT_LIMITS['default'];
    this.reservedOutputTokens = reservedOutputTokens;
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  setModel(model: string): void {
    this.model = model;
    this.maxContextTokens = MODEL_CONTEXT_LIMITS[model] || MODEL_CONTEXT_LIMITS['default'];
  }

  setReservedOutputTokens(tokens: number): void {
    this.reservedOutputTokens = tokens;
  }

  getContextLimit(): number {
    return this.maxContextTokens;
  }

  // --------------------------------------------------------------------------
  // Token Counting
  // --------------------------------------------------------------------------

  /**
   * 估算文本的 token 数
   */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * 计算单条消息的 token 数
   */
  countMessageTokens(message: Message): number {
    return countMessageTokens(message);
  }

  /**
   * 计算消息列表的总 token 数
   */
  countMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += countMessageTokens(msg);
    }
    // 加上对话结构开销
    total += messages.length * 3;
    return total;
  }

  /**
   * 计算 system prompt 的 token 数
   */
  countSystemPromptTokens(systemPrompt: string): number {
    return estimateTokens(systemPrompt) + 4; // +4 for system role tag
  }

  // --------------------------------------------------------------------------
  // Context Window Management
  // --------------------------------------------------------------------------

  /**
   * 获取当前上下文窗口状态
   */
  getContextWindow(messages: Message[], systemPrompt: string): ContextWindow {
    const systemTokens = this.countSystemPromptTokens(systemPrompt);
    const messagesTokens = this.countMessagesTokens(messages);
    const currentTokens = systemTokens + messagesTokens;

    return {
      maxTokens: this.maxContextTokens,
      currentTokens,
      reservedForOutput: this.reservedOutputTokens,
      availableForInput: this.maxContextTokens - currentTokens - this.reservedOutputTokens,
    };
  }

  /**
   * 检查是否需要裁剪上下文
   */
  needsPruning(messages: Message[], systemPrompt: string): boolean {
    const window = this.getContextWindow(messages, systemPrompt);
    return window.availableForInput < 0;
  }

  /**
   * 裁剪消息以适应上下文窗口
   * 策略：保留最近的消息，移除最早的消息
   */
  pruneMessages(
    messages: Message[],
    systemPrompt: string,
    options: {
      keepFirstN?: number; // 保留前 N 条消息（通常是重要的初始上下文）
      keepLastN?: number; // 至少保留最后 N 条消息
      targetUtilization?: number; // 目标利用率 (0-1)
    } = {}
  ): { messages: Message[]; result: PruneResult } {
    const { keepFirstN = 0, keepLastN = 4, targetUtilization = 0.8 } = options;

    const originalCount = this.countMessagesTokens(messages);
    const systemTokens = this.countSystemPromptTokens(systemPrompt);
    const targetTokens = Math.floor(
      (this.maxContextTokens - this.reservedOutputTokens) * targetUtilization
    );
    const availableForMessages = targetTokens - systemTokens;

    if (originalCount <= availableForMessages) {
      // 不需要裁剪
      return {
        messages,
        result: {
          originalCount,
          prunedCount: originalCount,
          removedMessages: 0,
          tokensSaved: 0,
        },
      };
    }

    // 分离要保留的消息
    const firstMessages = messages.slice(0, keepFirstN);
    const lastMessages = messages.slice(-keepLastN);
    const middleMessages = messages.slice(keepFirstN, -keepLastN || undefined);

    // 计算固定保留部分的 token
    const firstTokens = this.countMessagesTokens(firstMessages);
    const lastTokens = this.countMessagesTokens(lastMessages);
    const fixedTokens = firstTokens + lastTokens;

    // 可用于中间消息的 token
    const availableForMiddle = availableForMessages - fixedTokens;

    // 从最新的中间消息开始保留
    const keptMiddle: Message[] = [];
    let middleTokens = 0;

    for (let i = middleMessages.length - 1; i >= 0; i--) {
      const msgTokens = countMessageTokens(middleMessages[i]);
      if (middleTokens + msgTokens <= availableForMiddle) {
        keptMiddle.unshift(middleMessages[i]);
        middleTokens += msgTokens;
      }
    }

    // 组合结果
    const prunedMessages = [...firstMessages, ...keptMiddle, ...lastMessages];
    const prunedCount = this.countMessagesTokens(prunedMessages);

    return {
      messages: prunedMessages,
      result: {
        originalCount,
        prunedCount,
        removedMessages: messages.length - prunedMessages.length,
        tokensSaved: originalCount - prunedCount,
      },
    };
  }

  /**
   * 智能摘要裁剪 - 将旧消息压缩成摘要
   * 注意：这需要调用 LLM，是异步操作
   */
  async summarizeAndPrune(
    messages: Message[],
    systemPrompt: string,
    summarizer: (messages: Message[]) => Promise<string>,
    options: {
      summaryThreshold?: number; // 超过多少消息才进行摘要
      keepRecentN?: number; // 保留最近 N 条不摘要
    } = {}
  ): Promise<{ messages: Message[]; summary: string | null }> {
    const { summaryThreshold = 20, keepRecentN = 10 } = options;

    if (messages.length <= summaryThreshold) {
      return { messages, summary: null };
    }

    // 分离要摘要的消息和要保留的消息
    const toSummarize = messages.slice(0, -keepRecentN);
    const toKeep = messages.slice(-keepRecentN);

    // 生成摘要
    const summary = await summarizer(toSummarize);

    // 创建摘要消息
    const summaryMessage: Message = {
      id: `summary_${Date.now()}`,
      role: 'system',
      content: `[Previous conversation summary]\n${summary}`,
      timestamp: toSummarize[toSummarize.length - 1]?.timestamp || Date.now(),
    };

    return {
      messages: [summaryMessage, ...toKeep],
      summary,
    };
  }

  // --------------------------------------------------------------------------
  // Usage Tracking
  // --------------------------------------------------------------------------

  /**
   * 记录 token 使用量
   */
  recordUsage(input: number, output: number): void {
    this.usageHistory.push({
      input,
      output,
      total: input + output,
    });

    // 只保留最近 1000 条记录
    if (this.usageHistory.length > 1000) {
      this.usageHistory = this.usageHistory.slice(-1000);
    }
  }

  /**
   * 获取使用统计
   */
  getUsageStats(): {
    totalInput: number;
    totalOutput: number;
    total: number;
    averagePerRequest: number;
    requestCount: number;
  } {
    const totalInput = this.usageHistory.reduce((sum, u) => sum + u.input, 0);
    const totalOutput = this.usageHistory.reduce((sum, u) => sum + u.output, 0);
    const total = totalInput + totalOutput;
    const requestCount = this.usageHistory.length;

    return {
      totalInput,
      totalOutput,
      total,
      averagePerRequest: requestCount > 0 ? Math.round(total / requestCount) : 0,
      requestCount,
    };
  }

  /**
   * 清空使用记录
   */
  clearUsageHistory(): void {
    this.usageHistory = [];
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /**
   * 截断文本到指定 token 数
   */
  truncateToTokens(text: string, maxTokens: number): string {
    const currentTokens = estimateTokens(text);
    if (currentTokens <= maxTokens) {
      return text;
    }

    // 估算需要保留的字符数
    const ratio = maxTokens / currentTokens;
    const targetLength = Math.floor(text.length * ratio * 0.95); // 留 5% 余量

    return text.slice(0, targetLength) + '...';
  }

  /**
   * 检查消息是否可以添加到上下文
   */
  canAddMessage(
    existingMessages: Message[],
    newMessage: Message,
    systemPrompt: string
  ): boolean {
    const newMessageTokens = countMessageTokens(newMessage);
    const window = this.getContextWindow(existingMessages, systemPrompt);

    return window.availableForInput >= newMessageTokens;
  }
}

// ----------------------------------------------------------------------------
// Singleton Factory
// ----------------------------------------------------------------------------

const tokenManagers: Map<string, TokenManager> = new Map();

export function getTokenManager(model: string = 'default'): TokenManager {
  if (!tokenManagers.has(model)) {
    tokenManagers.set(model, new TokenManager(model));
  }
  return tokenManagers.get(model)!;
}
