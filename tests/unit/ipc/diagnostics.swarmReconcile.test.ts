import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 ADR-022 第三期(3b) 交付证据通道：/permissions 诊断 swarmReconcile 出口暴露
// "从 ledger 重建的 rollup vs 现存表"的影子对账结果。
const dbState = vi.hoisted(() => ({ result: null as unknown, throwOnGet: false }));

vi.mock('../../../src/host/security/decisionHistory', () => ({
  getDecisionHistory: () => ({ getRecent: () => [], getAll: () => [] }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (dbState.throwOnGet) throw new Error('db boom');
    return { reconcileSwarmRun: () => dbState.result };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

function captureHandler() {
  let handler: ((e: unknown, req: IPCRequest) => Promise<IPCResponse>) | null = null;
  registerDiagnosticsHandlers({
    handle: (domain: string, fn: (e: unknown, req: IPCRequest) => Promise<IPCResponse>) => {
      if (domain === IPC_DOMAINS.DIAGNOSTICS) handler = fn;
    },
  } as never);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('diagnostics IPC · swarmReconcile（第三期 3b 交付证据）', () => {
  beforeEach(() => { dbState.result = null; dbState.throwOnGet = false; });

  it('返回对账结果（match + drift）', async () => {
    dbState.result = { runId: 'run-1', match: true, drift: [] };
    const res = await captureHandler()({}, { action: 'swarmReconcile', payload: { runId: 'run-1' } } as IPCRequest);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ runId: 'run-1', match: true, drift: [] });
  });

  it('缺 runId → INVALID_ACTION', async () => {
    const res = await captureHandler()({}, { action: 'swarmReconcile', payload: {} } as IPCRequest);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_ACTION');
  });

  it('读账抛错 → fail-safe（不 500）', async () => {
    dbState.throwOnGet = true;
    const res = await captureHandler()({}, { action: 'swarmReconcile', payload: { runId: 'run-1' } } as IPCRequest);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ runId: 'run-1', match: false, note: 'reconcile-error' });
  });
});
