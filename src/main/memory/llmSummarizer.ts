// ============================================================================
// LLM Summarizer - LLM 驱动的会话摘要生成
// ============================================================================
// 使用 LLM 生成高质量会话摘要，作为规则提取的增强。
// Week 4 实现：提升摘要质量。
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { getConfigService } from '../services';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_MODELS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type { Message } from '../../shared/types';
import type { SessionSummary } from './sessionSummarizer';

const logger = createLogger('LLMSummarizer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface LLMSummarizerConfig {
  /** 使用的模型提供商 */
  provider?: 'deepseek' | 'openai' | 'claude' | 'zhipu' | 'qwen' | 'moonshot';
  /** 使用的模型名称 */
  model?: string;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<LLMSummarizerConfig> = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  maxTokens: 1000,
  timeout: 30000,
};

const SUMMARIZER_PROMPT = `你是一个会话摘要专家。请分析以下 AI 编程助手与用户的对话，生成结构化摘要。

要求：
1. 标题：一句话概括对话主题（不超过 50 字）
2. 主题标签：提取 3-8 个关键技术词（如框架、语言、功能模块）
3. 关键决策：列出对话中做出的重要决定（最多 5 条）
4. 未解决问题：列出讨论中提到但未解决的问题（最多 3 条）

输出格式（JSON）：
{
  "title": "简洁的标题",
  "topics": ["topic1", "topic2", ...],
  "keyDecisions": ["决策1", "决策2", ...],
  "openQuestions": ["问题1", ...]
}

只输出 JSON，不要其他内容。`;

// ----------------------------------------------------------------------------
// LLM Summarizer
// ----------------------------------------------------------------------------

export class LLMSummarizer {
  private config: Required<LLMSummarizerConfig>;
  private modelRouter: ModelRouter;

  constructor(config?: LLMSummarizerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = new ModelRouter();
  }

  /**
   * 生成会话摘要
   */
  async summarize(messages: Message[]): Promise<Partial<SessionSummary>> {
    // 过滤消息，构建对话文本
    const conversationMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    if (conversationMessages.length < 2) {
      logger.debug('Too few messages for LLM summarization');
      return {};
    }

    // 构建对话文本（限制长度避免超 token）
    const conversationText = this.buildConversationText(conversationMessages);

    try {
      const response = await this.callLLM(conversationText);

      if (!response) {
        logger.warn('LLM returned empty response');
        return {};
      }

      const parsed = this.parseResponse(response);
      logger.info('LLM summarization completed', {
        title: parsed.title,
        topicsCount: parsed.topics?.length || 0,
      });

      return parsed;
    } catch (error) {
      logger.error('LLM summarization failed', { error });
      return {};
    }
  }

  /**
   * 构建对话文本
   */
  private buildConversationText(messages: Message[]): string {
    const lines: string[] = [];
    let totalChars = 0;
    const maxChars = 8000; // 限制输入长度

    for (const msg of messages) {
      const role = msg.role === 'user' ? '用户' : '助手';
      // 截断过长的消息
      let content = msg.content;
      if (content.length > 1000) {
        content = content.substring(0, 1000) + '...[截断]';
      }

      const line = `${role}: ${content}`;

      if (totalChars + line.length > maxChars) {
        lines.push('...[对话过长，已截断]');
        break;
      }

      lines.push(line);
      totalChars += line.length;
    }

    return lines.join('\n\n');
  }

  /**
   * 调用 LLM
   */
  private async callLLM(conversationText: string): Promise<string | null> {
    const configService = getConfigService();
    // 使用 fast 模型进行摘要生成（便宜且够用）
    const fastModel = configService.getModelForCapability('fast');

    // 优先使用配置的提供商，否则用默认
    const provider = fastModel?.provider || this.config.provider;
    const model = fastModel?.model || this.getModelForProvider(provider);

    logger.debug('Calling LLM for summarization', { provider, model });

    const result = await this.modelRouter.chat({
      provider: provider as 'deepseek' | 'openai' | 'claude',
      model,
      messages: [
        { role: 'system', content: SUMMARIZER_PROMPT },
        { role: 'user', content: `请分析以下对话并生成摘要：\n\n${conversationText}` },
      ],
      maxTokens: this.config.maxTokens,
    });

    return result.content;
  }

  /**
   * 获取提供商对应的模型
   */
  private getModelForProvider(provider: string): string {
    // 使用 PROVIDER_REGISTRY 中各 provider 的第一个模型作为默认
    const providerDefaults: Record<string, string> = {
      deepseek: 'deepseek-chat',
      openai: 'gpt-4o-mini',
      claude: 'claude-3-5-haiku-20241022',
      zhipu: DEFAULT_MODELS.quick,
      qwen: 'qwen-turbo',
      moonshot: DEFAULT_MODEL,
    };
    return providerDefaults[provider] || this.config.model;
  }

  /**
   * 解析 LLM 响应
   */
  private parseResponse(response: string): Partial<SessionSummary> {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No JSON found in LLM response');
        return {};
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        title?: string;
        topics?: string[];
        keyDecisions?: string[];
        openQuestions?: string[];
      };

      return {
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t) => typeof t === 'string') : undefined,
        keyDecisions: Array.isArray(parsed.keyDecisions)
          ? parsed.keyDecisions.filter((d) => typeof d === 'string')
          : undefined,
        openQuestions: Array.isArray(parsed.openQuestions)
          ? parsed.openQuestions.filter((q) => typeof q === 'string')
          : undefined,
      };
    } catch (error) {
      logger.error('Failed to parse LLM response', { error, response: response.substring(0, 200) });
      return {};
    }
  }
}

// ----------------------------------------------------------------------------
// Factory Function
// ----------------------------------------------------------------------------

/**
 * 创建 LLM 摘要生成函数（用于 SessionSummarizer 配置）
 */
export function createLLMSummarizer(
  config?: LLMSummarizerConfig
): (messages: Message[]) => Promise<Partial<SessionSummary>> {
  const summarizer = new LLMSummarizer(config);
  return (messages: Message[]) => summarizer.summarize(messages);
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let llmSummarizerInstance: LLMSummarizer | null = null;

export function getLLMSummarizer(): LLMSummarizer {
  if (!llmSummarizerInstance) {
    llmSummarizerInstance = new LLMSummarizer();
  }
  return llmSummarizerInstance;
}

export function initLLMSummarizer(config?: LLMSummarizerConfig): LLMSummarizer {
  llmSummarizerInstance = new LLMSummarizer(config);
  return llmSummarizerInstance;
}
