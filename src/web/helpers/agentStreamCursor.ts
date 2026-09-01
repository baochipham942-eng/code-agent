import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope } from '../../shared/contract';

const webStreamEpoch = `http:${randomUUID()}`;
const sessionSequences = new Map<string, number>();

export function getWebStreamEpoch(): string {
  return webStreamEpoch;
}

export function nextWebAgentEventSeq(sessionId: string): number {
  const seq = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.set(sessionId, seq);
  return seq;
}

export function envelopeWebAgentEvent(
  sessionId: string,
  event: AgentEvent,
  seq = nextWebAgentEventSeq(sessionId),
): AgentEventEnvelope {
  return {
    ...event,
    streamEpoch: webStreamEpoch,
    sessionId,
    seq,
  } as AgentEventEnvelope;
}

export function resetWebAgentEventSequencesForTests(): void {
  sessionSequences.clear();
}
