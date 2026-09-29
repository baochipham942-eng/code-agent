import type { AgentEvent, AgentEventEnvelope } from '../../shared/contract';
import {
  envelopeAgentEvent,
  getAgentEventStreamEpoch,
  nextAgentEventStreamSeq,
  resetAgentEventStreamForTests,
} from '../../host/protocol/agentEventStreamCursor';

// 保留 web 侧入口名；计数与 epoch 在进程内唯一游标上。
export function getWebStreamEpoch(): string {
  return getAgentEventStreamEpoch();
}

export function nextWebAgentEventSeq(sessionId: string): number {
  return nextAgentEventStreamSeq(sessionId);
}

export function envelopeWebAgentEvent(
  sessionId: string,
  event: AgentEvent,
  seq?: number,
): AgentEventEnvelope {
  return envelopeAgentEvent(sessionId, event, seq);
}

export function resetWebAgentEventSequencesForTests(): void {
  resetAgentEventStreamForTests();
}
