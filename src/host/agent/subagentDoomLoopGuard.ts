import type { SwarmAgentContextSnapshot } from '../../shared/contract/swarm';
import { createLogger } from '../services/infra/logger';
import { DoomLoopGuard } from './runtime/doomLoopGuard';
import { createRuntimeMessage, type RuntimeMessage } from './subagentExecutorProjection';
import type { SubagentResult } from './subagentExecutorTypes';

const logger = createLogger('SubagentDoomLoopGuard');

type ModelResponse = {
  type: string;
  content?: string;
  thinking?: string;
};

type ModelToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export class SubagentDoomLoopStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentDoomLoopStopError';
  }

  toResult(
    output: string,
    toolsUsed: string[],
    iterations: number,
    tokensUsed: number,
    cost: number,
    agentId: string,
    contextSnapshot: SwarmAgentContextSnapshot,
  ): SubagentResult {
    return {
      success: false,
      output,
      error: this.message,
      toolsUsed: [...new Set(toolsUsed)],
      iterations,
      tokensUsed,
      cost,
      agentId,
      contextSnapshot,
    };
  }
}

export class SubagentDoomLoopGuard {
  private readonly guard = new DoomLoopGuard();
  private pendingNudge?: string;

  handleEmptyOutput(
    response: ModelResponse,
    messages: RuntimeMessage[],
    emitContextSnapshot: () => void,
    persistTelemetryTurn: (assistantResponse: string, thinking?: string) => void,
  ): boolean {
    if (response.type !== 'text' || response.content?.trim()) return false;

    const check = this.guard.recordEmptyOutput();
    persistTelemetryTurn('', response.thinking);
    if (check.action === 'stop') {
      logger.warn('Empty model output limit reached; stopping subagent run');
      throw new SubagentDoomLoopStopError(
        'Subagent stopped by doom-loop guard after repeated empty model output.',
      );
    }

    logger.warn('Empty model output; continuing with doom-loop nudge');
    messages.push(createRuntimeMessage({ role: 'system', content: check.nudge ?? '' }));
    emitContextSnapshot();
    return true;
  }

  recordStep(toolCalls: ModelToolCall[]): void {
    const check = this.guard.recordStep(toolCalls);
    if (check.level === 'doom-loop-abort') {
      logger.warn('Identical tool call repeated after doom-loop nudge; stopping subagent run');
      throw new SubagentDoomLoopStopError(
        'Subagent stopped by doom-loop guard after repeating the same tool call.',
      );
    }
    this.pendingNudge = check.nudge;
    if (check.nudge) logger.warn(`${check.level} detected; queued doom-loop nudge`);
  }

  queueIdleNudge(): void {
    this.pendingNudge = "Are you still working? Report progress or wrap up the current task.";
  }

  injectPendingNudge(messages: RuntimeMessage[]): void {
    if (!this.pendingNudge) return;
    messages.push(createRuntimeMessage({ role: 'system', content: this.pendingNudge }));
    this.pendingNudge = undefined;
  }
}
