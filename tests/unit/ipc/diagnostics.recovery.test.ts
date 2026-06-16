import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 ADR-022 第二期交付证据通道：/permissions 诊断 recovery 出口暴露"启动时从总账
// 重建出的崩溃现场快照"（在飞工具+参数+session），且 fail-safe。
const dbState = vi.hoisted(() => ({
  snapshot: null as unknown,
  throwOnGet: false,
}));

vi.mock('../../../src/main/security/decisionHistory', () => ({
  getDecisionHistory: () => ({ getRecent: () => [], getAll: () => [] }),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => {
    if (dbState.throwOnGet) throw new Error('db boom');
    return { getLastRecoverySnapshot: () => dbState.snapshot };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/main/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

function captureHandler() {
  let handler: ((e: unknown, req: IPCRequest) => Promise<IPCResponse>) | null = null;
  const fakeIpcMain = {
    handle: (domain: string, fn: (e: unknown, req: IPCRequest) => Promise<IPCResponse>) => {
      if (domain === IPC_DOMAINS.DIAGNOSTICS) handler = fn;
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

describe('diagnostics IPC · recovery 暴露崩溃现场快照（第二期交付证据）', () => {
  beforeEach(() => {
    dbState.snapshot = null;
    dbState.throwOnGet = false;
  });

  it('返回 totalInFlight + 按 session 的在飞工具+参数（重建现场）', async () => {
    dbState.snapshot = {
      recoveredAt: 50_000,
      totalInFlight: 1,
      sessions: [{
        sessionId: 'live-session',
        operations: [{
          executionId: 'crash-exec', toolName: 'Bash', summary: 'pnpm run migrate',
          params: { command: 'pnpm run migrate', cwd: '/repo' }, startedAt: 42_000, elapsedMs: 8_000,
        }],
      }],
    };
    const handler = captureHandler();
    const res = await handler({}, { action: 'recovery' } as IPCRequest);

    expect(res.success).toBe(true);
    const data = res.data as { totalInFlight: number; sessions: Array<{ sessionId: string; operations: Array<Record<string, unknown>> }> };
    expect(data.totalInFlight).toBe(1);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionId).toBe('live-session');
    const op = data.sessions[0].operations[0];
    expect(op).toMatchObject({
      toolName: 'Bash',
      summary: 'pnpm run migrate',
      params: { command: 'pnpm run migrate', cwd: '/repo' },
      startedAt: 42_000,
      elapsedMs: 8_000,
    });
  });

  it('无崩溃现场（snapshot=null）→ 成功返回 totalInFlight=0、sessions 空', async () => {
    dbState.snapshot = null;
    const handler = captureHandler();
    const res = await handler({}, { action: 'recovery' } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { totalInFlight: number; sessions: unknown[] };
    expect(data.totalInFlight).toBe(0);
    expect(data.sessions).toEqual([]);
  });

  it('账本读取抛错时 fail-safe：仍返回成功 + totalInFlight=0，不抛', async () => {
    dbState.throwOnGet = true;
    const handler = captureHandler();
    const res = await handler({}, { action: 'recovery' } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { totalInFlight: number; sessions: unknown[] };
    expect(data.totalInFlight).toBe(0);
    expect(data.sessions).toEqual([]);
  });
});
