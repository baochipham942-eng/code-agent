// ============================================================================
// N-RESIDENT-BG-CONTINUE-RUN-SURVIVE —— 「后台继续」退出后在途 run 不被 SSE 断线取消
// ============================================================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { RunHandle } from '../../../src/host/runtime/runContext';

const broadcastSSE = vi.fn();
const sendSSE = vi.fn();

vi.mock('../../../src/web/helpers/sse', () => ({
  broadcastSSE: (channel: string, data: unknown) => broadcastSSE(channel, data),
  sendSSE: (res: unknown, event: string, data: unknown) => sendSSE(res, event, data),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');
const { setDaemonQuitIntent, noteGlobalClientAttached, getDaemonQuitIntent } =
  await import('../../../src/host/services/daemon/quitIntent');

const DISCONNECT_LOG = 'SSE client disconnected, cancelling run';

function setup() {
  const res = { writableEnded: false, destroyed: false, write: () => true, end: () => undefined } as unknown as Response;
  const cancel = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const controller = new AgentRunController({
    res,
    runId: 'run-1',
    sessionId: 'session-1',
    runHandle: { cancel } as unknown as RunHandle,
    logger,
    tryGetSessionManager: async () => null,
    mirrorToBroadcast: false,
  });
  return { res, cancel, logger, controller };
}

function disconnect(res: Response) {
  (res as unknown as { writableEnded: boolean; destroyed: boolean }).destroyed = true;
}

function loggedDisconnect(logger: ReturnType<typeof setup>['logger']) {
  return logger.warn.mock.calls.some((c) => String(c[0]).includes(DISCONNECT_LOG));
}

describe('cancelForDisconnect × quit intent', () => {
  beforeEach(() => {
    broadcastSSE.mockClear();
    sendSSE.mockClear();
    // 模块态：每个用例重新声明 background（会清掉重接入标记）
    setDaemonQuitIntent('background');
  });

  it('intent=background：SSE 断开不 cancel、不标 disconnected、不打取消日志，run 正常完成', () => {
    setDaemonQuitIntent('background');
    const { res, cancel, logger, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
    expect(controller.disconnected).toBe(false);
    expect(loggedDisconnect(logger)).toBe(false);

    controller.emitAgentEvent({ type: 'agent_complete', data: undefined } as never);
    controller.flush();
    const types = broadcastSSE.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toContain('agent_complete');
    expect(types).not.toContain('agent_cancelled');
  });

  it('detach 之后的事件镜像到全局广播（agent:event 信封），重连的壳能看到续跑', () => {
    setDaemonQuitIntent('background');
    const { res, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();
    controller.emitSSE('turn_start', { turnId: 't1', sessionId: 'session-1', seq: 3 });

    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', expect.objectContaining({
      type: 'turn_start',
      sessionId: 'session-1',
    }));
  });

  it('过期意图：background 后新客户端接入全局 SSE，再断线仍 cancel', () => {
    noteGlobalClientAttached();
    const { res, cancel, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).toHaveBeenCalledWith('user');
  });

  it('接入全局 SSE 不改写意图本身：留守判据读到的仍是 background（armed schedules 不丢）', () => {
    noteGlobalClientAttached();
    expect(getDaemonQuitIntent()).toBe('background');
  });

  it('壳重新声明 background 后重新生效', () => {
    noteGlobalClientAttached();
    setDaemonQuitIntent('background');
    const { res, cancel, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
  });

  it('对照：intent=stop 断线照常 cancel 并打日志', () => {
    setDaemonQuitIntent('stop');
    const { res, cancel, logger, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).toHaveBeenCalledWith('user');
    expect(controller.disconnected).toBe(true);
    expect(loggedDisconnect(logger)).toBe(true);
  });
});
