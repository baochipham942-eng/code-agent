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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionSummaryRecord, SessionTask } from '../../../src/shared/contract';
import {
  buildSessionRecap,
  collectRecapMaterial,
  formatRecapFallback,
  type SessionRecapMaterial,
} from '../../../src/host/session/sessionRecapService';

const quickModel = vi.hoisted(() => ({
  isQuickModelAvailable: vi.fn(() => false),
  quickTask: vi.fn(async () => {
    throw new Error('should not be called when unavailable');
  }),
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: quickModel.isQuickModelAvailable,
  quickTask: quickModel.quickTask,
}));

beforeEach(() => {
  quickModel.isQuickModelAvailable.mockReset();
  quickModel.quickTask.mockReset();
  quickModel.isQuickModelAvailable.mockReturnValue(false);
  quickModel.quickTask.mockImplementation(async () => {
    throw new Error('should not be called when unavailable');
  });
});

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
    expect(text).toContain('1 项任务受阻');
    expect(text).not.toMatch(/Error|Traceback|at .*:\d+:\d+/);
  });

  it('小模型不可用时静默降级成规则拼接，仍标 degraded', async () => {
    const material = collectRecapMaterial([record()], [task()], 500);
    const recap = await buildSessionRecap(material!);
    expect(recap).not.toBeNull();
    expect(recap!.degraded).toBe(true);
    expect(recap!.completedCount).toBe(1);
    expect(recap!.text).toContain('销售图表');
  });

  it('收口轮次在但产物名和任务结果都空时不追赶', () => {
    expect(collectRecapMaterial(
      [record({ changedFiles: [], artifactRefs: [] })],
      [],
      500,
    )).toBeNull();
  });

  it('规则拼接没有实质句子时返回 null，不拿轮次数字充数', () => {
    const hollow: SessionRecapMaterial = {
      records: [record({ changedFiles: [], artifactRefs: [] })],
      artifactLabels: [],
      completedTasks: [],
      blockedTasks: [],
    };
    expect(formatRecapFallback(hollow)).toBeNull();
  });
});

describe('sessionRecapService 模型输出过滤', () => {
  it('假模型回反问时 recap 为 null（不像总结不上屏）', async () => {
    quickModel.isQuickModelAvailable.mockReturnValue(true);
    quickModel.quickTask.mockImplementation(async () => ({
      success: true as const,
      content: '您好，消息里似乎没有附上需要总结的产出变化内容，请补充。',
    }));
    const material = collectRecapMaterial([record()], [task()], 500);
    expect(await buildSessionRecap(material!)).toBeNull();
  });

  it('假模型请求补充时 recap 为 null', async () => {
    quickModel.isQuickModelAvailable.mockReturnValue(true);
    quickModel.quickTask.mockImplementation(async () => ({
      success: true as const,
      content: '请提供需要总结的产出变化内容。',
    }));
    const material = collectRecapMaterial([record()], [task()], 500);
    expect(await buildSessionRecap(material!)).toBeNull();
  });

  it('假模型回空串时 recap 为 null', async () => {
    quickModel.isQuickModelAvailable.mockReturnValue(true);
    quickModel.quickTask.mockImplementation(async () => ({ success: true as const, content: '  ' }));
    const material = collectRecapMaterial([record()], [task()], 500);
    expect(await buildSessionRecap(material!)).toBeNull();
  });

  it('假模型回正常一句总结时有 text', async () => {
    quickModel.isQuickModelAvailable.mockReturnValue(true);
    quickModel.quickTask.mockImplementation(async () => ({
      success: true as const,
      content: '更新了销售图表，并完成扩写第三节',
    }));
    const material = collectRecapMaterial([record()], [task()], 500);
    const recap = await buildSessionRecap(material!);
    expect(recap).not.toBeNull();
    expect(recap!.degraded).toBe(false);
    expect(recap!.text).toContain('销售图表');
  });
});
