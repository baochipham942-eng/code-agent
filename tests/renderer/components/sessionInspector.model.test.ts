// SessionInspector 投影模型测试：分段 / 印章三态 / tail 增量 / 组装面板 / 格式化
import { describe, expect, it } from 'vitest';
import type { TraceLedgerEvent, TraceSessionRead } from '../../../src/renderer/services/traceLedgerClient';
import {
  applyTail,
  buildAssemblyModel,
  formatTokenCount,
  readTurnOutcome,
  segmentTurns,
} from '../../../src/renderer/components/TaskPanel/SessionInspector/model';

function event(type: string, data: unknown, turnIndex = 1, ts = 1000): TraceLedgerEvent {
  return { ts, sessionId: 's1', turnIndex, type, data };
}

function outcome(verdict: string, terminal = 'completed', ts = 2000): TraceLedgerEvent {
  return event('turn_outcome', { terminal, verdict, evidenceRefs: verdict === 'verified' ? [{ kind: 'tool', ref: 'x' }] : [], source: 'generic' }, 1, ts);
}

describe('segmentTurns', () => {
  it('按 turn_outcome 切轮，末尾无印章的段是进行中', () => {
    const events = [
      event('inference', { inputTokens: 100, outputTokens: 50 }, 1, 1000),
      outcome('verified', 'completed', 2000),
      event('inference', { inputTokens: 10, outputTokens: 5 }, 1, 3000),
      outcome('self_claimed', 'completed', 4000),
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 5, error: null, fromCache: false }, 1, 5000),
    ];
    const segments = segmentTurns(events);
    expect(segments).toHaveLength(3);
    expect(segments[0].stamp?.verdict).toBe('verified');
    expect(segments[0].inProgress).toBe(false);
    expect(segments[1].stamp?.verdict).toBe('self_claimed');
    expect(segments[2].stamp).toBeNull();
    expect(segments[2].inProgress).toBe(true);
    expect(segments.map((segment) => segment.index)).toEqual([1, 2, 3]);
  });

  it('turnIndex 跨 run 重启也不会并轮（run 分界只看印章）', () => {
    // 两个 run 各自迭代 1..2，turnIndex 相同但印章分两轮
    const events = [
      event('inference', { inputTokens: 1, outputTokens: 1 }, 1, 1000),
      event('inference', { inputTokens: 1, outputTokens: 1 }, 2, 1500),
      outcome('verified', 'completed', 2000),
      event('inference', { inputTokens: 1, outputTokens: 1 }, 1, 3000),
      outcome('n_a', 'cancelled', 4000),
    ];
    const segments = segmentTurns(events);
    expect(segments).toHaveLength(2);
    expect(segments[0].inferences).toHaveLength(2);
    expect(segments[1].stamp?.verdict).toBe('n_a');
    expect(segments[1].stamp?.terminal).toBe('cancelled');
  });

  it('聚合段内 token / 工具桶 / 失败计数 / 缓存', () => {
    const events = [
      event('inference', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 }, 1, 1000),
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 3, error: null, fromCache: false }, 1, 1100),
      event('tool_dispatch', { toolName: 'Edit', success: false, durationMs: 3, error: 'boom', fromCache: false }, 1, 1200),
      event('tool_dispatch', { toolName: 'Bash', success: true, durationMs: 3, error: null, fromCache: true }, 1, 1300),
      outcome('self_claimed', 'completed', 2000),
    ];
    const [segment] = segmentTurns(events);
    expect(segment.tokens).toEqual({ input: 1000, output: 200, cacheRead: 300 });
    expect(segment.toolCounts).toEqual({ read: 1, write: 1, command: 1, browser: 0, other: 0 });
    expect(segment.failedToolCount).toBe(1);
  });
});

describe('readTurnOutcome', () => {
  it('非 turn_outcome / 非对象包络返回 null', () => {
    expect(readTurnOutcome(event('inference', {}))).toBeNull();
    expect(readTurnOutcome({ type: 'turn_outcome', data: 'junk' })).toBeNull();
  });

  it('非法 verdict 如实置空，不臆造', () => {
    const stamp = readTurnOutcome(outcome('maybe'));
    expect(stamp?.verdict).toBeNull();
  });
});

describe('applyTail', () => {
  const base: TraceSessionRead = {
    sessionId: 's1',
    state: 'present',
    events: [outcome('verified', 'completed', 2000)],
    skippedLines: 1,
    cursor: 100,
  };

  it('增量事件追加不重复，游标前进，skippedLines 累加', () => {
    const tail: TraceSessionRead = {
      sessionId: 's1',
      state: 'present',
      events: [outcome('self_claimed', 'completed', 4000)],
      skippedLines: 2,
      cursor: 200,
    };
    const merged = applyTail(base, tail);
    expect(merged.events).toHaveLength(2);
    expect(merged.cursor).toBe(200);
    expect(merged.skippedLines).toBe(3);
    // 再合一次同样的 tail（重试/重复帧）不会重复追加的前提是游标相同且无事件
    const noProgress: TraceSessionRead = { ...tail, events: [], cursor: 200, skippedLines: 0 };
    const remerged = applyTail(merged, noProgress);
    expect(remerged.events).toHaveLength(2);
  });

  it('游标不动且无新事件时保留已有事件', () => {
    const merged = applyTail(base, { sessionId: 's1', state: 'present', events: [], skippedLines: 0, cursor: 100 });
    expect(merged.events).toHaveLength(1);
    expect(merged.cursor).toBe(100);
  });
});

describe('buildAssemblyModel', () => {
  it('取最新 manifest 投影工具面与提示词段', () => {
    const manifest = {
      requestId: 'r1',
      messageRefs: [
        { kind: 'system_prompt', contentHash: 'a'.repeat(64) },
        { kind: 'ledger_message', messageId: 'm1' },
        { kind: 'content', contentHash: 'b'.repeat(64), reason: 'dynamic_tail' },
        { kind: 'content', contentHash: 'c'.repeat(64), reason: 'runtime_injection' },
      ],
      toolSchemaHash: 'd'.repeat(64),
      toolNames: ['Read', 'Edit'],
      requested: { provider: 'p', model: 'm-old', temperature: null, maxTokens: null, reasoningEffort: null, thinkingBudget: null },
      actualProvider: 'p',
      actualModel: 'm-new',
      appVersion: '1.2.3',
      adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
      compactionReplacements: [],
      degraded: false,
    };
    const events = [
      event('request_manifest', { ...manifest, requestId: 'r-old', toolNames: ['Old'] }, 1, 1000),
      event('request_manifest', manifest, 2, 1500),
      event('compaction', { layersTriggered: [], totalTokens: 1, commitCount: 1, autocompactNeeded: false }, 2, 1600),
      event('verification', { status: 'ok', skippedChecks: [{ id: 'x' }] }, 2, 1700),
      outcome('verified', 'completed', 2000),
    ];
    const model = buildAssemblyModel(events);
    expect(model.hasManifest).toBe(true);
    expect(model.model).toBe('m-new');
    expect(model.toolNames).toEqual(['Read', 'Edit']);
    expect(model.promptSegments).toEqual({
      systemPrompt: 1,
      ledgerMessage: 1,
      dynamicTail: 1,
      runtimeInjection: 1,
      postAssemblyRewrite: 0,
    });
    expect(model.compactionCount).toBe(1);
    expect(model.verificationCount).toBe(1);
    expect(model.verificationSkippedCount).toBe(1);
  });

  it('无 manifest（存量会话）如实 hasManifest=false', () => {
    const model = buildAssemblyModel([outcome('verified')]);
    expect(model.hasManifest).toBe(false);
    expect(model.toolNames).toEqual([]);
    expect(model.model).toBeNull();
  });
});

describe('工具归桶（走 segmentTurns 公共入口）/ formatTokenCount', () => {
  it('工具名按模式归桶', () => {
    const dispatch = (toolName: string) =>
      event('tool_dispatch', { toolName, success: true, durationMs: 1, error: null, fromCache: false }, 1, 1100);
    const [segment] = segmentTurns([
      dispatch('Read'), dispatch('Grep'), dispatch('Edit'), dispatch('Bash'),
      dispatch('browser_navigate'), dispatch('TodoWrite'), dispatch('SomeMysteryTool'),
      outcome('verified', 'completed', 2000),
    ]);
    expect(segment.toolCounts).toEqual({ read: 2, write: 2, command: 1, browser: 1, other: 1 });
  });

  it('token 人话格式化', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(12345)).toBe('12k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });
});
