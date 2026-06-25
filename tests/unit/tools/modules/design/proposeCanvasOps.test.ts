// ProposeCanvasOps（ADR-026）：schema/IPC 协议契约 + 校验 + CLI fallback + 阻塞解析。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const hasInteractiveRendererMock = vi.hoisted(() => vi.fn());
const notifyNeedsInputMock = vi.hoisted(() => vi.fn());
// 持久捕获 response handler 回调：ipcMain.handle 是 module 级 once-guard，clearAllMocks 会
// 抹掉 vi.fn 记录，故用一个不被清的 holder 捕获注册时的回调（跨 test 存活）。
const captured = vi.hoisted(() => ({ responseCb: undefined as undefined | ((e: unknown, d: unknown) => unknown) }));

vi.mock('../../../../../src/main/platform', () => ({
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, d: unknown) => unknown) => {
      if (channel === 'canvas-proposal:response') captured.responseCb = cb;
    },
  },
  BrowserWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../../src/main/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: notifyNeedsInputMock },
}));

import { proposeCanvasOpsModule, computeProposalTimeoutMs } from '../../../../../src/main/tools/modules/design/proposeCanvasOps';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';
import { INTERACTION_TIMEOUTS } from '../../../../../src/shared/constants';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return { sessionId: 's1', workingDir: '/tmp', abortSignal: ctrl.signal, logger: makeLogger(), emit: vi.fn(), ...overrides } as unknown as ToolContext;
}
const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });
const validOps = [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b', label: '下一步' }];

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindowsMock.mockReturnValue([]);
  hasInteractiveRendererMock.mockReturnValue(false);
});

describe('schema', () => {
  it('name/category/permission/required 对齐', () => {
    expect(proposeCanvasOpsModule.schema.name).toBe('ProposeCanvasOps');
    expect(proposeCanvasOpsModule.schema.category).toBe('planning');
    expect(proposeCanvasOpsModule.schema.permissionLevel).toBe('execute');
    expect(proposeCanvasOpsModule.schema.inputSchema.required).toEqual(['ops']);
  });
});

describe('IPC 协议契约', () => {
  it('CHANNEL 常量', () => {
    expect(IPC_CHANNELS.CANVAS_PROPOSAL_ASK).toBe('canvas-proposal:ask');
    expect(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE).toBe('canvas-proposal:response');
  });

  it('send(CANVAS_PROPOSAL_ASK, {requestId,ops,rationale})', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const handler = await proposeCanvasOpsModule.createHandler();
    const ctrl = new AbortController();
    const p = handler.execute({ ops: validOps, rationale: '画用户流' }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    p.catch(() => void 0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_PROPOSAL_ASK);
    expect(payload).toMatchObject({ rationale: '画用户流', ops: [expect.objectContaining({ kind: 'addConnector' })] });
    expect(payload.requestId).toMatch(/^cp-\d+/);
  });
});

describe('校验', () => {
  it('ops 非数组 → INVALID_ARGS', async () => {
    const h = await proposeCanvasOpsModule.createHandler();
    const r = await h.execute({ ops: 'x' }, makeCtx(), allowAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });

  it('全是非法/破坏性 op（含 deleteNode）→ INVALID_ARGS 且提示只允许白名单', async () => {
    const h = await proposeCanvasOpsModule.createHandler();
    const r = await h.execute({ ops: [{ kind: 'deleteNode', nodeId: 'a' }, { kind: 'addConnector', fromNodeId: 'a', toNodeId: 'a' }] }, makeCtx(), allowAll);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INVALID_ARGS');
      expect(r.error).toContain('moveNode/addConnector/addShape/renameNode');
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const h = await proposeCanvasOpsModule.createHandler();
    const r = await h.execute({ ops: validOps }, makeCtx(), denyAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const h = await proposeCanvasOpsModule.createHandler();
    const r = await h.execute({ ops: validOps }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
  });
});

describe('abort 中途（C1）', () => {
  it('等待中 abort → reject + 不泄漏（工具以错误结束，不挂到超时）', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const ctrl = new AbortController();
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: validOps }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    await new Promise((r) => setTimeout(r, 10)); // 等 send 出去、pending 已挂
    ctrl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOMAIN_ERROR'); // reject('aborted') 走统一 catch
  });

  // 审计 MED-3：abort 时广播 CANVAS_PROPOSAL_CANCEL，让 renderer 撤掉审批条——
  // 否则用户后点 Apply 会在无 agent 监听下触发付费生成（孤儿提议烧钱）。
  it('abort → 广播 CANVAS_PROPOSAL_CANCEL（带 requestId）', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const ctrl = new AbortController();
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: validOps }, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    ctrl.abort();
    await p.catch(() => void 0);
    const cancelCall = sendMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.CANVAS_PROPOSAL_CANCEL);
    expect(cancelCall).toBeTruthy();
    expect(cancelCall![1]).toEqual({ requestId: reqId });
  });
});

describe('CLI fallback', () => {
  it('无交互 renderer → 不 send、明确不假装已应用', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(false);
    const h = await proposeCanvasOpsModule.createHandler();
    const r = await h.execute({ ops: validOps }, makeCtx(), allowAll);
    expect(r.ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.output).toContain('非交互式设计画布环境');
      expect(r.output).toContain('不要假设提议已应用');
    }
  });
});

describe('二刀：含付费生成', () => {
  it('computeProposalTimeoutMs：纯 Layer1 用 USER_QUESTION，每张生成加一份出图预算', () => {
    expect(computeProposalTimeoutMs([{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }] as never)).toBe(INTERACTION_TIMEOUTS.USER_QUESTION);
    expect(computeProposalTimeoutMs([
      { kind: 'generateImage', prompt: 'a' },
      { kind: 'generateImage', prompt: 'b' },
      { kind: 'moveNode', nodeId: 'n', x: 0, y: 0 },
    ] as never)).toBe(INTERACTION_TIMEOUTS.USER_QUESTION + 2 * INTERACTION_TIMEOUTS.CANVAS_PROPOSAL_GEN_BUDGET);
  });

  it('generateImage 是合法 op：不被 INVALID_ARGS 剥光（接受文生图提议）', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: [{ kind: 'generateImage', prompt: '一张登录页' }] }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    p.catch(() => void 0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].ops[0]).toMatchObject({ kind: 'generateImage', prompt: '一张登录页' });
  });

  it('ADR-027 自主：apply 回灌 autonomy → 输出「自动应用」+ 剩余预算；未耗尽提示继续发散', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: [{ kind: 'generateImage', prompt: 'a' }] }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'apply', appliedCount: 1, skippedCount: 0, costCny: 0.14, autonomy: { remainingVariants: 2, remainingCny: 0.36, exhausted: false } });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('自动应用');
      expect(r.output).toContain('剩余 2 个变体');
      expect(r.output).toContain('继续提议');
    }
  });

  it('ADR-027 自主：耗尽 → 输出提示停止让用户挑选', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: [{ kind: 'generateImage', prompt: 'a' }] }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'apply', appliedCount: 1, skippedCount: 0, costCny: 0.14, autonomy: { remainingVariants: 0, remainingCny: 0.08, exhausted: true } });
    const r = await p;
    if (r.ok) {
      expect(r.output).toContain('耗尽');
      expect(r.output).toContain('挑选');
    }
  });

  it('apply 回灌 costCny → 输出含实际花费', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: [{ kind: 'generateImage', prompt: 'a' }] }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'apply', appliedCount: 1, skippedCount: 0, costCny: 0.14 });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('实际花费 ¥0.14');
  });
});

describe('阻塞解析（apply / reject）', () => {
  it('apply：回灌 appliedCount/skippedCount → 输出已应用文案', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: validOps }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    // 取 send 出去的 requestId，模拟 renderer 回 apply
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    expect(typeof captured.responseCb).toBe('function');
    await captured.responseCb!(null, { requestId: reqId, verdict: 'apply', appliedCount: 1, skippedCount: 0 });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('用户已批准并应用：1 项');
  });

  it('reject：带 feedback → 输出拒绝 + 意见', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
    const h = await proposeCanvasOpsModule.createHandler();
    const p = h.execute({ ops: validOps }, makeCtx(), allowAll);
    await new Promise((r) => setTimeout(r, 10));
    const reqId = sendMock.mock.calls[0][1].requestId as string;
    await captured.responseCb!(null, { requestId: reqId, verdict: 'reject', feedback: '连错了' });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('拒绝');
      expect(r.output).toContain('连错了');
    }
  });
});
