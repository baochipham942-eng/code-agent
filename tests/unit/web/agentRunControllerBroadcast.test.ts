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

  // ⚠️ 这个用例以前写成 emitSSE('agent:event', …)——把 channel 名当事件名喂进去，
  // 于是它断言出来的「channel 是 agent:event」其实是测试自己塞的。真实调用方
  // （agentRunSSEBatcher 的 writeEvent(event.type, …)、task_start、tool_warning）
  // 传的都是原始事件类型。测试一直绿、产品一直坏：广播出去的 channel 叫 turn_start，
  // 而 renderer 的全局 SSE 严格按 channel 名分发、只注册 agent:event，事件在分发入口
  // 静默丢弃（2026-08-01 C3：刷新后宿主自己起的那轮 116 条 delta 一条也到不了页面）。
  // 所以这里必须喂真实事件名，并断言信封形状。
  it('无直连客户端时，原始事件名要包成 agent:event 信封再广播', () => {
    createController(true).emitSSE('turn_start', { turnId: 't1', sessionId: 'session-1', seq: 7 });

    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', {
      type: 'turn_start',
      data: { turnId: 't1', sessionId: 'session-1', seq: 7 },
      sessionId: 'session-1',
      seq: 7,
    });
  });

  it('data 里没带 sessionId 时用本轮 sessionId 兜底，别让事件算到别的会话头上', () => {
    // task_start / tool_warning / tool_call_local 不过 batcher，data 里没有 sessionId
    createController(true).emitSSE('task_start', { title: '写一篇散文' });

    const [channel, payload] = broadcastSSE.mock.calls[0];
    expect(channel).toBe('agent:event');
    expect((payload as { sessionId: string }).sessionId).toBe('session-1');
    expect((payload as { type: string }).type).toBe('task_start');
  });

  it('有直连客户端时不广播，避免重复投递', () => {
    createController(false).emitSSE('turn_start', { turnId: 't1' });

    expect(broadcastSSE).not.toHaveBeenCalled();
    expect(sendSSE).toHaveBeenCalledTimes(1);
  });

  // 直连轮写进 res 的仍是原始事件名——processStream 靠 `event: <type>` 行解析，
  // 改成信封会把直连路径打断。
  it('写进直连响应流的仍是原始事件名，不受信封改动影响', () => {
    createController(false).emitSSE('turn_start', { turnId: 't1' });

    expect(sendSSE).toHaveBeenCalledWith(expect.anything(), 'turn_start', { turnId: 't1' });
  });
});
