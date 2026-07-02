// ============================================================================
// priorRunProjection 单测 — retry = projection continuation
// 失败 run 重试时，从 session 一本账派生有界结构化现场（未完成任务 + 最近失败
// 的验证/工具错误），注入新 attempt 首条上下文，替代模型从 transcript 重新考古。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildPriorRunProjection } from '../../../src/host/handoff/priorRunProjection';
import { EMPTY_LEDGER_COST, type SessionLedger, type LedgerEntry } from '../../../src/shared/contract/sessionLedger';

function ledger(entries: LedgerEntry[]): SessionLedger {
  return {
    sessionId: 'sess-1',
    generatedAt: 1_000_000,
    entries,
    cost: EMPTY_LEDGER_COST,
    laneCounts: { message: 0, task: 0, swarm: 0, decision: 0, execution: 0 },
  };
}

describe('buildPriorRunProjection', () => {
  it('空账 → null（无现场可投影，调用方回退纯文本提案）', () => {
    expect(buildPriorRunProjection(ledger([]))).toBeNull();
  });

  it('未完成任务：取每个 taskId 的末态，排除 done/deleted/cancelled', () => {
    const text = buildPriorRunProjection(ledger([
      { at: 1, lane: 'task', kind: 'created', summary: 't1: 写迁移脚本', refId: 't1' },
      { at: 2, lane: 'task', kind: 'created', summary: 't2: 补单测', refId: 't2' },
      { at: 3, lane: 'task', kind: 'done', summary: 't1: 写迁移脚本', refId: 't1' },
    ]));
    expect(text).toContain('t2: 补单测');
    expect(text).not.toContain('写迁移脚本');
  });

  it('最近失败：execution lane 的 error 事件取尾部若干条（含 goal 闸裁决）', () => {
    const text = buildPriorRunProjection(ledger([
      { at: 1, lane: 'execution', kind: 'complete:error', summary: 'bash npm test 失败', refId: 'e1', detail: { error: '2 tests failed' } },
      { at: 2, lane: 'execution', kind: 'complete:success', summary: 'read_file ok', refId: 'e2' },
      { at: 3, lane: 'execution', kind: 'complete:error', summary: 'goal_gate_verdict gate1 repair_prompt (attempt 1/2)', refId: 'e3', detail: { error: 'exit 1' } },
    ]));
    expect(text).toContain('npm test 失败');
    expect(text).toContain('goal_gate_verdict');
    expect(text).not.toContain('read_file ok');
  });

  it('有界：超出 maxChars 截断且以完整行收尾', () => {
    const entries: LedgerEntry[] = Array.from({ length: 200 }, (_, i) => ({
      at: i,
      lane: 'task' as const,
      kind: 'created',
      summary: `t${i}: ${'长任务描述'.repeat(20)}`,
      refId: `t${i}`,
    }));
    const text = buildPriorRunProjection(ledger(entries), { maxChars: 800 });
    expect(text).not.toBeNull();
    expect((text as string).length).toBeLessThanOrEqual(800);
    expect((text as string).endsWith('…')).toBe(true);
  });

  it('cancelled 落账为 abandoned 也算终态，不进未完成清单（codex audit M2）', () => {
    expect(buildPriorRunProjection(ledger([
      { at: 1, lane: 'task', kind: 'created', summary: 't1: 被取消的任务', refId: 't1' },
      { at: 2, lane: 'task', kind: 'abandoned', summary: 't1: 被取消的任务', refId: 't1' },
    ]))).toBeNull();
  });

  it('slice(-N) 取"最近有动静"的任务：老任务有新事件应刷新到尾部（codex audit M3）', () => {
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push({ at: i, lane: 'task', kind: 'created', summary: `t${i}: 任务${i}`, refId: `t${i}` });
    }
    // t0 在最后又有动静 → 应挤进"最近 10 个"，t1 作为最旧的被挤出
    entries.push({ at: 100, lane: 'task', kind: 'started', summary: 't0: 任务0', refId: 't0' });
    const text = buildPriorRunProjection(ledger(entries));
    expect(text).toContain('t0: 任务0');
    expect(text).not.toContain('t1: 任务1');
  });

  it('只有成功事件、无未完成任务 → null（没有值得续跑的现场）', () => {
    expect(buildPriorRunProjection(ledger([
      { at: 1, lane: 'execution', kind: 'complete:success', summary: 'ok', refId: 'e1' },
      { at: 2, lane: 'task', kind: 'done', summary: 't1: 完成', refId: 't1' },
    ]))).toBeNull();
  });
});
