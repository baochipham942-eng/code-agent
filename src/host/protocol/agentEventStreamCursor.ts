import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope } from '../../shared/contract';

// Web 模式里 TaskManager → /api/events 与 /api/run（直连或镜像）进同一个
// 渲染层派发器。epoch 与 per-session seq 只保留一套，交错才不会被当成换代或空洞。
// 进程重启会重新装载本模块，epoch 随之换新。调用方已持有的 seq（镜像复用
// batcher 分配的号）不再另取一号。
const streamEpoch = `http:${randomUUID()}`;
const sessionSequences = new Map<string, number>();

export function getAgentEventStreamEpoch(): string {
  return streamEpoch;
}

export function nextAgentEventStreamSeq(sessionId: string): number {
  const seq = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.set(sessionId, seq);
  return seq;
}

export function envelopeAgentEvent(
  sessionId: string,
  event: AgentEvent,
  seq?: number,
): AgentEventEnvelope {
  return {
    ...event,
    streamEpoch,
    sessionId,
    seq: seq ?? nextAgentEventStreamSeq(sessionId),
  } as AgentEventEnvelope;
}

export function resetAgentEventStreamForTests(): void {
  sessionSequences.clear();
}
