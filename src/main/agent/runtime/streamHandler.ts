// ============================================================================
// StreamHandler — Model response processing, token accumulation, event emission
// Extracted from ConversationRuntime
// ============================================================================

import type {
  Message,
  AgentEvent,
} from '../../../shared/types';
import type { ModelResponse } from '../../agent/loopTypes';
import {
  estimateModelMessageTokens,
} from '../../context/tokenOptimizer';
import { generateMessageId } from '../../../shared/utils/id';
import { getLangfuseService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector.js';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';

const logger = createLogger('StreamHandler');

export class StreamHandler {
  constructor(
    private ctx: RuntimeContext,
    private contextAssembly: ContextAssembly,
    private runFinalizer: RunFinalizer,
  ) {}

  /**
   * Emit model_response event and accumulate token usage.
   */
  emitModelResponse(response: ModelResponse, inferenceDuration: number): void {
    this.ctx.onEvent({
      type: 'model_response',
      data: {
        model: this.ctx.modelConfig.model,
        provider: this.ctx.modelConfig.provider,
        responseType: response.type,
        duration: inferenceDuration,
        toolCalls: response.toolCalls?.map((tc: any) => tc.name) || [],
        textLength: (response.content || '').length,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
    });

    // Accumulate token usage for task stats
    this.ctx.totalTokensUsed += (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0);
  }

  /**
   * Inject contextual memory from memory service on the first iteration.
   */
  async injectContextualMemory(_userMessage: string): Promise<void> {
    // Memory service removed — no-op
    return;
  }

  /**
   * Inject plan context for the current iteration.
   */
  async injectPlanContext(iterations: number): Promise<void> {
    try {
      if (this.ctx.planningService) {
        const planContext = await this.contextAssembly.buildPlanContextMessage();
        if (planContext) {
          this.ctx.messages = this.ctx.messages.filter(
            (m: Message) => !(m.role === 'system' && typeof m.content === 'string' && m.content.includes('<current-plan>'))
          );
          this.contextAssembly.injectSystemMessage(planContext);
          logger.debug(`[AgentLoop] Plan context injected at iteration ${iterations}`);
        }
      }
    } catch (planContextError) {
      logger.debug(`[AgentLoop] Plan context injection skipped: ${planContextError instanceof Error ? planContextError.message : 'unknown error'}`);
    }
  }

  /**
   * Setup iteration: emit events, reset turn state, inject goal checkpoints.
   */
  setupIteration(
    iterations: number,
    userMessage: string,
    langfuse: ReturnType<typeof getLangfuseService>,
  ): void {
    this.ctx.currentTurnId = generateMessageId();

    this.ctx.currentIterationSpanId = `iteration-${this.ctx.traceId}-${iterations}`;
    langfuse.startSpan(this.ctx.traceId, this.ctx.currentIterationSpanId, {
      name: `Iteration ${iterations}`,
      metadata: { iteration: iterations, turnId: this.ctx.currentTurnId },
    });

    this.ctx.onEvent({
      type: 'turn_start',
      data: { turnId: this.ctx.currentTurnId, iteration: iterations },
    });

    this.ctx.turnStartTime = Date.now();
    this.ctx.toolsUsedInTurn = [];

    if (this.ctx._researchModeActive) {
      this.ctx._researchIterationCount++;
      this.runFinalizer.emitTaskProgress('thinking', `正在搜索 (第${this.ctx._researchIterationCount}轮)`);
    } else {
      this.runFinalizer.emitTaskProgress('thinking', '分析请求中...');
    }

    this.runFinalizer.emitTaskStats(iterations);

    // F1: Goal Re-Injection
    const goalCheckpoint = this.ctx.goalTracker.getGoalCheckpoint(iterations);
    if (goalCheckpoint) {
      this.contextAssembly.injectSystemMessage(goalCheckpoint);
      logger.debug(`[AgentLoop] Goal checkpoint injected at iteration ${iterations}`);
    }
  }
}
