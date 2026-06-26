// RequestDesignAutonomy（ADR-027）：schema/IPC 协议契约 + 校验 + 降级 + 阻塞解析（grant/decline）+ abort。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const hasInteractiveRendererMock = vi.hoisted(() => vi.fn());
const notifyNeedsInputMock = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => ({ responseCb: undefined as undefined | ((e: unknown, d: unknown) => unknown) }));

vi.mock('../../../../../src/host/platform', () => ({
  ipcHost: {
    handle: (channel: string, cb: (e: unknown, d: unknown) => unknown) => {
      if (channel === 'canvas-autonomy:response') captured.responseCb = cb;
    },
  },
  AppWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: notifyNeedsInputMock },
}));

import { requestDesignAutonomyModule } from '../../../../../src/host/tools/modules/design/requestDesignAutonomy';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';
import { MAX_AUTONOMY_VARIANTS, DEFAULT_AUTONOMY_VARIANTS } from '../../../../../src/shared/constants';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return { sessionId: 's1', workingDir: '/tmp', abortSignal: ctrl.signal, logger: makeLogger(), emit: vi.fn(), ...overrides } as unknown as ToolContext;
}
const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindowsMock.mockReturnValue([]);
  hasInteractiveRendererMock.mockReturnValue(false);
});

describe('schema', () => {
  it('name/category/permission/required 对齐', () => {
    expect(requestDesignAutonomyModule.schema.name).toBe('RequestDesignAutonomy');
    expect(requestDesignAutonomyModule.schema.category).toBe('planning');
    expect(requestDesignAutonomyModule.schema.permissionLevel).toBe('execute');
    expect(requestDesignAutonomyModule.schema.inputSchema.required).toEqual(['goal']);
  });
});

describe('IPC 协议契约', () => {
  it('CHANNEL 常量', () => {
    expect(IPC_CHANNELS.CANVAS_AUTONOMY_ASK).toBe('canvas-autonomy:ask');
    expect(IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE).toBe('canvas-autonomy:response');
    expect(IPC_CHANNELS.CANVAS_AUTONOMY_CANCEL).toBe('canvas-autonomy:cancel');
  });

  it('send(CANVAS_AUTONOMY_ASK, {requestId, goal, proposed})', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索 3 个 hero 图方向', maxVariants: 3, rationale: '多给几个方向挑' }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    p.catch(() => void 0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_AUTONOMY_ASK);
    expect(payload).toMatchObject({ goal: '探索 3 个 hero 图方向', proposed: { maxVariants: 3 }, rationale: '多给几个方向挑' });
    expect(payload.requestId).toMatch(/^da-\d+/);
    expect(payload.sessionId).toBe('s1'); // HIGH-2：信封绑 session，run 终态作废
  });
});

describe('校验', () => {
  it('goal 空 → INVALID_ARGS', async () => {
    const h = await requestDesignAutonomyModule.createHandler();
    const r = await h.execute({ goal: '   ' }, makeCtx(), allowAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const h = await requestDesignAutonomyModule.createHandler();
    const r = await h.execute({ goal: '探索方向' }, makeCtx(), denyAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const h = await requestDesignAutonomyModule.createHandler();
    const r = await h.execute({ goal: '探索方向' }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
  });
});

describe('降级（非交互环境，红线⑤）', () => {
  it('无交互 renderer → 不 send、明确不假装已进入自主', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(false);
    const h = await requestDesignAutonomyModule.createHandler();
    const r = await h.execute({ goal: '探索方向' }, makeCtx(), allowAll);
    expect(r.ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.output).toContain('非交互式设计画布环境');
      expect(r.output).toContain('不要假设已进入自主模式');
    }
  });
});

describe('abort 中途', () => {
  it('等待中 abort → DOMAIN_ERROR + 广播 CANVAS_AUTONOMY_CANCEL', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const ctrl = new AbortController();
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索方向' }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    ctrl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOMAIN_ERROR');
    const cancelCall = sendMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.CANVAS_AUTONOMY_CANCEL);
    expect(cancelCall).toBeTruthy();
    expect(cancelCall![1]).toEqual({ requestId: reqId });
  });
});

describe('阻塞解析（grant / decline）', () => {
  it('grant：回灌人确认的信封 → 输出含变体数 + ¥ 条款 + 自主纪律', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索方向' }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'grant', granted: { maxVariants: 3, maxCny: 0.5 } });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('自主信封已批准');
      expect(r.output).toContain('3 个变体');
      expect(r.output).toContain('¥0.50');
      expect(r.output).toContain('用户挑选'); // 强调人挑=唯一质量信号
    }
  });

  it('grant：人把变体数改超天花板 → 输出按 MAX_AUTONOMY_VARIANTS 夹紧（与 renderer 同口径）', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索方向' }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'grant', granted: { maxVariants: 999 } });
    const r = await p;
    if (r.ok) expect(r.output).toContain(`${MAX_AUTONOMY_VARIANTS} 个变体`);
  });

  it('grant：无 granted（人直接批 agent 提议的空信封）→ 用默认变体数', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索方向' }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'grant' });
    const r = await p;
    if (r.ok) expect(r.output).toContain(`${DEFAULT_AUTONOMY_VARIANTS} 个变体`);
  });

  it('decline：带 feedback → 输出未批准 + 意见 + 退回逐步', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await requestDesignAutonomyModule.createHandler();
    const p = h.execute({ goal: '探索方向' }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'decline', feedback: '先把方向定了' });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('未批准自主信封');
      expect(r.output).toContain('先把方向定了');
      expect(r.output).toContain('不要假设已进入自主模式');
    }
  });
});
