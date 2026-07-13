// ============================================================================
// StreamHandler — Model response processing, token accumulation, event emission
// Extracted from ConversationRuntime
// ============================================================================

import type {
  Message,
  ToolCall,
} from '../../../shared/contract';
import type { ModelResponse } from '../../agent/loopTypes';
import { generateMessageId } from '../../../shared/utils/id';
import { getLangfuseService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
} from '../../telemetry/runTraceContext';

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
    const actualProvider = response.actualProvider ?? response.fallback?.to.provider ?? this.ctx.modelConfig.provider;
    const actualModel = response.actualModel ?? response.fallback?.to.model ?? this.ctx.modelConfig.model;
    this.ctx.onEvent({
      type: 'model_response',
      data: {
        model: actualModel,
        provider: actualProvider,
        requestedModel: this.ctx.modelConfig.model,
        requestedProvider: this.ctx.modelConfig.provider,
        fallback: response.fallback,
        responseType: response.type,
        duration: inferenceDuration,
        toolCalls: response.toolCalls?.map((tc: ToolCall) => tc.name) || [],
        textLength: (response.content || '').length,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        runtimeDiagnostics: response.runtimeDiagnostics,
      },
    });

    // Accumulate token usage for task stats
    const inputTokens = response.usage?.inputTokens || 0;
    const outputTokens = response.usage?.outputTokens || 0;
    this.ctx.stats.addTokenUsage(inputTokens, outputTokens);
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
   * Flush runtime diagnostics into the assistant thinking stream once a turn exists.
   */
  private flushRuntimeDiagnostics(): void {
    const diagnostics = this.ctx.stats.drainDiagnostics();
    for (const diagnostic of diagnostics) {
      this.ctx.onEvent({
        type: 'stream_reasoning',
        data: {
          content: `\n[runtime] ${diagnostic}\n`,
          turnId: this.ctx.turn.currentTurnId,
          ...(this.ctx.historyVisibility === 'meta' ? { isMeta: true } : {}),
        },
      });
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
    const activeRunTrace = getActiveRunTraceContext() ?? this.ctx.runTraceContext;
    const iterationSpanId = activeRunTrace
      ? createChildRunTraceContext(activeRunTrace, { agentId: this.ctx.agentId }).spanId
      : `iteration-${this.ctx.stats.traceId}-${iterations}`;
    this.ctx.turn.beginTurn(generateMessageId(), iterationSpanId);
    langfuse.startSpan(this.ctx.stats.traceId, this.ctx.turn.currentIterationSpanId, {
      name: `Iteration ${iterations}`,
      metadata: { iteration: iterations, turnId: this.ctx.turn.currentTurnId },
    });

    this.ctx.onEvent({
      type: 'turn_start',
      data: {
        turnId: this.ctx.turn.currentTurnId,
        iteration: iterations,
        ...(this.ctx.historyVisibility === 'meta' ? { isMeta: true } : {}),
      },
    });
    this.flushRuntimeDiagnostics();

    this.ctx.turn.markTurnStart();

    if (this.ctx.turn.researchModeActive) {
      const researchRound = this.ctx.turn.incrementResearchIteration();
      this.runFinalizer.emitTaskProgress('thinking', `正在搜索 (第${researchRound}轮)`);
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
