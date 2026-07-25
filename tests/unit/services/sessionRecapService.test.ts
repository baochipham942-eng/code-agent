// ============================================================================
// A6 回会话追赶提示：素材来源钉死在「产物快照 + 任务账本」
// ============================================================================
// 这个文件的承重断言是**素材来源**，不是文案好不好看。硬约束是评审阶段钉死的：
// recap 只许读产物变化 + 任务账本结果，禁止读聊天消息流水（那会退化成"执行了某某
// 工具、报了某某错"的流水账，非程序员看不懂）。
//
// 变异判据：把 collectRecapMaterial 里读产物的那段（artifactRefs / changedFiles）
// 断开，第一条与第三条必红。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { CompletionSummaryRecord, SessionTask } from '../../../src/shared/contract';
import {
  collectRecapMaterial,
  formatRecapFallback,
} from '../../../src/host/session/sessionRecapService';

function record(overrides: Partial<CompletionSummaryRecord> = {}): CompletionSummaryRecord {
  return {
    schemaVersion: 1,
    id: 'completion_1',
    sessionId: 'session-1',
    traceId: 'trace-1',
    objective: '把文章扩写三段',
    status: 'success',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    iterations: 3,
    tokenUsage: { input: 10, output: 20, total: 30 },
    toolCallCount: 4,
    changedFiles: ['/work/文章终稿.md'],
    commands: [],
    verificationEvidence: [],
    commitIds: [],
    risks: [],
    blockers: [],
    artifactRefs: [{ kind: 'artifact', messageId: 'm1', artifactId: 'a1', title: '销售图表' }],
    ...overrides,
  } as CompletionSummaryRecord;
}

function task(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-1',
    subject: '扩写第三节',
    description: '',
    activeForm: '正在扩写第三节',
    status: 'completed',
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  } as SessionTask;
}

describe('sessionRecapService 素材收集', () => {
  it('产物名同时取自 artifactRefs 和 changedFiles（这是"产物 diff"素材源）', () => {
    const material = collectRecapMaterial([record()], [], 500);
    expect(material).not.toBeNull();
    expect(material?.artifactLabels).toEqual(expect.arrayContaining(['销售图表', '文章终稿.md']));
  });

  it('任务账本分出完成与卡住两档', () => {
    const material = collectRecapMaterial(
      [record()],
      [
        task({ id: 'task-1', status: 'completed' }),
        task({ id: 'task-2', status: 'blocked', subject: '拿到素材', blockedReason: '连不上目标网站或服务' }),
        task({ id: 'task-3', status: 'in_progress' }),
      ],
      500,
    );
    expect(material?.completedTasks.map((item) => item.id)).toEqual(['task-1']);
    expect(material?.blockedTasks.map((item) => item.id)).toEqual(['task-2']);
  });

  it('上次查看之后没有收口轮次时不追赶（返回 null，不编）', () => {
    expect(collectRecapMaterial([record({ endedAt: 400 })], [task()], 500)).toBeNull();
    expect(collectRecapMaterial([], [task()], 0)).toBeNull();
  });

  it('降级文案只说产物和数量，不出现工具名/报错原文', () => {
    const material = collectRecapMaterial(
      [record()],
      [task({ id: 'task-2', status: 'blocked', blockedReason: '连不上目标网站或服务' }), task()],
      500,
    );
    const text = formatRecapFallback(material!);
    expect(text).toContain('销售图表');
    expect(text).toContain('1 项任务完成');
    expect(text).toContain('1 项卡住');
    expect(text).not.toMatch(/Error|Traceback|at .*:\d+:\d+/);
  });
});
