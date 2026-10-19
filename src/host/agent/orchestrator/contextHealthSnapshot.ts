// ============================================================================
// 上下文健康快照更新（从 agentOrchestrator.ts 逐字搬出，N-MAXLINES-MINEFIELD-2-FU1-S2）
// ============================================================================

import type { Message } from '../../../shared/contract';
import { SYSTEM_PROMPT } from '../../prompts/builder';
import { getContextHealthService } from '../../context/contextHealthService';
import { getSessionSkillService } from '../../services/skills/sessionSkillService';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

export function updateContextHealthSnapshot(sessionId: string, model: string, messages: Message[]): void {
  try {
    getContextHealthService().update(
      sessionId,
      messages.map((message) => ({
        role: message.role,
        content: message.content || '',
        toolCalls: message.toolCalls,
        toolResults: message.toolResults?.map((result) => ({
          // N-CTXCURRENT: toolCallId 透传，构成算法据此把结果按工具名归桶
          toolCallId: result.toolCallId,
          output: result.output,
          error: result.error,
        })),
        compaction: message.compaction,
      })),
      SYSTEM_PROMPT,
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      { skills: getSessionSkillService().getMountedSkillTokens(sessionId) },
    );
  } catch (error) {
    logger.warn('Failed to update context health after user message:', error);
  }
}
