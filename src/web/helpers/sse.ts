// ============================================================================
// SSE broadcast infrastructure
// ============================================================================

import http from 'http';
import type { Response } from 'express';
import { isAdminChannel } from '../../host/ipc/channelAccessPolicy';
import { getWebStreamEpoch } from './agentStreamCursor';

/** Registry of active SSE clients */
export const sseClients = new Set<Response>();
let sseAdminClients = new WeakSet<Response>();

export function registerSSEClient(client: Response, isAdmin: boolean): void {
  sseClients.add(client);
  if (isAdmin) sseAdminClients.add(client);
}

function mayReceiveChannel(client: Response, channel: string): boolean {
  return !isAdminChannel(channel) || sseAdminClients.has(client);
}

/**
 * 重放缓冲区大小。每会话环覆盖典型断线窗口内 swarm + agent 事件的峰值吞吐，
 * session-less 事件保留现有全局环大小。ADR-010 #6：客户端重连时凭 Last-Event-ID
 * 拉回错过的事件。
 */
const SSE_SESSION_REPLAY_BUFFER_SIZE = 512;
const SSE_GLOBAL_REPLAY_BUFFER_SIZE = 256;
const SSE_MAX_SESSION_RINGS = 64;

// Three failed writes cap per-client buffered growth to a few event payloads;
// five seconds is long enough for transient network stalls but bounds retention.
const SSE_MAX_CONSECUTIVE_BACKPRESSURE_WRITES = 3;
const SSE_DRAIN_TIMEOUT_MS = 5_000;

interface SSEBackpressureState {
  consecutiveWrites: number;
  drainTimer: ReturnType<typeof setTimeout>;
  onDrain: () => void;
}

let sseBackpressureStates = new WeakMap<Response, SSEBackpressureState>();

interface BufferedSSEEvent {
  id: number;
  channel: string;
  args: unknown;
}

interface ReplayRing {
  entries: BufferedSSEEvent[];
  evictedMaxId: number;
  lastTouchedId: number;
}

/**
 * Snapshot semantics: in a snapshot, a session that is missing means it has
 * ended. In an incremental event, a missing field means unchanged.
 */

export interface SSEStreamCursor {
  streamEpoch: string;
  sessionId: '__sse__';
  seq: number;
}

let nextSSEEventId = 0;
const sseSessionReplayRings = new Map<string, ReplayRing>();
const sseGlobalReplayRing: ReplayRing = {
  entries: [],
  evictedMaxId: 0,
  lastTouchedId: 0,
};
let droppedSessionEvictedMaxId = 0;

function appendToReplayRing(ring: ReplayRing, entry: BufferedSSEEvent, capacity: number): void {
  ring.entries.push(entry);
  ring.lastTouchedId = entry.id;
  if (ring.entries.length > capacity) {
    const evicted = ring.entries.splice(0, ring.entries.length - capacity);
    const lastEvicted = evicted.at(-1);
    if (lastEvicted) ring.evictedMaxId = Math.max(ring.evictedMaxId, lastEvicted.id);
  }
}

function getSessionId(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const sessionId = (args as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : null;
}

function dropLeastRecentlyTouchedRing(): void {
  let oldestSessionId: string | undefined;
  let oldestRing: ReplayRing | undefined;
  for (const [sessionId, ring] of sseSessionReplayRings) {
    if (!oldestRing || ring.lastTouchedId < oldestRing.lastTouchedId) {
      oldestSessionId = sessionId;
      oldestRing = ring;
    }
  }
  if (oldestSessionId === undefined || oldestRing === undefined) return;
  const lastRetained = oldestRing.entries.at(-1);
  droppedSessionEvictedMaxId = Math.max(
    droppedSessionEvictedMaxId,
    oldestRing.evictedMaxId,
    lastRetained?.id ?? 0,
  );
  sseSessionReplayRings.delete(oldestSessionId);
}

function pushReplayBuffer(entry: BufferedSSEEvent): void {
  const sessionId = getSessionId(entry.args);
  if (sessionId === null) {
    appendToReplayRing(sseGlobalReplayRing, entry, SSE_GLOBAL_REPLAY_BUFFER_SIZE);
    return;
  }
  let ring = sseSessionReplayRings.get(sessionId);
  if (!ring) {
    if (sseSessionReplayRings.size >= SSE_MAX_SESSION_RINGS) dropLeastRecentlyTouchedRing();
    ring = { entries: [], evictedMaxId: 0, lastTouchedId: 0 };
    sseSessionReplayRings.set(sessionId, ring);
  }
  appendToReplayRing(ring, entry, SSE_SESSION_REPLAY_BUFFER_SIZE);
}

function hasReplayGap(lastEventId: number): boolean {
  if (droppedSessionEvictedMaxId > lastEventId || sseGlobalReplayRing.evictedMaxId > lastEventId) {
    return true;
  }
  for (const ring of sseSessionReplayRings.values()) {
    if (ring.evictedMaxId > lastEventId) return true;
  }
  return false;
}

function serializeEvent(entry: BufferedSSEEvent): string {
  const payload = JSON.stringify({ channel: entry.channel, args: entry.args });
  return `id: ${entry.id}\ndata: ${payload}\n\n`;
}

function clearSSEBackpressure(client: Response): void {
  const state = sseBackpressureStates.get(client);
  if (!state) return;
  clearTimeout(state.drainTimer);
  client.removeListener('drain', state.onDrain);
  sseBackpressureStates.delete(client);
}

function disconnectSSEClient(client: Response): void {
  clearSSEBackpressure(client);
  sseClients.delete(client);
  const destroy = (client as Response & { destroy?: () => void }).destroy;
  if (!client.destroyed && destroy) destroy.call(client);
}

function recordSSEBackpressure(client: Response): void {
  let state = sseBackpressureStates.get(client);
  if (!state) {
    const onDrain = () => clearSSEBackpressure(client);
    const drainTimer = setTimeout(() => disconnectSSEClient(client), SSE_DRAIN_TIMEOUT_MS);
    drainTimer.unref?.();
    state = { consecutiveWrites: 0, drainTimer, onDrain };
    sseBackpressureStates.set(client, state);
    client.once('drain', onDrain);
  }
  state.consecutiveWrites += 1;
  if (state.consecutiveWrites >= SSE_MAX_CONSECUTIVE_BACKPRESSURE_WRITES) {
    disconnectSSEClient(client);
  }
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
    if (!mayReceiveChannel(client, channel)) continue;
    try {
      if (!client.write(payload)) {
        recordSSEBackpressure(client);
      } else {
        clearSSEBackpressure(client);
      }
    } catch {
      disconnectSSEClient(client);
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

/** 向单个 EventSource 客户端发送普通 onmessage 载荷，不写 replay buffer。 */
export function sendSSEPayload(res: http.ServerResponse, channel: string, args: unknown): void {
  res.write(`data: ${JSON.stringify({ channel, args })}\n\n`);
}

/**
 * 客户端重连时调用：把 replay buffer 里 id 大于 lastEventId 的事件按顺序
 * 写入响应。返回已重放的事件数量。
 *
 * 如果某个 ring 已经轮转覆盖了大于 lastEventId 的事件，返回 -1 表示数据丢失；
 * 没有发生过这种淘汰时，即使某个 ring 的最早事件 id 较大，也可以安全重放。
 */
export function replayFromCursor(res: Response, cursor: SSEStreamCursor): number {
  if (cursor.streamEpoch !== getWebStreamEpoch() || cursor.sessionId !== '__sse__') {
    return -1;
  }
  const lastEventId = cursor.seq;
  if (lastEventId > nextSSEEventId) {
    return -1;
  }
  if (
    lastEventId === -1
    && sseGlobalReplayRing.entries.length === 0
    && sseSessionReplayRings.size === 0
  ) {
    return 0;
  }
  if (hasReplayGap(lastEventId)) return -1;
  const entries = [
    ...sseGlobalReplayRing.entries,
    ...Array.from(sseSessionReplayRings.values(), (ring) => ring.entries).flat(),
  ]
    .filter((entry) => entry.id > lastEventId)
    .sort((left, right) => left.id - right.id);
  let replayed = 0;
  for (const entry of entries) {
    if (mayReceiveChannel(res, entry.channel)) {
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

export function getSSEStreamCursor(): SSEStreamCursor {
  return {
    streamEpoch: getWebStreamEpoch(),
    sessionId: '__sse__',
    seq: nextSSEEventId,
  };
}

/** 测试辅助：重置 id 计数器和 buffer。仅限单测使用。 */
export function __resetSSEReplayBufferForTests(): void {
  nextSSEEventId = 0;
  sseSessionReplayRings.clear();
  sseGlobalReplayRing.entries.length = 0;
  sseGlobalReplayRing.evictedMaxId = 0;
  sseGlobalReplayRing.lastTouchedId = 0;
  droppedSessionEvictedMaxId = 0;
  sseBackpressureStates = new WeakMap<Response, SSEBackpressureState>();
  sseAdminClients = new WeakSet<Response>();
}
