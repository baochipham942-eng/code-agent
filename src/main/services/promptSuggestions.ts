// ============================================================================
// Prompt Suggestions Service - 智能提示建议
// ============================================================================

import { createLogger } from './infra/logger';

const logger = createLogger('PromptSuggestions');

export interface PromptSuggestion {
  id: string;
  text: string;
  source: 'context' | 'git' | 'history' | 'files';
  category?: 'plan_step' | 'desktop_task' | 'workspace_signal';
  timestampMs?: number;
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Generate context-aware follow-up suggestions using LLM
 * Called after each assistant turn completes
 */
export async function generateContextSuggestions(
  messages: Array<{ role: string; content?: string }>,
): Promise<PromptSuggestion[]> {
  try {
    // Extract recent conversation context (last 3 turns max)
    const recentMessages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-6) // last 3 pairs
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${(m.content || '').slice(0, 300)}`)
      .join('\n');

    if (!recentMessages) return [];

    const { quickTask } = await import('../model/quickModel');

    const prompt = `根据以下对话，生成 2-3 个用户可能的后续提问或指令。要求：
- 每行一个建议，不要编号
- 简短（15 字以内），以动词开头
- 基于对话上下文，是合理的下一步操作
- 不要重复已经完成的事情

对话：
${recentMessages}

后续建议：`;

    const result = await quickTask(prompt);
    if (!result.success || !result.content) return [];

    const lines = result.content
      .split('\n')
      .map(l => l.replace(/^[-•\d.]\s*/, '').trim())
      .filter(l => l.length > 2 && l.length < 50);

    return lines.slice(0, 3).map((text, i) => ({
      id: `ctx-${i}`,
      text,
      source: 'context' as const,
    }));
  } catch (error) {
    logger.debug('Failed to generate context suggestions', { error });
    return [];
  }
}
