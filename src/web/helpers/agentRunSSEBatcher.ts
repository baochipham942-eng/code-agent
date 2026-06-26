import type { AgentEvent } from '../../shared/contract';
import { EventBatcher } from '../../host/agent/eventBatcher';

export type AgentRunSSEWriter = (event: string, data: unknown) => void;

const agentRunEventSequences = new Map<string, number>();

function nextAgentRunEventSeq(sessionId: string): number {
  const next = (agentRunEventSequences.get(sessionId) || 0) + 1;
  agentRunEventSequences.set(sessionId, next);
  return next;
}

export function attachSessionIdToAgentEventData(
  data: unknown,
  sessionId: string,
  seq?: number,
): unknown {
  const envelope = seq === undefined ? { sessionId } : { sessionId, seq };
  if (Array.isArray(data)) {
    return { items: data, ...envelope };
  }
  if (data && typeof data === 'object') {
    return { ...data, ...envelope };
  }
  return envelope;
}

export function createAgentRunSSEBatcher(
  writeEvent: AgentRunSSEWriter,
  sessionId: string,
): {
  emit: (event: AgentEvent) => void;
  flush: () => void;
  destroy: () => void;
} {
  const batcher = new EventBatcher<AgentEvent>({
    flushInterval: 16,
    maxBatchSize: 50,
    onFlush: (events) => {
      for (const event of events) {
        writeEvent(event.type, attachSessionIdToAgentEventData(
          event.data,
          sessionId,
          nextAgentRunEventSeq(sessionId),
        ));
      }
    },
  });

  return {
    emit: (event) => batcher.emit(event),
    flush: () => batcher.flush(),
    destroy: () => batcher.destroy(),
  };
}

export function resetAgentRunSSESequencesForTests(): void {
  agentRunEventSequences.clear();
}
