import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 ADR-022 第三期(3a) 交付证据通道：/permissions 诊断 sessionLedger 出口暴露
// 「一本账」——一个会话的对话+任务+协同+成本+决策+执行按时间合并读出（纯只读投影）。
const dbState = vi.hoisted(() => ({
  ledger: null as unknown,
  throwOnGet: false,
}));

vi.mock('../../../src/host/security/decisionHistory', () => ({
  getDecisionHistory: () => ({ getRecent: () => [], getAll: () => [] }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (dbState.throwOnGet) throw new Error('db boom');
    return { getSessionLedger: () => dbState.ledger };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
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

describe('diagnostics IPC · sessionLedger 暴露一本账（第三期 3a 交付证据）', () => {
  beforeEach(() => {
    dbState.ledger = null;
    dbState.throwOnGet = false;
  });

  it('返回按时间排序、跨 6 lane 的统一时间线 + 成本汇总', async () => {
    dbState.ledger = {
      sessionId: 'sess-1',
      generatedAt: 12_345,
      cost: { estimatedCost: 0.0875, tokensIn: 1200, tokensOut: 340 },
      laneCounts: { message: 2, task: 2, swarm: 3, decision: 1, execution: 2 },
      entries: [
        { at: 100, lane: 'message', kind: 'user', summary: '帮我跑测试', refId: 'm1' },
        { at: 200, lane: 'task', kind: 'created', summary: '1: 跑测试', refId: '1' },
        { at: 450, lane: 'decision', kind: 'allow', summary: 'Bash: policy', refId: '7' },
        { at: 500, lane: 'execution', kind: 'begin', summary: 'Bash npm test', refId: 'e1' },
      ],
    };
    const handler = captureHandler();
    const res = await handler({}, { action: 'sessionLedger', payload: { sessionId: 'sess-1' } } as IPCRequest);

    expect(res.success).toBe(true);
    const data = res.data as {
      sessionId: string; generatedAt: number;
      cost: { estimatedCost: number }; laneCounts: Record<string, number>;
      entries: Array<{ at: number; lane: string }>;
    };
    expect(data.sessionId).toBe('sess-1');
    expect(data.cost.estimatedCost).toBe(0.0875);
    expect(data.laneCounts).toMatchObject({ message: 2, swarm: 3, execution: 2 });
    // 跨 lane + 时间升序
    expect(new Set(data.entries.map((e) => e.lane))).toEqual(new Set(['message', 'task', 'decision', 'execution']));
    expect(data.entries.map((e) => e.at)).toEqual([100, 200, 450, 500]);
  });

  it('payload.limit 截断保留最近 N 条', async () => {
    dbState.ledger = {
      sessionId: 'sess-1', generatedAt: 1,
      cost: { estimatedCost: 0, tokensIn: 0, tokensOut: 0 },
      laneCounts: { message: 3, task: 0, swarm: 0, decision: 0, execution: 0 },
      entries: [
        { at: 1, lane: 'message', kind: 'user', summary: 'a' },
        { at: 2, lane: 'message', kind: 'assistant', summary: 'b' },
        { at: 3, lane: 'message', kind: 'user', summary: 'c' },
      ],
    };
    const handler = captureHandler();
    const res = await handler({}, { action: 'sessionLedger', payload: { sessionId: 'sess-1', limit: 2 } } as IPCRequest);
    const data = res.data as { entries: Array<{ at: number }> };
    expect(data.entries.map((e) => e.at)).toEqual([2, 3]); // 最近 2 条
  });

  it('缺 sessionId → INVALID_ACTION', async () => {
    const handler = captureHandler();
    const res = await handler({}, { action: 'sessionLedger', payload: {} } as IPCRequest);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_ACTION');
  });

  it('读账抛错 → fail-safe 返回空账结构（不 500）', async () => {
    dbState.throwOnGet = true;
    const handler = captureHandler();
    const res = await handler({}, { action: 'sessionLedger', payload: { sessionId: 'sess-1' } } as IPCRequest);
    expect(res.success).toBe(true);
    const data = res.data as { entries: unknown[]; cost: { estimatedCost: number } };
    expect(data.entries).toEqual([]);
    expect(data.cost.estimatedCost).toBe(0);
  });
});
