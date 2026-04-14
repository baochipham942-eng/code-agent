// ============================================================================
// SSE broadcast infrastructure
// ============================================================================

import http from 'http';
import type { Response } from 'express';

/** Registry of active SSE clients */
export const sseClients = new Set<Response>();

/**
 * 重放缓冲区大小。覆盖典型断线窗口内 swarm + agent 事件的峰值吞吐。
 * ADR-010 #6：客户端重连时凭 Last-Event-ID 拉回错过的事件。
 */
const SSE_REPLAY_BUFFER_SIZE = 256;

interface BufferedSSEEvent {
  id: number;
  channel: string;
  args: unknown;
}

let nextSSEEventId = 0;
const sseReplayBuffer: BufferedSSEEvent[] = [];

function pushReplayBuffer(entry: BufferedSSEEvent): void {
  sseReplayBuffer.push(entry);
  if (sseReplayBuffer.length > SSE_REPLAY_BUFFER_SIZE) {
    sseReplayBuffer.splice(0, sseReplayBuffer.length - SSE_REPLAY_BUFFER_SIZE);
  }
}

function serializeEvent(entry: BufferedSSEEvent): string {
  const payload = JSON.stringify({ channel: entry.channel, args: entry.args });
  return `id: ${entry.id}\ndata: ${payload}\n\n`;
}

/**
 * 向所有 SSE 客户端推送事件。事件被分配单调递增的 id，同时写入 ring buffer
 * 以便客户端重连时按 Last-Event-ID 重放。
 */
export function broadcastSSE(channel: string, args: unknown): void {
  const entry: BufferedSSEEvent = { id: ++nextSSEEventId, channel, args };
  pushReplayBuffer(entry);
  const payload = serializeEvent(entry);
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * 向单个 SSE 响应写入一条事件（不进 replay buffer）。
 */
export function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 客户端重连时调用：把 replay buffer 里 id 大于 lastEventId 的事件按顺序
 * 写入响应。返回已重放的事件数量。
 *
 * 如果 lastEventId 已经落在 buffer 头之前（ring buffer 已轮转覆盖），
 * 返回 -1 表示数据丢失 — 调用方可以据此决定是否提示 renderer 刷新。
 */
export function replayFromLastEventId(res: Response, lastEventId: number): number {
  if (sseReplayBuffer.length === 0) {
    return lastEventId >= 0 ? 0 : 0;
  }
  const oldest = sseReplayBuffer[0].id;
  if (lastEventId < oldest - 1) {
    return -1;
  }
  let replayed = 0;
  for (const entry of sseReplayBuffer) {
    if (entry.id > lastEventId) {
      try {
        res.write(serializeEvent(entry));
        replayed += 1;
      } catch {
        // 对端已关闭，交给 close 事件清理
        break;
      }
    }
  }
  return replayed;
}

/** 测试辅助：重置 id 计数器和 buffer。仅限单测使用。 */
export function __resetSSEReplayBufferForTests(): void {
  nextSSEEventId = 0;
  sseReplayBuffer.length = 0;
}
