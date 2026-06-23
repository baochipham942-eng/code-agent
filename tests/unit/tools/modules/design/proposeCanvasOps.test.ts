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

import { proposeCanvasOpsModule } from '../../../../../src/main/tools/modules/design/proposeCanvasOps';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';

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
