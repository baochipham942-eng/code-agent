import { describe, it, expect } from 'vitest';
import {
  emptyScriptRunSnapshot,
  applyScriptRunEvent,
  type ScriptRunEvent,
  type ScriptRunSnapshot,
} from '@shared/contract/scriptRun';

// 折叠一串事件，便于断言终态快照。
function fold(runId: string, events: ScriptRunEvent[]): ScriptRunSnapshot {
  return events.reduce((snap, e) => applyScriptRunEvent(snap, e), emptyScriptRunSnapshot(runId));
}

const ev = (type: ScriptRunEvent['type'], ts: number, data?: Record<string, unknown>): ScriptRunEvent => ({
  runId: 'run-1',
  type,
  ts,
  data,
});

describe('scriptRun view-model: emptyScriptRunSnapshot', () => {
  it('初始快照是 pending、空集合、计数归零', () => {
    const snap = emptyScriptRunSnapshot('run-1');
    expect(snap.runId).toBe('run-1');
    expect(snap.status).toBe('pending');
    expect(snap.phases).toEqual([]);
    expect(snap.logs).toEqual([]);
    expect(snap.agents).toEqual([]);
    expect(snap.runningCount).toBe(0);
    expect(snap.doneCount).toBe(0);
    expect(snap.errorCount).toBe(0);
  });
});

describe('scriptRun view-model: applyScriptRunEvent', () => {
  it('run:start 置 running 并记录 goal/scriptHash/startedAt', () => {
    const snap = fold('run-1', [ev('run:start', 1000, { goal: '调研 X', scriptHash: 'abc123' })]);
    expect(snap.status).toBe('running');
    expect(snap.goal).toBe('调研 X');
    expect(snap.scriptHash).toBe('abc123');
    expect(snap.startedAt).toBe(1000);
  });

  it('run:phase 去重累积 phases 并把 currentPhase 设为最新', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:phase', 1100, { title: 'decompose' }),
      ev('run:phase', 1200, { title: 'investigate' }),
      ev('run:phase', 1300, { title: 'investigate' }), // 重复不应再 push
    ]);
    expect(snap.phases).toEqual(['decompose', 'investigate']);
    expect(snap.currentPhase).toBe('investigate');
  });

  it('run:log 按序累积日志', () => {
    const snap = fold('run-1', [
      ev('run:log', 1100, { message: '第一条' }),
      ev('run:log', 1200, { message: '第二条' }),
    ]);
    expect(snap.logs).toEqual(['第一条', '第二条']);
  });

  it('agent:start 新建 running agent，携带 phase/promptPreview/provider/model/hasSchema', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, {
        agentId: 'run-1-a1',
        label: 'find',
        phase: 'investigate',
        promptPreview: '搜索 Rust 异步运行时',
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        hasSchema: true,
      }),
    ]);
    expect(snap.agents).toHaveLength(1);
    const a = snap.agents[0];
    expect(a.id).toBe('run-1-a1');
    expect(a.label).toBe('find');
    expect(a.phase).toBe('investigate');
    expect(a.promptPreview).toBe('搜索 Rust 异步运行时');
    expect(a.provider).toBe('xiaomi');
    expect(a.model).toBe('mimo-v2.5-pro');
    expect(a.hasSchema).toBe(true);
    expect(a.status).toBe('running');
    expect(a.startedAt).toBe(1100);
    expect(snap.runningCount).toBe(1);
  });

  it('agent:done 把对应 agent 置 done 并更新计数与 resultPreview', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'run-1-a1', label: 'find' }),
      ev('agent:done', 1500, { agentId: 'run-1-a1', label: 'find', resultPreview: '找到 3 条' }),
    ]);
    const a = snap.agents[0];
    expect(a.status).toBe('done');
    expect(a.resultPreview).toBe('找到 3 条');
    expect(a.finishedAt).toBe(1500);
    expect(snap.runningCount).toBe(0);
    expect(snap.doneCount).toBe(1);
    expect(snap.errorCount).toBe(0);
  });

  it('agent:error 把对应 agent 置 error 并记录 error', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'run-1-a1', label: 'find' }),
      ev('agent:error', 1400, { agentId: 'run-1-a1', label: 'find', error: 'timeout' }),
    ]);
    const a = snap.agents[0];
    expect(a.status).toBe('error');
    expect(a.error).toBe('timeout');
    expect(snap.errorCount).toBe(1);
    expect(snap.runningCount).toBe(0);
  });

  it('多 agent 并行时计数正确（2 running → 1 done 1 error）', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'a1', label: 'x' }),
      ev('agent:start', 1110, { agentId: 'a2', label: 'y' }),
      ev('agent:done', 1500, { agentId: 'a1', label: 'x' }),
      ev('agent:error', 1600, { agentId: 'a2', label: 'y', error: 'boom' }),
    ]);
    expect(snap.agents).toHaveLength(2);
    expect(snap.runningCount).toBe(0);
    expect(snap.doneCount).toBe(1);
    expect(snap.errorCount).toBe(1);
  });

  it('run:done 置 completed、记录 result 与 durationMs', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:done', 4000, { result: { report: 'ok' } }),
    ]);
    expect(snap.status).toBe('completed');
    expect(snap.result).toEqual({ report: 'ok' });
    expect(snap.finishedAt).toBe(4000);
    expect(snap.durationMs).toBe(3000);
  });

  it('run:error 置 failed 并记录 error', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:error', 2500, { error: '脚本语法错误' }),
    ]);
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('脚本语法错误');
    expect(snap.finishedAt).toBe(2500);
    expect(snap.durationMs).toBe(1500);
  });

  it('applyScriptRunEvent 是纯函数，不就地修改入参', () => {
    const base = emptyScriptRunSnapshot('run-1');
    const next = applyScriptRunEvent(base, ev('run:log', 1100, { message: 'x' }));
    expect(base.logs).toEqual([]); // 入参未被改动
    expect(next.logs).toEqual(['x']);
    expect(next).not.toBe(base);
  });
});
