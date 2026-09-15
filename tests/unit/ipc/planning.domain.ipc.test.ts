import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// planning.ipc.ts 派发特征测试（RQ-183 续作·PLANNING 刀迁表前钉住 switch 形态）：派发层 5 个 action（计数以切块断言为准）。
// 既有 planningIpc.test.ts 只测纯函数 isPlanningServiceScopedToSession，派发层零覆盖。这里补：
// - getState / getPlan / getFindings / getErrors：服务缺席或 sessionId（trim 后）与计划目录名不符 → 空形态；相符或未传 sessionId → 委派
// - getState / getPlan / getFindings 读取抛错 → 记日志并回空形态（不冒泡）；getErrors 无内层兜底 → INTERNAL_ERROR
// - respondApproval：appService 或 taskManager 缺席 → NOT_INITIALIZED 完整文案；否则 payload 原样交 resolvePlanApproval 并回传结果
// - PlanApprovalError → 自带 code；普通 Error → INTERNAL_ERROR；非 Error → String(error)
// - 未知 action → INVALID_ACTION + `Unknown action: <action>`
// 迁表后本文件零改动全绿即行为不变证明。PlanApprovalError 实例用 Object.create(prototype) 构造，不依赖构造函数签名。

const h = vi.hoisted(() => {
  class PlanApprovalError extends Error {}
  return {
    PlanApprovalError,
    resolvePlanApproval: vi.fn(async (_req: unknown, _deps: unknown): Promise<unknown> => ({ approved: true })),
    logError: vi.fn(),
  };
});

vi.mock('../../../src/host/services/planning/planApprovalService', () => ({
  PlanApprovalError: h.PlanApprovalError,
  resolvePlanApproval: (req: unknown, deps: unknown) => h.resolvePlanApproval(req, deps),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerPlanningHandlers } from '../../../src/host/ipc/planning.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeService(dir = '/plans/sess-1') {
  return {
    getPlanDirectory: vi.fn(() => dir),
    plan: { read: vi.fn(async (): Promise<unknown> => ({ title: 'P' })) },
    findings: { getAll: vi.fn(async (): Promise<unknown[]> => [{ id: 'f1' }]) },
    errors: { getAll: vi.fn(async (): Promise<unknown[]> => [{ id: 'e1' }]) },
  };
}

let svc: ReturnType<typeof makeService> | null;
let appService: unknown;
let taskManager: unknown;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  svc = makeService();
  appService = { id: 'app' };
  taskManager = { id: 'tm' };
  const handlers = new Map<string, HandlerFn>();
  registerPlanningHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => svc as never,
    () => appService as never,
    () => taskManager as never,
  );
  const handler = handlers.get(IPC_DOMAINS.PLANNING)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('planning.ipc dispatch 特征：读取四件套与 session 作用域', () => {
  it('未传 sessionId 或 trim 后与目录名相符 → 委派', async () => {
    expect(await call('getState')).toEqual({ success: true, data: { plan: { title: 'P' }, findings: [{ id: 'f1' }], errors: [{ id: 'e1' }] } });
    expect(await call('getPlan', { sessionId: '  sess-1  ' })).toEqual({ success: true, data: { title: 'P' } });
    expect(await call('getFindings', { sessionId: 'sess-1' })).toEqual({ success: true, data: [{ id: 'f1' }] });
    expect(await call('getErrors', { sessionId: '   ' })).toEqual({ success: true, data: [{ id: 'e1' }] });
  });

  it('sessionId 与目录名不符或服务缺席 → 空形态，不读取', async () => {
    expect(await call('getState', { sessionId: 'other' })).toEqual({ success: true, data: { plan: null, findings: [], errors: [] } });
    expect(await call('getPlan', { sessionId: 'other' })).toEqual({ success: true, data: null });
    expect(await call('getFindings', { sessionId: 'other' })).toEqual({ success: true, data: [] });
    expect(await call('getErrors', { sessionId: 'other' })).toEqual({ success: true, data: [] });
    expect(svc!.plan.read).not.toHaveBeenCalled();
    svc = null;
    expect(await call('getState')).toEqual({ success: true, data: { plan: null, findings: [], errors: [] } });
    expect(await call('getErrors')).toEqual({ success: true, data: [] });
  });

  it('getState / getPlan / getFindings 读取抛错 → 记日志回空形态；getErrors 无兜底 → INTERNAL_ERROR', async () => {
    svc!.plan.read.mockRejectedValueOnce(new Error('p1'));
    expect(await call('getState')).toEqual({ success: true, data: { plan: null, findings: [], errors: [] } });
    expect(h.logError).toHaveBeenLastCalledWith('Failed to get planning state', expect.any(Error));
    svc!.plan.read.mockRejectedValueOnce(new Error('p2'));
    expect(await call('getPlan')).toEqual({ success: true, data: null });
    expect(h.logError).toHaveBeenLastCalledWith('Failed to get plan', expect.any(Error));
    svc!.findings.getAll.mockRejectedValueOnce(new Error('f'));
    expect(await call('getFindings')).toEqual({ success: true, data: [] });
    expect(h.logError).toHaveBeenLastCalledWith('Failed to get findings', expect.any(Error));
    svc!.errors.getAll.mockRejectedValueOnce(new Error('errors store down'));
    expect(await call('getErrors')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'errors store down' } });
  });
});

describe('planning.ipc dispatch 特征：respondApproval', () => {
  it('runtime 缺席 → NOT_INITIALIZED 完整文案，不调审批', async () => {
    const notInit = { success: false, error: { code: 'NOT_INITIALIZED', message: 'Agent runtime is not initialized' } };
    appService = null;
    expect(await call('respondApproval', { id: 'a' })).toEqual(notInit);
    appService = { id: 'app' }; taskManager = null;
    expect(await call('respondApproval', { id: 'a' })).toEqual(notInit);
    expect(h.resolvePlanApproval).not.toHaveBeenCalled();
  });

  it('payload 原样交 resolvePlanApproval 并回传；PlanApprovalError 取自带 code', async () => {
    const req = { requestId: 'r1', decision: 'approve' };
    expect(await call('respondApproval', req)).toEqual({ success: true, data: { approved: true } });
    expect(h.resolvePlanApproval).toHaveBeenCalledWith(req, { appService: { id: 'app' }, taskManager: { id: 'tm' } });
    h.resolvePlanApproval.mockRejectedValueOnce(Object.assign(Object.create(h.PlanApprovalError.prototype), { code: 'APPROVAL_NOT_FOUND', message: 'gone' }));
    expect(await call('respondApproval', req)).toEqual({ success: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'gone' } });
  });
});

describe('planning.ipc dispatch 特征：兜底', () => {
  it('未知 action → INVALID_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('普通 Error 带 code 字段不透传；非 Error → String(error)', async () => {
    h.resolvePlanApproval.mockRejectedValueOnce(Object.assign(new Error('coded'), { code: 'EACCES' }));
    expect(await call('respondApproval', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'coded' } });
    h.resolvePlanApproval.mockRejectedValueOnce('raw approval');
    expect(await call('respondApproval', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw approval' } });
  });
});
