import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 第四期 步骤3：诊断出口 swarmReconcileScan —— 按需返回「批量对账扫描报告」(ReconcileScanReport)，
// 供手动拉演示证据。纯只读、fail-safe。
const dbState = vi.hoisted(() => ({ runIds: [] as string[], throwOnGet: false }));

vi.mock('../../../src/host/security/decisionHistory', () => ({
  getDecisionHistory: () => ({ getRecent: () => [], getAll: () => [] }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (dbState.throwOnGet) throw new Error('db boom');
    return {
      listSwarmLedgerRunIds: (_s?: string, limit?: number) => dbState.runIds.slice(0, limit ?? dbState.runIds.length),
      getSwarmLedgerByRun: () => [],
      getSwarmTraceRepo: () => ({ getRunDetail: () => null }),
    };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

type DiagnosticsHandler = (e: unknown, req: IPCRequest) => Promise<IPCResponse>;

function captureHandler(): DiagnosticsHandler {
  const handlers = new Map<string, DiagnosticsHandler>();
  registerDiagnosticsHandlers({
    handle: (domain: string, fn: DiagnosticsHandler) => {
      handlers.set(domain, fn);
    },
  } as never);
  const handler = handlers.get(IPC_DOMAINS.DIAGNOSTICS);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('diagnostics IPC · swarmReconcileScan（第四期 后台对账扫描出口）', () => {
  beforeEach(() => { dbState.runIds = []; dbState.throwOnGet = false; });

  it('返回批量对账扫描报告（scannedCount/coverageNote 等）', async () => {
    dbState.runIds = ['run-1'];
    const res = await captureHandler()({}, { action: 'swarmReconcileScan', payload: {} } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { scannedCount: number; coverageNote: string; skipped: unknown[] };
    expect(data.scannedCount).toBe(1);
    expect(data.coverageNote).toContain('1');
    expect(Array.isArray(data.skipped)).toBe(true);
  });

  it('读账抛错 → fail-safe（不 500），返回空报告', async () => {
    dbState.throwOnGet = true;
    const res = await captureHandler()({}, { action: 'swarmReconcileScan', payload: {} } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { scannedCount: number; coverageNote: string };
    expect(data.scannedCount).toBe(0);
    expect(data.coverageNote).toContain('error');
  });
});
