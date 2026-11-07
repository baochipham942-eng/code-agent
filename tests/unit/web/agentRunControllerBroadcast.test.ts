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

function createSink(closed = false): Response {
  return {
    writableEnded: closed,
    destroyed: false,
    write: () => true,
    end: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Response;
}

function createController(mirrorToBroadcast: boolean, streamClosed = false) {
  return new AgentRunController({
    res: createSink(streamClosed),
    runId: 'run-1',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast,
  });
}

function createFilteredController() {
  return new AgentRunController({
    res: createSink(false),
    runId: 'run-filtered',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast: false,
    eventFilter: { include: ['permission_request'] },
  });
}

const surfaceEvent = {
  version: 1,
  eventId: 'surface_event_1',
  sequence: 3,
  phase: 'cleanup',
  status: 'succeeded',
  conversationId: 'session-1',
  runId: 'run-1',
  agentId: 'agent-a',
  sessionId: 'session-1',
  seq: 12,
};

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
      streamEpoch: expect.stringMatching(/^http:/),
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

  it('只把请求声明的 AgentEvent 写进响应流', () => {
    const controller = createFilteredController();
    controller.emitAgentEvent({ type: 'stream_chunk', data: { content: 'hidden' } });
    controller.emitAgentEvent({
      type: 'permission_request',
      data: {
        id: 'p1',
        type: 'command',
        tool: 'bash',
        details: { command: 'npm test' },
        timestamp: 1,
      },
    });
    controller.flush();

    expect(sendSSE).not.toHaveBeenCalledWith(expect.anything(), 'stream_chunk', expect.anything());
    expect(sendSSE).toHaveBeenCalledWith(expect.anything(), 'permission_request', expect.anything());
  });
});

// ============================================================================
// 取消/断流之后的 surface 终态兜底（2026-08-02 排查报告 §2.2 腿 A）
//
// 用户点取消 = renderer 关掉 per-run SSE。此后 finalizeRun→endRun 发出的 cleanup/
// 终态 surface 事件在 emitSSE 处 canWriteSSE()=false 被整条丢弃，renderer 再也收不到
// 「拉快照」的触发信号，行内紧凑条 / composer / chrome 绿点三处一起冻在 running。
// ============================================================================
describe('AgentRunController 断流后的 surface 终态兜底', () => {
  beforeEach(() => {
    broadcastSSE.mockClear();
    sendSSE.mockClear();
  });

  it('per-run 流已关时，surface 终态事件仍要包成 agent:event 信封广播出去', () => {
    createController(false, true).emitSSE('surface_execution', surfaceEvent);

    // channel 名接错（比如直接 broadcastSSE('surface_execution', …)）时这条必红：
    // 全局 /api/events 严格按 channel 名分发，renderer 只注册了 agent:event。
    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', {
      type: 'surface_execution',
      data: surfaceEvent,
      streamEpoch: expect.stringMatching(/^http:/),
      sessionId: 'session-1',
      seq: 12,
    });
    expect(broadcastSSE.mock.calls[0][0]).toBe('agent:event');
    expect(sendSSE).not.toHaveBeenCalled();
  });

  it('per-run 流还开着时不兜底广播，避免重复投递', () => {
    createController(false, false).emitSSE('surface_execution', surfaceEvent);

    expect(broadcastSSE).not.toHaveBeenCalled();
    expect(sendSSE).toHaveBeenCalledTimes(1);
  });

  it('兜底只覆盖 surface_execution，其余事件维持断流即丢的既有语义', () => {
    createController(false, true).emitSSE('message_delta', { text: 'hi', sessionId: 'session-1' });

    expect(broadcastSSE).not.toHaveBeenCalled();
    expect(sendSSE).not.toHaveBeenCalled();
  });

  it('镜像轮不因为断流而广播两遍', () => {
    createController(true, true).emitSSE('surface_execution', surfaceEvent);

    expect(broadcastSSE).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// N-RUN-CONCURRENT-PERSIST-FAIL-FU1 —— 终态写失败必须照旧 WARN，不许吞
//
// kickoff 的 running 写挪到建行后（新会话不再每会话一条 persist-fail WARN），
// 但这只豁免那一笔 opening 写：completed / error / interrupted 的终态写失败
// 仍要走 catch 的 logger.warn，否则落库异常被静默、侧栏终态挂在旧值没人知道。
// 失败时也不广播——广播在写成功之后才发。
// ============================================================================
describe('AgentRunController 终态写失败照旧 WARN', () => {
  beforeEach(() => {
    broadcastSSE.mockClear();
    sendSSE.mockClear();
  });

  it.each(['completed', 'error', 'interrupted'] as const)('updateSessionStatus(%s) 写失败要 WARN 且不广播', async (status) => {
    const warn = vi.fn();
    const controller = new AgentRunController({
      res: createSink(false),
      runId: `run-term-fail-${status}`,
      sessionId: 'session-1',
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      tryGetSessionManager: async () => ({
        updateSession: async () => { throw new Error('Session session-1 not found'); },
      }),
      mirrorToBroadcast: false,
    });

    await controller.updateSessionStatus(status);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`[AgentRouter] Failed to persist session status ${status} for session-1:`);
    // 广播只发生在写成功之后；写失败时不能把「状态已更新」的假消息广播出去
    expect(broadcastSSE).not.toHaveBeenCalled();
  });
});
