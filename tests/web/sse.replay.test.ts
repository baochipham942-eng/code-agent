// ============================================================================
// SSE replay buffer tests — ADR-010 item #6
// ============================================================================
//
// broadcastSSE 写入 ring buffer + replayFromLastEventId 回放，保证断线重连期间
// 丢失的事件能被补发。这里不拉 Express，只用 fake Response（只需要 .write）。
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  broadcastSSE,
  getSSEStreamCursor,
  replayFromCursor,
  registerSSEClient,
  sseClients,
  __resetSSEReplayBufferForTests,
} from '../../src/web/helpers/sse';
import { registerAdminChannels } from '../../src/host/ipc/channelAccessPolicy';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';

interface CapturedResponse {
  write: (chunk: string) => boolean;
  _chunks: string[];
}

function fakeResponse(): CapturedResponse {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    _chunks: chunks,
  };
}

function replayFromLastEventId(response: CapturedResponse, seq: number): number {
  return replayFromCursor(
    response as unknown as Parameters<typeof replayFromCursor>[0],
    { ...getSSEStreamCursor(), seq },
  );
}

function parseChunks(chunks: string[]): Array<{ id: number; channel: string }> {
  return chunks.flatMap((chunk) => {
    const idMatch = chunk.match(/id: (\d+)/);
    const dataMatch = chunk.match(/data: ({.*})/);
    if (!idMatch || !dataMatch) return [];
    const parsed = JSON.parse(dataMatch[1]) as { channel: string };
    return [{ id: Number.parseInt(idMatch[1], 10), channel: parsed.channel }];
  });
}

describe('sse replay buffer', () => {
  beforeEach(() => {
    sseClients.clear();
    __resetSSEReplayBufferForTests();
  });

  it('broadcastSSE 给每条事件分配单调递增 id 并写入 id 行', () => {
    const client = fakeResponse();
    // 模拟注册的客户端
    sseClients.add(client as unknown as Parameters<typeof sseClients.add>[0]);

    broadcastSSE('swarm:event', { type: 'swarm:started', timestamp: 1 });
    broadcastSSE('swarm:event', { type: 'swarm:agent:added', timestamp: 2 });

    const events = parseChunks(client._chunks);
    expect(events).toEqual([
      { id: 1, channel: 'swarm:event' },
      { id: 2, channel: 'swarm:event' },
    ]);
  });

  it('replayFromLastEventId 只补发 id 大于 lastId 的事件', () => {
    // 先 broadcast 5 条事件到一个"已断开"的空 client set
    broadcastSSE('swarm:event', { type: 'e1' });
    broadcastSSE('swarm:event', { type: 'e2' });
    broadcastSSE('swarm:event', { type: 'e3' });
    broadcastSSE('swarm:event', { type: 'e4' });
    broadcastSSE('swarm:event', { type: 'e5' });

    const reconnecting = fakeResponse();
    const replayed = replayFromLastEventId(
      reconnecting as unknown as Parameters<typeof replayFromLastEventId>[0],
      2,
    );

    expect(replayed).toBe(3);
    const events = parseChunks(reconnecting._chunks);
    expect(events.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('lastEventId = -1（首次连接）时不 replay', () => {
    broadcastSSE('swarm:event', { type: 'e1' });
    const reconnecting = fakeResponse();
    const replayed = replayFromLastEventId(
      reconnecting as unknown as Parameters<typeof replayFromLastEventId>[0],
      -1,
    );
    // 首次连接没错过任何事件，但 buffer 里有 e1（id=1），lastId=-1 < 0，按语义应全部补发
    // 实际上：-1 < 0 导致 oldest(1)-1=0 > -1，判为丢失，返回 -1
    expect(replayed).toBe(-1);
  });

  it('lastEventId 正好等于最后一条时 replay 返回 0（无新事件）', () => {
    broadcastSSE('swarm:event', { type: 'e1' });
    broadcastSSE('swarm:event', { type: 'e2' });
    const reconnecting = fakeResponse();
    const replayed = replayFromLastEventId(
      reconnecting as unknown as Parameters<typeof replayFromLastEventId>[0],
      2,
    );
    expect(replayed).toBe(0);
    expect(reconnecting._chunks).toHaveLength(0);
  });

  it('lastEventId 已落在 buffer 头之前时返回 -1 表示丢失', () => {
    // 填满 buffer 需要超过 SSE_REPLAY_BUFFER_SIZE=256 条
    for (let i = 0; i < 300; i += 1) {
      broadcastSSE('swarm:event', { seq: i });
    }
    const reconnecting = fakeResponse();
    const replayed = replayFromLastEventId(
      reconnecting as unknown as Parameters<typeof replayFromLastEventId>[0],
      10, // 太旧
    );
    expect(replayed).toBe(-1);
  });

  it('旧宿主 epoch 的 event id 即使数值命中也拒绝 replay', () => {
    broadcastSSE('swarm:event', { type: 'current-host-event' });
    const reconnecting = fakeResponse();

    expect(replayFromCursor(
      reconnecting as unknown as Parameters<typeof replayFromCursor>[0],
      { streamEpoch: 'http:retired-host', sessionId: '__sse__', seq: 0 },
    )).toBe(-1);
    expect(reconnecting._chunks).toHaveLength(0);
  });

  it('id 单调递增不因 sseClients 清空而重置', () => {
    broadcastSSE('swarm:event', { type: 'e1' });
    sseClients.clear();
    broadcastSSE('swarm:event', { type: 'e2' });

    const reconnecting = fakeResponse();
    replayFromLastEventId(
      reconnecting as unknown as Parameters<typeof replayFromLastEventId>[0],
      0,
    );
    const events = parseChunks(reconnecting._chunks);
    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('admin-only evaluation events are filtered from live delivery and replay', () => {
    const unregister = registerAdminChannels(Object.values(EVALUATION_CHANNELS));
    const user = fakeResponse();
    const admin = fakeResponse();
    registerSSEClient(user as unknown as Parameters<typeof registerSSEClient>[0], false);
    registerSSEClient(admin as unknown as Parameters<typeof registerSSEClient>[0], true);

    broadcastSSE('evaluation:run-events', { type: 'run_start' });
    broadcastSSE('swarm:event', { type: 'visible' });

    expect(parseChunks(user._chunks).map((event) => event.channel)).toEqual(['swarm:event']);
    expect(parseChunks(admin._chunks).map((event) => event.channel)).toEqual([
      'evaluation:run-events',
      'swarm:event',
    ]);

    const userReplay = fakeResponse();
    const adminReplay = fakeResponse();
    registerSSEClient(userReplay as unknown as Parameters<typeof registerSSEClient>[0], false);
    registerSSEClient(adminReplay as unknown as Parameters<typeof registerSSEClient>[0], true);
    expect(replayFromLastEventId(
      userReplay as unknown as Parameters<typeof replayFromLastEventId>[0],
      0,
    )).toBe(1);
    expect(replayFromLastEventId(
      adminReplay as unknown as Parameters<typeof replayFromLastEventId>[0],
      0,
    )).toBe(2);
    unregister();
  });
});
