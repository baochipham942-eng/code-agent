import { describe, expect, it, vi } from 'vitest';
import { rebuildRunDetail } from '../../../src/main/services/core/swarmRollupProjection';
import {
  runReconcileScan,
  formatReconcileScanReport,
  createDatabaseReconcileReader,
  type ReconcileScanReader,
} from '../../../src/main/services/core/swarmReconcileService';
import type { SwarmLedgerEvent } from '../../../src/shared/contract/swarmLedger';
import type { SwarmRunDetail } from '../../../src/shared/contract/swarmTrace';

// ---- 构造 ledger 事件（沿用 swarmRollupProjection.test 的造法）----
let autoId = 1;
function ev(over: Partial<SwarmLedgerEvent> & Pick<SwarmLedgerEvent, 'seq' | 'kind'>): SwarmLedgerEvent {
  return { id: autoId++, runId: 'run-1', sessionId: 's1', agentId: null, payload: {}, recordedAt: 100 + over.seq, ...over };
}
const agentSnap = (runId: string, seq: number, agentId: string, status: string, over: Record<string, unknown> = {}): SwarmLedgerEvent =>
  ev({ runId, seq, kind: 'agent_snapshot', agentId, payload: { agentId, name: agentId, role: 'worker', status, startTime: 100, endTime: status === 'running' ? null : 200, durationMs: status === 'running' ? null : 100, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [], ...over } });

/** 一次已收尾（含 run_closed）的 run 的 ledger 事件 */
function closedRunEvents(runId: string, agentOver: Record<string, unknown> = {}): SwarmLedgerEvent[] {
  return [
    ev({ runId, seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
    agentSnap(runId, 1, 'a1', 'completed', { tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, ...agentOver }),
    ev({ runId, seq: 2, kind: 'run_closed', payload: { status: 'completed', endedAt: 300, completedCount: 1, failedCount: 0, parallelPeak: 1, totalTokensIn: 10, totalTokensOut: 5, totalToolCalls: 1, totalCostUsd: 0.01, errorSummary: null, aggregation: null, tags: [] } }),
  ];
}
/** 半套账本：有 run_started + running snapshot，无 run_closed（运行中）。 */
function inProgressRunEvents(runId: string): SwarmLedgerEvent[] {
  return [
    ev({ runId, seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
    agentSnap(runId, 1, 'a1', 'running'),
  ];
}

type RunFixture = { ledger: SwarmLedgerEvent[]; stored: SwarmRunDetail | null; throwOnLedger?: boolean };
function makeReader(runs: Record<string, RunFixture>): ReconcileScanReader {
  return {
    listRunIds: (limit?: number) => Object.keys(runs).slice(0, limit ?? Object.keys(runs).length),
    getLedgerByRun: (id: string) => {
      const r = runs[id];
      if (r?.throwOnLedger) throw new Error('boom: ledger read failed');
      return r?.ledger ?? [];
    },
    getStoredRunDetail: (id: string) => runs[id]?.stored ?? null,
  };
}

const NOW = 1_700_000_000_000;

describe('runReconcileScan（第四期 · 后台对账扫描核心，纯只读）', () => {
  it('ledger 与 rollup 一致的 run → 计入 matched，无 drift/skip/error', () => {
    const events = closedRunEvents('A');
    const reader = makeReader({ A: { ledger: events, stored: rebuildRunDetail(events) } });

    const report = runReconcileScan(reader, { now: NOW });

    expect(report.generatedAt).toBe(NOW);
    expect(report.scannedCount).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.drifted).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  it('ledger 重建与 rollup 不符的 run → 计入 drifted', () => {
    const events = closedRunEvents('B');
    const stored = rebuildRunDetail(events)!;
    const drifted = { ...stored, run: { ...stored.run, totalTokensOut: 999 } }; // 篡改一字段制造 drift
    const reader = makeReader({ B: { ledger: events, stored: drifted } });

    const report = runReconcileScan(reader, { now: NOW });

    expect(report.matched).toBe(0);
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0].runId).toBe('B');
    expect(report.drifted[0].match).toBe(false);
    expect(report.drifted[0].drift.some((d) => d.field === 'totalTokensOut')).toBe(true);
  });

  it('老 run（有 rollup 无 ledger）→ 归 skipped(ledger-missing)，不算 drift/error', () => {
    const storedOnly = rebuildRunDetail(closedRunEvents('C'))!;
    const reader = makeReader({ C: { ledger: [], stored: storedOnly } });

    const report = runReconcileScan(reader, { now: NOW });

    expect(report.drifted).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toEqual({ runId: 'C', note: 'ledger-missing' });
  });

  it('正在运行的 run（半套账本、无 run_closed）→ 归 skipped(in-progress)，不误报 drift', () => {
    const events = inProgressRunEvents('D');
    // rollup 里是一个不同状态的快照，若参与对账会 drift；但 running 应被跳过
    const reader = makeReader({ D: { ledger: events, stored: rebuildRunDetail(closedRunEvents('D')) } });

    const report = runReconcileScan(reader, { now: NOW });

    expect(report.drifted).toHaveLength(0);
    expect(report.matched).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toEqual({ runId: 'D', note: 'in-progress' });
  });

  it('单个 run 读取抛错 → 计入 errors 且隔离，不中断其余 run 扫描', () => {
    const okEvents = closedRunEvents('OK');
    const reader = makeReader({
      BAD: { ledger: [], stored: null, throwOnLedger: true },
      OK: { ledger: okEvents, stored: rebuildRunDetail(okEvents) },
    });

    const report = runReconcileScan(reader, { now: NOW });

    expect(report.scannedCount).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].runId).toBe('BAD');
    expect(report.errors[0].error).toContain('boom');
    expect(report.matched).toBe(1); // OK 仍被正常对账
  });

  it('coverageNote 如实反映扫描范围与 limit，不做无声截断', () => {
    const runs: Record<string, RunFixture> = {};
    for (let i = 0; i < 5; i++) {
      const e = closedRunEvents(`R${i}`);
      runs[`R${i}`] = { ledger: e, stored: rebuildRunDetail(e) };
    }
    const reader = makeReader(runs);

    const report = runReconcileScan(reader, { now: NOW, limit: 3 });

    expect(report.scannedCount).toBe(3); // limit 生效
    expect(report.coverageNote).toContain('3');
    expect(report.matched).toBe(3);
  });
});

describe('formatReconcileScanReport（对账摘要文本，进 Dream 报告/运行证据）', () => {
  it('全匹配 → 含「对账」标题与统计(coverageNote)', () => {
    const events = closedRunEvents('A');
    const report = runReconcileScan(makeReader({ A: { ledger: events, stored: rebuildRunDetail(events) } }), { now: NOW });
    const text = formatReconcileScanReport(report);
    expect(text).toContain('对账');
    expect(text).toContain(report.coverageNote);
  });

  it('有偏差 → 列出 drift 的 runId 与字段', () => {
    const events = closedRunEvents('B');
    const stored = rebuildRunDetail(events)!;
    const drifted = { ...stored, run: { ...stored.run, totalTokensOut: 999 } };
    const report = runReconcileScan(makeReader({ B: { ledger: events, stored: drifted } }), { now: NOW });
    const text = formatReconcileScanReport(report);
    expect(text).toContain('B');
    expect(text).toContain('totalTokensOut');
  });

  it('有错误 → 列出 error 的 runId', () => {
    const report = runReconcileScan(makeReader({ BAD: { ledger: [], stored: null, throwOnLedger: true } }), { now: NOW });
    const text = formatReconcileScanReport(report);
    expect(text).toContain('BAD');
  });
});

describe('createDatabaseReconcileReader（生产适配器，委托 db 只读口）', () => {
  it('listRunIds/getLedgerByRun/getStoredRunDetail 正确委托 db（stored 取 raw rollup）', () => {
    const events = closedRunEvents('Z');
    const stored = rebuildRunDetail(events);
    const getRunDetail = vi.fn(() => stored);
    const db = {
      listSwarmLedgerRunIds: vi.fn((_s?: string, limit?: number) => ['Z'].slice(0, limit ?? 1)),
      getSwarmLedgerByRun: vi.fn(() => events),
      getSwarmTraceRepo: vi.fn(() => ({ getRunDetail })),
    };
    const reader = createDatabaseReconcileReader(db);

    expect(reader.listRunIds(10)).toEqual(['Z']);
    expect(reader.getLedgerByRun('Z')).toBe(events);
    expect(reader.getStoredRunDetail('Z')).toBe(stored);
    expect(db.getSwarmLedgerByRun).toHaveBeenCalledWith('Z');
    expect(getRunDetail).toHaveBeenCalledWith('Z'); // raw rollup（非 PreferLedger，避免循环自证）
  });
});
