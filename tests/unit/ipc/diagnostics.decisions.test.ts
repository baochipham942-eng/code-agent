import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 /permissions 诊断出口在内存历史之外，还暴露持久化事件账本（重启不丢的证据通道），且 fail-safe。
const dbState = vi.hoisted(() => ({
  count: 0,
  recent: [] as Array<Record<string, unknown>>,
  throwOnGet: false,
}));

vi.mock('../../../src/host/security/decisionHistory', () => ({
  getDecisionHistory: () => ({
    getRecent: () => [],
    getAll: () => [],
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (dbState.throwOnGet) throw new Error('db boom');
    return {
      countPermissionDecisions: () => dbState.count,
      getRecentPermissionDecisions: () => dbState.recent,
    };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

// 捕获注册的 handler
type DiagnosticsHandler = (e: unknown, req: IPCRequest) => Promise<IPCResponse>;

function captureHandler(): DiagnosticsHandler {
  const handlers = new Map<string, DiagnosticsHandler>();
  const fakeIpcMain = {
    handle: (domain: string, fn: DiagnosticsHandler) => {
      handlers.set(domain, fn);
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  const handler = handlers.get(IPC_DOMAINS.DIAGNOSTICS);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

describe('diagnostics IPC · decisions 暴露持久化账本', () => {
  beforeEach(() => {
    dbState.count = 0;
    dbState.recent = [];
    dbState.throwOnGet = false;
  });

  it('返回 persistedTotal + persistedRecent（来自事件账本）', async () => {
    dbState.count = 2;
    dbState.recent = [
      { recordedAt: 200, toolName: 'bash', summary: 'rm -rf *', finalOutcome: 'deny', historyOutcome: 'monitor-blocked', reason: 'rm', durationMs: 2, trace: { steps: [{}, {}] } },
      { recordedAt: 100, toolName: 'Read', summary: 'README.md', finalOutcome: 'allow', historyOutcome: 'auto-approve', reason: '只读', durationMs: 1, trace: { steps: [{}] } },
    ];
    const handler = captureHandler();
    const res = await handler({}, { action: 'decisions' } as IPCRequest);

    expect(res.success).toBe(true);
    const data = res.data as { persistedTotal: number; persistedRecent: Array<Record<string, unknown>> };
    expect(data.persistedTotal).toBe(2);
    expect(data.persistedRecent).toHaveLength(2);
    expect(data.persistedRecent[0]).toMatchObject({ finalOutcome: 'deny', toolName: 'bash', traceSteps: 2 });
    expect(data.persistedRecent[1]).toMatchObject({ finalOutcome: 'allow', traceSteps: 1 });
  });

  it('账本读取抛错时 fail-safe：仍返回成功 + persistedTotal=0，不抛', async () => {
    dbState.throwOnGet = true;
    const handler = captureHandler();
    const res = await handler({}, { action: 'decisions' } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { persistedTotal: number; persistedRecent: unknown[] };
    expect(data.persistedTotal).toBe(0);
    expect(data.persistedRecent).toEqual([]);
  });
});
