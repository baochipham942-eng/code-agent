// ============================================================================
// sse helpers：死连接从 sseClients 剔除、sendSSE 帧格式、空 buffer replay。
// tests/web/sse.replay.test.ts 覆盖 ring buffer；本文件补断连清理与单播。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import {
  __resetSSEReplayBufferForTests,
  broadcastSSE,
  registerSSEClient,
  replayFromLastEventId,
  sendSSE,
  sseClients,
} from '../../../src/web/helpers/sse';
import { registerAdminChannels } from '../../../src/host/ipc/channelAccessPolicy';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';

function fakeClient(options: { failWrite?: boolean } = {}) {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      if (options.failWrite) {
        throw new Error('socket closed');
      }
      chunks.push(chunk);
      return true;
    },
  };
}

beforeEach(() => {
  sseClients.clear();
  __resetSSEReplayBufferForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('broadcastSSE client cleanup', () => {
  it('delivers evaluation run events to admin SSE clients only', () => {
    const unregister = registerAdminChannels(Object.values(EVALUATION_CHANNELS));
    const user = fakeClient();
    const admin = fakeClient();
    registerSSEClient(user as unknown as Response, false);
    registerSSEClient(admin as unknown as Response, true);

    broadcastSSE('evaluation:run-events', { schemaVersion: 2, type: 'run_start', runId: 'run-1' });

    expect(user.chunks).toHaveLength(0);
    expect(admin.chunks).toHaveLength(1);
    expect(admin.chunks[0]).toContain('"channel":"evaluation:run-events"');
    unregister();
  });

  it('removes clients whose write throws (dead connection)', () => {
    const alive = fakeClient();
    const dead = fakeClient({ failWrite: true });
    sseClients.add(alive as unknown as Response);
    sseClients.add(dead as unknown as Response);

    broadcastSSE('agent:event', { type: 'ping' });

    expect(sseClients.has(dead as unknown as Response)).toBe(false);
    expect(sseClients.has(alive as unknown as Response)).toBe(true);
    expect(alive.chunks.length).toBe(1);
    expect(alive.chunks[0]).toContain('data: ');
    expect(alive.chunks[0]).toContain('"channel":"agent:event"');
  });

  it('still buffers the event when no clients are registered', () => {
    broadcastSSE('agent:event', { n: 1 });

    const reconnecting = fakeClient();
    const replayed = replayFromLastEventId(
      reconnecting as unknown as Response,
      0,
    );

    expect(replayed).toBe(1);
    expect(reconnecting.chunks[0]).toMatch(/^id: 1\n/);
  });

  it('disconnects a non-reading client without dropping events for a healthy client', () => {
    const normal = fakeClient();
    let slowWrites = 0;
    let bufferedBytes = 0;
    let destroyed = false;
    const drainListeners = new Set<() => void>();
    const slow = {
      get destroyed() { return destroyed; },
      write(chunk: string) {
        slowWrites += 1;
        bufferedBytes += Buffer.byteLength(chunk);
        return false;
      },
      once(event: string, listener: () => void) {
        if (event === 'drain') drainListeners.add(listener);
      },
      removeListener(_event: string, listener: () => void) {
        drainListeners.delete(listener);
      },
      destroy() {
        destroyed = true;
        drainListeners.clear();
      },
    };
    sseClients.add(normal as unknown as Response);
    sseClients.add(slow as unknown as Response);

    for (let index = 0; index < 2_000; index += 1) {
      broadcastSSE('agent:event', { index, text: 'x'.repeat(128) });
    }

    expect(destroyed).toBe(true);
    expect(sseClients.has(slow as unknown as Response)).toBe(false);
    expect(slowWrites).toBe(3);
    expect(bufferedBytes).toBeLessThan(2_000);
    expect(normal.chunks).toHaveLength(2_000);
  });

  it('disconnects a client that never drains after its first backpressure signal', () => {
    vi.useFakeTimers();
    let destroyed = false;
    const slow = {
      get destroyed() { return destroyed; },
      write: () => false,
      once: () => undefined,
      removeListener: () => undefined,
      destroy: () => { destroyed = true; },
    };
    sseClients.add(slow as unknown as Response);

    broadcastSSE('agent:event', { type: 'blocked' });
    vi.advanceTimersByTime(4_999);
    expect(destroyed).toBe(false);
    vi.advanceTimersByTime(1);

    expect(destroyed).toBe(true);
    expect(sseClients.has(slow as unknown as Response)).toBe(false);
  });
});

describe('sendSSE', () => {
  it('writes event: and data: lines without touching the replay buffer', () => {
    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    };

    // Poison the client set — sendSSE must not fan out via broadcast
    const spyClient = fakeClient();
    sseClients.add(spyClient as unknown as Response);

    sendSSE(res as unknown as import('http').ServerResponse, 'stream_chunk', {
      content: 'hi',
    });

    expect(writes).toEqual([
      'event: stream_chunk\n',
      'data: {"content":"hi"}\n\n',
    ]);
    expect(spyClient.chunks).toHaveLength(0);

    // sendSSE does not push replay buffer (replay stays empty)
    const reconnecting = fakeClient();
    expect(replayFromLastEventId(reconnecting as unknown as Response, 0)).toBe(0);
  });
});

describe('replayFromLastEventId empty buffer', () => {
  it('returns 0 when buffer is empty regardless of lastEventId', () => {
    const res = fakeClient();
    expect(replayFromLastEventId(res as unknown as Response, 99)).toBe(0);
    expect(replayFromLastEventId(res as unknown as Response, -1)).toBe(0);
    expect(res.chunks).toHaveLength(0);
  });

  it('stops writing when the reconnecting client throws mid-replay', () => {
    broadcastSSE('agent:event', { a: 1 });
    broadcastSSE('agent:event', { a: 2 });
    broadcastSSE('agent:event', { a: 3 });

    let calls = 0;
    const flaky = {
      write() {
        calls += 1;
        if (calls >= 2) throw new Error('closed mid-replay');
        return true;
      },
    };

    const replayed = replayFromLastEventId(flaky as unknown as Response, 0);
    // First write succeeds (event 1), second throws → loop breaks; count is 1
    expect(replayed).toBe(1);
  });
});
