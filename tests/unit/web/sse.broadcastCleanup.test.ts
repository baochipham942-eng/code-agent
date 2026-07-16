// ============================================================================
// sse helpers：死连接从 sseClients 剔除、sendSSE 帧格式、空 buffer replay。
// tests/web/sse.replay.test.ts 覆盖 ring buffer；本文件补断连清理与单播。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import {
  __resetSSEReplayBufferForTests,
  broadcastSSE,
  replayFromLastEventId,
  sendSSE,
  sseClients,
} from '../../../src/web/helpers/sse';

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

describe('broadcastSSE client cleanup', () => {
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
