import { describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 第四期 步骤5：opt-in 老库迁移出口（默认不自动跑，仅手动/诊断触发）。fail-safe。
vi.mock('../../../src/main/security/decisionHistory', () => ({
  getDecisionHistory: () => ({ getRecent: () => [], getAll: () => [] }),
}));
vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => null }),
}));

import { registerDiagnosticsHandlers } from '../../../src/main/ipc/diagnostics.ipc';
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

describe('diagnostics IPC · swarmLedgerBackfill（opt-in 老库迁移）', () => {
  it('db 不可用 → fail-safe 返回 errors，不 500', async () => {
    const res = await captureHandler()({}, { action: 'swarmLedgerBackfill', payload: {} } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { backfilled: unknown[]; skipped: unknown[]; errors: { runId: string }[] };
    expect(data.backfilled).toEqual([]);
    expect(data.errors.length).toBeGreaterThan(0);
  });
});
