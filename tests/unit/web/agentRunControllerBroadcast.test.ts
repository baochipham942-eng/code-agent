// ============================================================================
// AgentRunController.mirrorToBroadcast —— 无直连客户端的那轮必须走全局广播
//
// 2026-07-27 产品负责人实测的根因：队列抽干那轮用 createOfflineAgentRunResponseSink()
// 跑（res 是个 write:()=>true 的黑洞）且 connectedClient:false，事件全丢。
// 结果消息落库了、模型也计费了，但正连着的前端一个字都收不到——
// 转录区不长东西、排队卡片不消失，用户看到的就是「没自动发出去」。
// ============================================================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

const broadcastSSE = vi.fn();
const sendSSE = vi.fn();

vi.mock('../../../src/web/helpers/sse', () => ({
  broadcastSSE: (channel: string, data: unknown) => broadcastSSE(channel, data),
  sendSSE: (res: unknown, event: string, data: unknown) => sendSSE(res, event, data),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');

function createSink(): Response {
  return {
    writableEnded: false,
    destroyed: false,
    write: () => true,
    end: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Response;
}

function createController(mirrorToBroadcast: boolean) {
  return new AgentRunController({
    res: createSink(),
    runId: 'run-1',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast,
  });
}

describe('AgentRunController 广播镜像', () => {
  beforeEach(() => {
    broadcastSSE.mockClear();
    sendSSE.mockClear();
  });

  it('无直连客户端时，事件同时走全局广播', () => {
    createController(true).emitSSE('agent:event', { type: 'stream_chunk' });

    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', { type: 'stream_chunk' });
  });

  it('有直连客户端时不广播，避免重复投递', () => {
    createController(false).emitSSE('agent:event', { type: 'stream_chunk' });

    expect(broadcastSSE).not.toHaveBeenCalled();
    expect(sendSSE).toHaveBeenCalledTimes(1);
  });
});
