// ============================================================================
// Memory Hooks - 记忆持久化钩子
// SessionStart: 注入相关记忆
// SessionEnd: 提取并保存学习成果
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { SessionContext, HookExecutionResult } from '../events';
import type { Message } from '../../../shared/types';

const logger = createLogger('MemoryHooks');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 从会话中提取的学习成果
 */
export interface SessionLearning {
  /** 学习类型 */
  type: 'code_pattern' | 'workflow' | 'preference' | 'knowledge' | 'error_fix';
  /** 学习内容 */
  content: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** 来源（工具使用、用户反馈等）*/
  source: 'tool_usage' | 'user_feedback' | 'success_pattern' | 'error_recovery';
  /** 相关上下文 */
  context?: {
    toolsUsed?: string[];
    filesModified?: string[];
    errorFixed?: string;
  };
}

/**
 * 记忆服务接口（解耦依赖）
 */
export interface MemoryServiceInterface {
  add(memory: {
    type: string;
    content: string;
    source: string;
    sessionId?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  search(query: string, options?: { limit?: number; type?: string }): Promise<Array<{
    content: string;
    type: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }>>;
}

// ----------------------------------------------------------------------------
// Session Start Hook - 记忆注入
// ----------------------------------------------------------------------------

/**
 * 会话开始时注入相关记忆
 *
 * 根据会话上下文搜索相关记忆，注入到会话开始的提示中。
 */
export async function sessionStartMemoryHook(
  context: SessionContext,
  memoryService: MemoryServiceInterface | null,
  initialPrompt?: string
): Promise<HookExecutionResult> {
  const startTime = Date.now();

  if (!memoryService) {
    logger.debug('Memory service not available, skipping memory injection');
    return {
      action: 'continue',
      duration: Date.now() - startTime,
    };
  }

  try {
    // 如果有初始提示，搜索相关记忆
    let relevantMemories: Array<{ content: string; type: string; confidence: number }> = [];

    if (initialPrompt) {
      relevantMemories = await memoryService.search(initialPrompt, {
        limit: 5,
        type: 'knowledge',
      });
    }

    // 过滤低置信度记忆
    const highConfidenceMemories = relevantMemories.filter(m => m.confidence > 0.7);

    if (highConfidenceMemories.length === 0) {
      logger.debug('No high-confidence memories found for injection');
      return {
        action: 'continue',
        duration: Date.now() - startTime,
      };
    }

    // 构建注入消息
    const memoryText = highConfidenceMemories
      .map(m => `- [${m.type}] ${m.content}`)
      .join('\n');

    const message = `**相关经验提示**：\n${memoryText}`;

    logger.info(`Injected ${highConfidenceMemories.length} memories into session ${context.sessionId}`);

    return {
      action: 'continue',
      message,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Failed to inject memories:', error);
    return {
      action: 'continue', // Don't block on memory injection failure
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// ----------------------------------------------------------------------------
// Session End Hook - 学习提取
// ----------------------------------------------------------------------------

/**
 * 会话结束时提取并保存学习成果
 *
 * 分析会话中的交互，提取有价值的模式和知识。
 */
export async function sessionEndMemoryHook(
  context: SessionContext,
  memoryService: MemoryServiceInterface | null,
  messages: Message[]
): Promise<HookExecutionResult> {
  const startTime = Date.now();

  if (!memoryService) {
    logger.debug('Memory service not available, skipping learning extraction');
    return {
      action: 'continue',
      duration: Date.now() - startTime,
    };
  }

  try {
    // 提取学习成果
    const learnings = extractSessionLearnings(messages);

    // 过滤低置信度学习
    const significantLearnings = learnings.filter(l => l.confidence > 0.7);

    if (significantLearnings.length === 0) {
      logger.debug('No significant learnings extracted from session');
      return {
        action: 'continue',
        duration: Date.now() - startTime,
      };
    }

    // 持久化到记忆系统
    let savedCount = 0;
    for (const learning of significantLearnings) {
      try {
        await memoryService.add({
          type: learning.type,
          content: learning.content,
          source: `session_extracted:${learning.source}`,
          sessionId: context.sessionId,
          confidence: learning.confidence,
          metadata: learning.context,
        });
        savedCount++;
      } catch (error) {
        logger.warn(`Failed to save learning: ${error}`);
      }
    }

    logger.info(`Persisted ${savedCount}/${significantLearnings.length} learnings from session ${context.sessionId}`);

    return {
      action: 'continue',
      message: `Extracted and saved ${savedCount} learnings from this session`,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Failed to extract learnings:', error);
    return {
      action: 'continue', // Don't block on learning extraction failure
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// ----------------------------------------------------------------------------
// Learning Extraction Logic
// ----------------------------------------------------------------------------

/**
 * 从消息历史中提取学习成果
 */
export function extractSessionLearnings(messages: Message[]): SessionLearning[] {
  const learnings: SessionLearning[] = [];

  if (messages.length < 2) {
    return learnings;
  }

  // 分析工具使用模式
  const toolPatterns = analyzeToolUsagePatterns(messages);
  learnings.push(...toolPatterns);

  // 分析错误恢复模式
  const errorRecoveries = analyzeErrorRecoveries(messages);
  learnings.push(...errorRecoveries);

  // 分析用户偏好
  const preferences = analyzeUserPreferences(messages);
  learnings.push(...preferences);

  // 分析成功完成的任务
  const successes = analyzeSuccessfulTasks(messages);
  learnings.push(...successes);

  return learnings;
}

/**
 * 分析工具使用模式
 */
function analyzeToolUsagePatterns(messages: Message[]): SessionLearning[] {
  const learnings: SessionLearning[] = [];
  const toolSequences: string[][] = [];
  let currentSequence: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      const tools = message.toolCalls.map(tc => tc.name);
      currentSequence.push(...tools);
    } else if (message.role === 'user') {
      if (currentSequence.length >= 2) {
        toolSequences.push([...currentSequence]);
      }
      currentSequence = [];
    }
  }

  // 查找重复的工具序列
  const sequenceMap = new Map<string, number>();
  for (const seq of toolSequences) {
    const key = seq.join(' -> ');
    sequenceMap.set(key, (sequenceMap.get(key) || 0) + 1);
  }

  for (const [sequence, count] of sequenceMap) {
    if (count >= 2) {
      learnings.push({
        type: 'workflow',
        content: `常用工具序列: ${sequence}`,
        confidence: Math.min(0.5 + count * 0.1, 0.9),
        source: 'tool_usage',
        context: {
          toolsUsed: sequence.split(' -> '),
        },
      });
    }
  }

  return learnings;
}

/**
 * 分析错误恢复模式
 */
function analyzeErrorRecoveries(messages: Message[]): SessionLearning[] {
  const learnings: SessionLearning[] = [];

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    const previous = messages[i - 1];

    // 检查是否有错误后的成功恢复
    if (
      previous.role === 'tool' &&
      previous.content?.includes('error') &&
      current.role === 'assistant' &&
      messages[i + 1]?.role === 'tool' &&
      !messages[i + 1]?.content?.includes('error')
    ) {
      const errorContext = previous.content.substring(0, 200);
      const recovery = current.content?.substring(0, 200) || '';

      learnings.push({
        type: 'error_fix',
        content: `错误恢复: ${errorContext} -> ${recovery}`,
        confidence: 0.75,
        source: 'error_recovery',
        context: {
          errorFixed: errorContext,
        },
      });
    }
  }

  return learnings;
}

/**
 * 分析用户偏好
 */
function analyzeUserPreferences(messages: Message[]): SessionLearning[] {
  const learnings: SessionLearning[] = [];
  const userMessages = messages.filter(m => m.role === 'user');

  // 检查编码风格偏好
  const styleKeywords = ['简洁', '详细', '注释', '类型', '测试'];
  for (const keyword of styleKeywords) {
    const mentionCount = userMessages.filter(m =>
      m.content?.includes(keyword)
    ).length;

    if (mentionCount >= 2) {
      learnings.push({
        type: 'preference',
        content: `用户偏好: ${keyword}`,
        confidence: Math.min(0.5 + mentionCount * 0.1, 0.85),
        source: 'user_feedback',
      });
    }
  }

  return learnings;
}

/**
 * 分析成功完成的任务
 */
function analyzeSuccessfulTasks(messages: Message[]): SessionLearning[] {
  const learnings: SessionLearning[] = [];

  // 查找用户表示满意的模式
  const positiveIndicators = ['谢谢', '很好', 'great', 'thanks', '完美', '正确'];
  const userMessages = messages.filter(m => m.role === 'user');

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    const isPositive = positiveIndicators.some(ind =>
      msg.content?.toLowerCase().includes(ind)
    );

    if (isPositive && i > 0) {
      // 回溯找到之前的任务描述
      const previousUserMsg = userMessages[i - 1];
      if (previousUserMsg?.content && previousUserMsg.content.length > 20) {
        learnings.push({
          type: 'knowledge',
          content: `成功完成任务: ${previousUserMsg.content.substring(0, 100)}`,
          confidence: 0.8,
          source: 'success_pattern',
        });
      }
    }
  }

  return learnings;
}
