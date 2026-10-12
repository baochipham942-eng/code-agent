// ============================================================================
// workflow 后台 stall 通知——重复投递故障注入 + 真路径回归（N-WF-STALL-NOTICE）
// ============================================================================
// 钉死的事实：同一条通知记录经真实注册表队列路径（recordStallNotice →
// pendingNotifications / queuedNotificationKeys → drainCompletionNotifications）
// 投递两次，只有一条到达 drain。挡住第二条的键是 stall 通知专属的 dedupeKey
// `${runId}:stall:${epoch}`（backgroundSubagentRegistry.recordStallNotice 构造），
// 由 queuedNotificationKeys 集合在入队时去重，且不随 drain 清空。
//
// 真路径回归（本单）：真实 WorkflowStallDetector（fake journal/clock/timer）announce
// → 注入回调（与 workflow.ts 同形）→ 真实 recordStallNotice 入队 → drain。钉死：
// 硬停滞恰好一条、标签不是 failed、collect_agent 视角的 run 仍 running；同一 epoch
// 重复上报只投一次；epoch 1/2/3 各一条；cap 之后没有第 4 条。
//
// 机制对照组（N-WORKFLOW-BACKGROUND-STALL-DESIGN ⑤ 遗留）：recordInterruptedCompletion
// 的完成通知键 `${scope}:${agentId}:${status}:${finishedAt}` 仍被同一条队列挡重复，
// 保留两条用例守住共享机制。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { WorkflowStallDetector } from '../../../src/host/agent/workflowStallDetector';
import { formatSystemReminderForCompletions } from '../../../src/host/agent/subagentCompletionNotification';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';

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

/** 与 detector 单测同形的 fake journal：durable (runId, epoch) 行，重复写返 false。 */
function makeStallJournal() {
  const rows: Array<{ runId: string; epoch: number }> = [];
  return {
    rows,
    journal: {
      getMaxStallEpoch: () => 0,
      recordStallNotice: (runId: string, epoch: number) => {
        if (rows.some((row) => row.runId === runId && row.epoch === epoch)) return false;
        rows.push({ runId, epoch });
        return true;
      },
    },
  };
}

describe('workflow stall notice real path (detector → recordStallNotice → queue)', () => {
  const RUN_ID = 'wf-stall-notice-1';
  const SESSION_ID = 'session-stall';
  const TITLE = 'workflow stall fixture';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => vi.useRealTimers());

  /** 真实检测器 + 真实注册表；回调与 workflow.ts 注入同形（入队；idle wake 不在本文件断言面）。 */
  function createPipeline() {
    const registry = new BackgroundSubagentRegistry();
    const { journal } = makeStallJournal();
    const notices: Array<{ epoch: number; idleSeconds: number }> = [];
    const detector = new WorkflowStallDetector({
      journal,
      logger: { warn: () => undefined },
      onStallNotice: (notice) => {
        notices.push({ epoch: notice.epoch, idleSeconds: notice.idleSeconds });
        registry.recordStallNotice({
          runId: notice.runId,
          sessionId: SESSION_ID,
          title: TITLE,
          epoch: notice.epoch,
          idleSeconds: notice.idleSeconds,
          ...(notice.lastActivity ? { lastActivity: notice.lastActivity } : {}),
        });
      },
    });
    return { registry, detector, notices };
  }

  it('hard stall delivers exactly one non-failure notice and the run keeps running', async () => {
    const { registry, detector } = createPipeline();
    // run 已 adopt 进注册表（生产同形：sessionId 有、parent runId 无），且一直没跑完。
    registry.adopt(new Promise<never>(() => {}), { agentId: RUN_ID, sessionId: SESSION_ID, title: TITLE });
    detector.startRun(RUN_ID);
    detector.handleEvent({ runId: RUN_ID, type: 'run:log', ts: 1, data: { message: 'compiling report' } });

    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);

    const drained = registry.drainCompletionNotifications({ sessionId: SESSION_ID });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.dedupeKey).toBe(`${RUN_ID}:stall:1`);
    // 标签与批标题不许出现失败收尾语义：run 还在跑。
    const reminder = formatSystemReminderForCompletions(drained);
    expect(reminder).toContain('1 background task stalled (no progress)');
    expect(reminder).toContain('stalled (no progress)');
    expect(reminder).not.toContain('failed');
    // 稳定文案（模型可断言）：时长 + 最近活动 + 不轮询 + 可行动 runId。
    expect(drained[0]?.summary).toContain('no progress for 600s');
    expect(drained[0]?.summary).toContain('last activity run:log: compiling report');
    expect(drained[0]?.summary).toContain(`Do not poll. Use collect_agent("${RUN_ID}") to inspect.`);
    expect(drained[0]?.kind).toBe('internal');
    // 非终态：不写 entry、不改状态，collect_agent 视角仍是 running。
    expect(registry.getStatus(RUN_ID)?.status).toBe('running');
  });

  it('a repeated report in the same epoch is delivered once', async () => {
    const { registry, detector } = createPipeline();
    detector.startRun(RUN_ID);
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);

    // 重复上报同一 epoch（journal 行丢失 / 双保险路径）：再走一次入队口仍被挡。
    registry.recordStallNotice({ runId: RUN_ID, sessionId: SESSION_ID, epoch: 1, idleSeconds: 600 });

    const drained = registry.drainCompletionNotifications({ sessionId: SESSION_ID });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.dedupeKey).toBe(`${RUN_ID}:stall:1`);
    expect(registry.drainCompletionNotifications({ sessionId: SESSION_ID })).toEqual([]);
  });

  it('delivers each new epoch once and stops at the epoch cap', async () => {
    const { registry, detector } = createPipeline();
    detector.startRun(RUN_ID);
    for (let epoch = 1; epoch <= WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS; epoch += 1) {
      await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);
    }

    const drained = registry.drainCompletionNotifications({ sessionId: SESSION_ID });
    expect(drained.map((record) => record.dedupeKey)).toEqual([
      `${RUN_ID}:stall:1`,
      `${RUN_ID}:stall:2`,
      `${RUN_ID}:stall:3`,
    ]);

    // epoch 耗尽：检测器不再排表，时钟走再多也没有第 4 条。
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(registry.drainCompletionNotifications({ sessionId: SESSION_ID })).toEqual([]);
  });
});
