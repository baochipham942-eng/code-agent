import { ReviewQueueService } from '../../main/evaluation/reviewQueueService';
import type { AgentEngineKind } from '../../shared/contract/agentEngine';
import { getBackgroundTaskLedger } from '../../main/tasks/backgroundTaskLedger';

export type ExternalAgentEngineKind = Extract<AgentEngineKind, 'codex_cli' | 'claude_code'>;

export interface ExternalAgentEngineFailureContext {
  kind: ExternalAgentEngineKind;
  stage: 'launch_policy' | 'adapter_run';
  cwd?: string;
}

interface AgentEngineFailureLogger {
  warn(message: string, ...args: unknown[]): void;
}

function getExternalEngineLabel(kind: ExternalAgentEngineKind): string {
  return kind === 'codex_cli' ? 'Codex CLI' : 'Claude Code';
}

export function recordExternalEngineFailure(
  input: {
    sessionId: string;
    message: string;
    context: ExternalAgentEngineFailureContext;
  },
  logger: AgentEngineFailureLogger,
): void {
  const now = Date.now();
  const label = getExternalEngineLabel(input.context.kind);
  const taskId = `agent-engine:${input.context.kind}:failed:${input.sessionId}`;

  try {
    const ledger = getBackgroundTaskLedger();
    ledger.upsertTask({
      id: taskId,
      kind: 'agent_engine',
      sessionId: input.sessionId,
      source: 'agent_engine',
      title: `${label} failed`,
      summary: 'External Agent Engine failed before a terminal result was recorded.',
      cwd: input.context.cwd,
      status: 'failed',
      updatedAt: now,
      completedAt: now,
      unread: true,
      failure: {
        message: input.message,
        reason: input.context.stage,
        category: 'agent_engine',
      },
      metadata: {
        engine: input.context.kind,
        failureStage: input.context.stage,
      },
    });
    ledger.appendEvent({
      taskId,
      type: 'agent_engine.failed',
      status: 'failed',
      message: input.message,
      timestamp: now,
      data: {
        engine: input.context.kind,
        stage: input.context.stage,
      },
    });
    ledger.queueNotification({
      id: `${taskId}:notification`,
      taskId,
      sessionId: input.sessionId,
      type: 'task_failed',
      title: `${label} failed`,
      message: input.message,
      createdAt: now,
      payload: {
        engine: input.context.kind,
        stage: input.context.stage,
      },
    });
  } catch (error) {
    logger.warn('[AgentRouter] Failed to record external engine failed task:', error);
  }

  try {
    ReviewQueueService.getInstance().enqueueSession({
      sessionId: input.sessionId,
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'capability_health',
        category: 'env_failure',
        summary: input.message,
        confidence: 0.8,
      },
    });
  } catch (error) {
    logger.warn('[AgentRouter] Failed to enqueue external engine failure review:', error);
  }
}
