import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope } from '../../shared/contract';

const rendererStreamEpoch = `native:${randomUUID()}`;
const rendererEventSequences = new Map<string, number>();

export function envelopeRendererAgentEvent(
  sessionId: string,
  event: AgentEvent,
): AgentEventEnvelope {
  const seq = (rendererEventSequences.get(sessionId) ?? 0) + 1;
  rendererEventSequences.set(sessionId, seq);
  return {
    ...event,
    streamEpoch: rendererStreamEpoch,
    sessionId,
    seq,
  } as AgentEventEnvelope;
}
