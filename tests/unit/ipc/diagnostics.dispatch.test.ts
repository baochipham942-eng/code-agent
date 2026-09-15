import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// diagnostics.ipc.ts 派发特征测试补齐（RQ-183 续作·DIAGNOSTICS 刀迁表前钉住现状）：
// 既有 9 个文件各测一个 action；这里补 execPolicy / budget / compression 三个 action 的输出
// 裁剪形状，以及未知 action 的 INVALID_ACTION 'Unknown diagnostics action:' 契约与抛错兜底
// INTERNAL_ERROR（Error → message、非 Error → String(error)）。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  getRules: vi.fn(() => [
    { pattern: 'git *', decision: 'allow', createdAt: 1, source: 'user', internalNote: 'hidden' },
  ] as unknown[]),
  checkBudget: vi.fn(() => ({ currentCost: 1.5, maxBudget: 10, usagePercentage: 15, alertLevel: 'none', extra: true })),
  getStats: vi.fn(() => ({ compressionCount: 3, totalSavedTokens: 1200, lastRunAt: 99 })),
}));

vi.mock('../../../src/host/security/execPolicy', () => ({
  getExecPolicyStore: () => ({ getRules: h.getRules }),
}));
vi.mock('../../../src/host/services/core/budgetService', () => ({
  getBudgetService: () => ({ checkBudget: h.checkBudget }),
}));
vi.mock('../../../src/host/context/autoCompressor', () => ({
  getAutoCompressor: () => ({ getStats: h.getStats }),
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';

type DiagnosticsHandler = (e: unknown, req: IPCRequest) => Promise<IPCResponse>;

function captureHandler(): DiagnosticsHandler {
  const handlers = new Map<string, DiagnosticsHandler>();
  registerDiagnosticsHandlers({ handle: (domain: string, fn: DiagnosticsHandler) => handlers.set(domain, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.DIAGNOSTICS);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

const call = (action: string, payload?: unknown) => captureHandler()(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('diagnostics dispatch 特征', () => {
  it('execPolicy：规则只暴露 pattern/decision/createdAt/source 四个字段', async () => {
    expect(await call('execPolicy')).toEqual({
      success: true,
      data: { rules: [{ pattern: 'git *', decision: 'allow', createdAt: 1, source: 'user' }] },
    });
  });

  it('budget：只暴露 currentCost/maxBudget/usagePercentage', async () => {
    expect(await call('budget')).toEqual({
      success: true,
      data: { currentCost: 1.5, maxBudget: 10, usagePercentage: 15 },
    });
  });

  it('compression：只暴露 compressionCount/totalSavedTokens', async () => {
    expect(await call('compression')).toEqual({
      success: true,
      data: { compressionCount: 3, totalSavedTokens: 1200 },
    });
  });

  it('未知 action → INVALID_ACTION + Unknown diagnostics action 文案', async () => {
    expect(await call('bogus')).toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown diagnostics action: bogus' },
    });
  });

  it('抛 Error → INTERNAL_ERROR + message；非 Error → String(error)', async () => {
    h.getRules.mockImplementationOnce(() => {
      throw new Error('policy store down');
    });
    expect(await call('execPolicy')).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'policy store down' },
    });
    h.getStats.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('compression')).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });
});
