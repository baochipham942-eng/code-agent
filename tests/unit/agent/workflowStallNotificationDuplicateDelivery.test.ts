// ============================================================================
// workflow 后台 stall 通知——重复投递故障注入（N-WORKFLOW-BACKGROUND-STALL-DESIGN ⑤）
// ============================================================================
// 钉死的事实：同一条通知记录经真实注册表队列路径（recordInterruptedCompletion →
// pendingNotifications / queuedNotificationKeys → drainCompletionNotifications）
// 投递两次，只有一条到达 drain。挡住第二条的键是 SubagentCompletionRecord.dedupeKey
// （subagentCompletionNotification.ts 构造成
//  `${sessionId}:${runId}:${treeId}:${agentId}:${status}:${finishedAt}`），
// 由 backgroundSubagentRegistry.ts 的 queuedNotificationKeys 集合在入队时去重。
//
// stall 设计（docs/architecture/designs/workflow-background-stall.md）复用的正是
// 这条 out-of-band 通知路径：非终态通知不能走 claimWorkflowSettlement（那是
// runId:terminalStatus 的终态语义），必须靠 completion 队列自己的 dedupeKey。
// 对照组：epoch 不同（finishedAt 不同 → dedupeKey 不同）时两条都投递——这就是
// 「每个 stall epoch 提醒一次、新 epoch 不被旧 epoch 吞掉」的机制依据。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { BackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';

/** 可拨时钟：recordInterruptedCompletion 用 registry 的 now() 当 finishedAt。 */
function createMutableClock(startAtMs: number) {
  let now = startAtMs;
  return {
    clock: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

interface StallNoticeFixture {
  agentId: string;
  sessionId: string;
  runId: string;
  treeId: string;
  title: string;
}

/**
 * 夹具构造 + 投递。走真实 recordInterruptedCompletion 路径（重启收口投影用的
 * 同一个入口），不 mock 队列。finishedAt 由 registry 时钟决定：时钟不动 →
 * 两次投递的 dedupeKey 完全一致（同一 stall epoch 的重复上报被挡）；
 * 时钟推进 → 键不同（新 epoch 的提醒放行）。
 */
function deliverStallNotice(reg: BackgroundSubagentRegistry, fixture: StallNoticeFixture) {
  return reg.recordInterruptedCompletion({
    agentId: fixture.agentId,
    title: fixture.title,
    completionKind: 'internal',
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    treeId: fixture.treeId,
    progressRecorded: true,
  });
}

describe('workflow stall notification duplicate delivery (fault injection)', () => {
  const BASE_FIXTURE: StallNoticeFixture = {
    agentId: 'wf-stall-run-1',
    sessionId: 'session-stall',
    runId: 'run-stall',
    treeId: 'tree-stall',
    title: 'workflow 后台卡住提醒',
  };

  it('delivers the same record twice through the real queue path but only one reaches the drain', () => {
    const { clock } = createMutableClock(10_000);
    const reg = new BackgroundSubagentRegistry(clock);

    const first = deliverStallNotice(reg, BASE_FIXTURE);
    const duplicate = deliverStallNotice(reg, BASE_FIXTURE);

    // 挡住重复投递的键：dedupeKey 由 scope 前缀 + agentId + status + finishedAt 组成。
    // 两次投递身份完全一致（同一 run、同一 stall epoch、时钟未走）→ 键相同。
    expect(duplicate.dedupeKey).toBe(first.dedupeKey);
    expect(first.dedupeKey).toBe('session-stall:run-stall:tree-stall:wf-stall-run-1:failed:10000');

    const drained = reg.drainCompletionNotifications({ sessionId: BASE_FIXTURE.sessionId });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.dedupeKey).toBe(first.dedupeKey);

    // drain 只清 pendingNotifications，不清 queuedNotificationKeys：drain 之后再投
    // 同一条仍被挡（stall 设计要求「提醒一次」，不是「每个消费点一次」）。
    deliverStallNotice(reg, BASE_FIXTURE);
    expect(reg.drainCompletionNotifications({ sessionId: BASE_FIXTURE.sessionId })).toEqual([]);
  });

  it('delivers both records when the dedupeKey differs (new stall epoch, second run)', () => {
    const { clock, advance } = createMutableClock(10_000);
    const reg = new BackgroundSubagentRegistry(clock);

    // 对照 A：同一 run 的新 stall epoch——finishedAt 随时钟推进而不同 → 键不同 → 放行。
    const epoch1 = deliverStallNotice(reg, BASE_FIXTURE);
    advance(60_000);
    const epoch2 = deliverStallNotice(reg, BASE_FIXTURE);
    expect(epoch2.dedupeKey).not.toBe(epoch1.dedupeKey);

    // 对照 B：同一时刻的另一个 run 卡住——agentId 不同 → 键不同 → 放行。
    const otherRun = deliverStallNotice(reg, {
      ...BASE_FIXTURE,
      agentId: 'wf-stall-run-2',
      runId: 'run-stall-2',
    });
    expect(otherRun.dedupeKey).not.toBe(epoch1.dedupeKey);

    const drained = reg.drainCompletionNotifications({ sessionId: BASE_FIXTURE.sessionId });
    expect(drained).toHaveLength(3);
    expect(drained.map((record) => record.dedupeKey)).toEqual(
      expect.arrayContaining([epoch1.dedupeKey, epoch2.dedupeKey, otherRun.dedupeKey]),
    );
    // 通知内容走既有 completion 通道的形状：模型可读、带 next_action。
    expect(drained[0]?.content).toContain('<subagent_notification>');
    expect(drained[0]?.content).toContain('interrupted_by_restart');
  });
});
