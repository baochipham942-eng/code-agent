import type { AgentEvent, AgentEventEnvelope } from '../../shared/contract';
import { envelopeAgentEvent } from './agentEventStreamCursor';

// TaskManager / 无 local sink 的外部引擎与 /api/run 共用同一套 epoch 和 seq。
export function envelopeRendererAgentEvent(
  sessionId: string,
  event: AgentEvent,
): AgentEventEnvelope {
  return envelopeAgentEvent(sessionId, event);
}

