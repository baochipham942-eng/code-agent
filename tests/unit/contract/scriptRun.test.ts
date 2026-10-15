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

  it('run:cancelled 置 cancelled 并记录取消原因', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:cancelled', 2500, { reason: 'run aborted' }),
    ]);
    expect(snap.status).toBe('cancelled');
    expect(snap.error).toBe('run aborted');
    expect(snap.finishedAt).toBe(2500);
    expect(snap.durationMs).toBe(1500);
  });

  // ── Codex Round4 MED：终态后晚到的 agent:start 不得覆盖真实 startedAt（时间元数据保护）──
  it('终态后晚到 agent:start 不覆盖既有 startedAt', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1000, { agentId: 'a1', label: 'x' }),
      ev('agent:done', 2000, { agentId: 'a1', label: 'x' }),
      ev('agent:start', 2100, { agentId: 'a1', label: 'x' }), // 重复/晚到
    ]);
    expect(snap.agents[0].startedAt).toBe(1000); // 不被 2100 覆盖
    expect(snap.agents[0].status).toBe('done');
  });

  it('applyScriptRunEvent 是纯函数，不就地修改入参', () => {
    const base = emptyScriptRunSnapshot('run-1');
    const next = applyScriptRunEvent(base, ev('run:log', 1100, { message: 'x' }));
    expect(base.logs).toEqual([]); // 入参未被改动
    expect(next.logs).toEqual(['x']);
    expect(next).not.toBe(base);
  });

  // ── Codex Round1 MED#2：emit 是 best-effort（catch{}），agent:start 可能丢；终态事件
  //    遇未知 agentId 必须 upsert 补记录，否则 done/error 被静默吃掉、计数错。──
  it('agent:done 先于/丢失 agent:start 时 upsert 补一条 done agent', () => {
    const snap = fold('run-1', [
      ev('agent:done', 1500, { agentId: 'a1', label: 'find', resultPreview: 'ok' }),
    ]);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].id).toBe('a1');
    expect(snap.agents[0].status).toBe('done');
    expect(snap.agents[0].resultPreview).toBe('ok');
    expect(snap.doneCount).toBe(1);
  });

  it('agent:error 无前置 agent:start 时 upsert 补一条 error agent（计数不丢）', () => {
    const snap = fold('run-1', [
      ev('agent:error', 1500, { agentId: 'a1', label: 'x', error: 'boom' }),
    ]);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].status).toBe('error');
    expect(snap.agents[0].error).toBe('boom');
    expect(snap.errorCount).toBe(1);
  });

  // ── Codex Round2 HIGH：sessionId 必须在任意事件 latch，不能只认 run:start（run:start 可能丢/晚到）──
  it('sessionId 从首个携带它的事件 latch（即便不是 run:start）', () => {
    const evS = (type: ScriptRunEvent['type'], ts: number, data: Record<string, unknown>): ScriptRunEvent => ({
      runId: 'run-1', type, ts, data, sessionId: 'sess-A',
    });
    const snap = fold('run-1', [evS('agent:start', 1100, { agentId: 'a1', label: 'x' })]);
    expect(snap.sessionId).toBe('sess-A'); // 无 run:start 也要 latch
  });

  it('sessionId latch 后不被后续无 sessionId 事件清掉', () => {
    const withS: ScriptRunEvent = { runId: 'run-1', type: 'run:start', ts: 1000, sessionId: 'sess-A', data: {} };
    const snap = [withS, ev('run:log', 1100, { message: 'x' })].reduce(
      (s, e) => applyScriptRunEvent(s, e),
      emptyScriptRunSnapshot('run-1'),
    );
    expect(snap.sessionId).toBe('sess-A');
  });

  // ── Codex Round3 HIGH：run:start 丢失时，首个活动事件要把 run 提升为 running（否则进度树不出来）──
  it('run:start 丢失时 agent:start 把 run 提升为 running 并补 startedAt', () => {
    const snap = fold('run-1', [ev('agent:start', 1100, { agentId: 'a1', label: 'x' })]);
    expect(snap.status).toBe('running');
    expect(snap.startedAt).toBe(1100);
  });

  it('run:phase 在 run:start 缺失时也提升 running', () => {
    const snap = fold('run-1', [ev('run:phase', 1100, { title: 'p' })]);
    expect(snap.status).toBe('running');
  });

  it('run:done/run:error 不被活动提升逻辑误伤（终态优先）', () => {
    const done = fold('run-1', [ev('run:done', 2000, { result: 1 })]);
    expect(done.status).toBe('completed');
  });

  // ── Codex Round3 MED：终态先到时，晚到 agent:start 的真实 label 应纠正占位 'agent' ──
  it('agent:done(无 label) 后 agent:start(真 label) 纠正占位 label，状态仍 done', () => {
    const snap = fold('run-1', [
      ev('agent:done', 1500, { agentId: 'a1' }),
      ev('agent:start', 1600, { agentId: 'a1', label: 'find', promptPreview: '搜', model: 'm' }),
    ]);
    expect(snap.agents[0].status).toBe('done');
    expect(snap.agents[0].label).toBe('find'); // 占位 'agent' 被真实 label 纠正
    expect(snap.agents[0].promptPreview).toBe('搜');
    expect(snap.agents[0].model).toBe('m');
  });

  // ── P4-D：resumable 重放命中的 agent 在进度树标记为 cached（瞬时 done）──
  it('agent:start(cached) → 快照 agent 带 cached 标记', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'a1', label: 'find', cached: true }),
    ]);
    expect(snap.agents[0].cached).toBe(true);
  });

  it('缓存命中（start+done 都带 cached）→ agent 为 done 且 cached，计入 doneCount', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'a1', label: 'find', cached: true }),
      ev('agent:done', 1100, { agentId: 'a1', label: 'find', resultPreview: 'ok', cached: true }),
    ]);
    expect(snap.agents[0].status).toBe('done');
    expect(snap.agents[0].cached).toBe(true);
    expect(snap.doneCount).toBe(1);
  });

  it('普通 live agent 不带 cached（字段为 undefined，不误标）', () => {
    const snap = fold('run-1', [
      ev('agent:start', 1100, { agentId: 'a1', label: 'find' }),
      ev('agent:done', 1500, { agentId: 'a1', label: 'find' }),
    ]);
    expect(snap.agents[0].cached).toBeUndefined();
  });

  it('agent:done(cached) 先于丢失的 start 到达时也补出 cached 标记', () => {
    const snap = fold('run-1', [
      ev('agent:done', 1100, { agentId: 'a1', label: 'find', cached: true, resultPreview: 'ok' }),
    ]);
    expect(snap.agents[0].status).toBe('done');
    expect(snap.agents[0].cached).toBe(true);
  });

  // ── Codex Round2 MED：agent:start 晚于 agent:done 到达时不得把状态降级回 running ──
  it('agent:start 晚到（终态已落）时单调更新，不降级 done→running', () => {
    const snap = fold('run-1', [
      ev('agent:done', 1500, { agentId: 'a1', label: 'find', resultPreview: 'ok' }),
      ev('agent:start', 1600, { agentId: 'a1', label: 'find', promptPreview: '搜' }),
    ]);
    expect(snap.agents[0].status).toBe('done'); // 不回滚
    expect(snap.doneCount).toBe(1);
    expect(snap.runningCount).toBe(0);
    expect(snap.agents[0].promptPreview).toBe('搜'); // 缺字段仍可补
  });
});

// ── N-WF-STALL-UI：停顿状态事件（无 message 的 run:log 携带 data.stall）+ lastActivityAt ──
describe('scriptRun view-model: stall state folding (N-WF-STALL-UI)', () => {
  it('run:start 与真实活动事件（run:phase/run:log/agent:*）都刷 lastActivityAt', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:phase', 1100, { title: 'p' }),
      ev('run:log', 1200, { message: 'log' }),
      ev('agent:start', 1300, { agentId: 'a1', label: 'x' }),
      ev('agent:done', 1400, { agentId: 'a1', label: 'x' }),
      ev('agent:error', 1500, { agentId: 'a2', label: 'y' }),
    ]);
    expect(snap.lastActivityAt).toBe(1500); // 取最新活动事件的 ts
  });

  it('停顿状态事件折叠 parked/epoch 进快照，不刷 lastActivityAt', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:log', 5000, { message: 'real log' }),
      ev('run:log', 900_000, { stall: { parked: true } }),
      ev('run:log', 1200_000, { stall: { epoch: 1 } }),
    ]);
    expect(snap.parked).toBe(true);
    expect(snap.stallNoticeEpoch).toBe(1);
    expect(snap.lastActivityAt).toBe(5000); // stall 事件不算活动
    expect(snap.logs).toEqual(['real log']); // stall 事件不进 logs
  });

  it('停顿状态事件不把 pending 提升为 running（不算活动）', () => {
    const snap = fold('run-1', [ev('run:log', 900_000, { stall: { parked: false } })]);
    expect(snap.status).toBe('pending'); // 未被 run:log(活动类型) 误提升
    expect(snap.parked).toBe(false); // 载荷照常折叠
  });

  it('epoch 单调：乱序/重复上报不回退 stallNoticeEpoch，parked 可来回翻转', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:log', 600_000, { stall: { epoch: 2 } }),
      ev('run:log', 700_000, { stall: { epoch: 1 } }), // 乱序迟到
      ev('run:log', 800_000, { stall: { parked: false } }),
      ev('run:log', 900_000, { stall: { parked: true } }),
    ]);
    expect(snap.stallNoticeEpoch).toBe(2);
    expect(snap.parked).toBe(true);
  });

  it('带 message 的 run:log 即便同时带 stall 载荷也按活动处理（不误吞日志）', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:log', 2000, { message: 'hybrid', stall: { epoch: 1 } }),
    ]);
    expect(snap.logs).toEqual(['hybrid']);
    expect(snap.lastActivityAt).toBe(2000);
    expect(snap.stallNoticeEpoch).toBe(1); // 载荷仍折叠
  });

  it('畸形 stall 载荷（非对象/空对象/错类型字段）整条事件被忽略', () => {
    const base = fold('run-1', [ev('run:start', 1000, { scriptHash: 'h' })]);
    for (const bad of [undefined, 'x', 3, {}, { parked: 'yes' }, { epoch: 'one' }]) {
      const next = applyScriptRunEvent(base, ev('run:log', 2000, { stall: bad }));
      expect(next.parked).toBeUndefined();
      expect(next.stallNoticeEpoch).toBeUndefined();
      expect(next.lastActivityAt).toBe(1000);
    }
  });

  it('终态事件不刷 lastActivityAt（停顿提示只属于 running）', () => {
    const snap = fold('run-1', [
      ev('run:start', 1000, { scriptHash: 'h' }),
      ev('run:log', 2000, { message: 'x' }),
      ev('run:done', 3000, { result: 1 }),
    ]);
    expect(snap.lastActivityAt).toBe(2000);
  });
});
