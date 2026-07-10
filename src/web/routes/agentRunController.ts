import type { Response } from 'express';
import type { AgentEvent, SessionStatus } from '../../shared/contract';
import { MessageDeltaAccumulator } from '../../host/protocol/messageDeltaAccumulator';
import { createAgentRunSSEBatcher } from '../helpers/agentRunSSEBatcher';
import { broadcastSSE, sendSSE } from '../helpers/sse';
import type { AgentSessionManagerLike } from './agentRouteTypes';
import type { WebRouteLogger } from './routeTypes';
import type { RunHandle } from '../../host/runtime/runContext';

interface AgentRunControllerDeps {
  res: Response;
  runId: string;
  sessionId: string;
  runHandle?: RunHandle;
  logger: WebRouteLogger;
  tryGetSessionManager: () => Promise<AgentSessionManagerLike | null>;
}

function isTerminalErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  const payload = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  return payload.level !== 'warning'
    && payload.severity !== 'warning'
    && payload.terminal !== false;
}

export class AgentRunController {
  private runSettled = false;
  private clientDisconnected = false;
  private runHadTerminalError = false;
  private terminalCompletionEmitted = false;
  private readonly messageAccumulator = new MessageDeltaAccumulator();
  private readonly agentSSEBatcher;

  readonly cancelForDisconnect = (): void => {
    if (this.runSettled || this.clientDisconnected) return;
    this.clientDisconnected = true;
    const runHandle = this.deps.runHandle;
    if (!runHandle) return;
    this.deps.logger.warn(
      `[AgentRouter] SSE client disconnected, cancelling run ${this.deps.runId} for ${this.deps.sessionId}`,
    );
    void runHandle.cancel('user').catch((error) => {
      this.deps.logger.warn(`[AgentRouter] Failed to cancel disconnected run ${this.deps.runId}:`, error);
    });
  };

  constructor(private readonly deps: AgentRunControllerDeps) {
    this.agentSSEBatcher = createAgentRunSSEBatcher(
      (event, data) => this.emitSSE(event, data),
      deps.sessionId,
    );
  }

  get disconnected(): boolean {
    return this.clientDisconnected;
  }

  get hadTerminalError(): boolean {
    return this.runHadTerminalError;
  }

  canWriteSSE(): boolean {
    return !this.deps.res.writableEnded && !this.deps.res.destroyed;
  }

  emitSSE(event: string, data: unknown): void {
    if (!this.canWriteSSE()) return;
    try {
      sendSSE(this.deps.res, event, data);
    } catch (error) {
      this.deps.logger.warn(`[AgentRouter] Failed to write SSE event ${event} for ${this.deps.sessionId}:`, error);
    }
  }

  emitAgentEvent(event: AgentEvent): boolean {
    if (isTerminalErrorEvent(event)) {
      this.runHadTerminalError = true;
    }
    if (event.type === 'agent_complete' || event.type === 'agent_cancelled') {
      if (this.terminalCompletionEmitted) {
        return false;
      }
      this.terminalCompletionEmitted = true;
    }

    const snapshot = this.messageAccumulator.apply(this.deps.sessionId, event);
    if (event.type === 'message_delta' && !snapshot) {
      return false;
    }

    const finalSnapshot = (
      event.type === 'turn_end'
      || event.type === 'agent_complete'
      || event.type === 'agent_cancelled'
    )
      ? this.messageAccumulator.getSnapshot(this.deps.sessionId, true)
      : null;
    if (finalSnapshot) {
      this.agentSSEBatcher.emit({ type: 'message_snapshot', data: finalSnapshot });
    }
    this.agentSSEBatcher.emit(event);
    if (finalSnapshot) {
      this.messageAccumulator.clear(this.deps.sessionId);
    }
    return true;
  }

  flush(): void {
    this.agentSSEBatcher.flush();
  }

  async updateSessionStatus(status: SessionStatus): Promise<void> {
    const updates = { status, updatedAt: Date.now() };
    try {
      const sm = await this.deps.tryGetSessionManager();
      if (sm?.updateSession) {
        await sm.updateSession(this.deps.sessionId, updates);
      } else {
        const { getDatabase } = await import('../../host/services/core/databaseService');
        const db = getDatabase();
        if (db.isReady) {
          db.updateSession(this.deps.sessionId, updates);
        }
      }
      broadcastSSE('session:updated', { sessionId: this.deps.sessionId, updates });
      broadcastSSE('session:list-updated', undefined);
    } catch (error) {
      this.deps.logger.warn(`[AgentRouter] Failed to persist session status ${status} for ${this.deps.sessionId}:`, error);
    }
  }

  markSettled(): void {
    this.runSettled = true;
  }

  destroy(): void {
    this.agentSSEBatcher.destroy();
  }

  endResponseIfOpen(): void {
    if (this.canWriteSSE()) {
      this.deps.res.end();
    }
  }
}
