// ============================================================================
// 任务账本证据门（ADR-050）
//
// 覆盖三条写状态的路径 —— update / replace / patch。三条都必须挡，因为模型
// 只要发现有一条不挡就会一直走那条（"按名字枚举的拒绝清单 = 漏洞制造机"）。
// 另测语义化翻译层：raw 报错不会原样落到给用户看的字段上。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import type { SessionTask } from '../../../../../src/shared/contract/planning';

const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const getTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);
const clearTasksMock = vi.fn();

vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  createTask: (...a: unknown[]) => createTaskMock(...a),
  updateTask: (...a: unknown[]) => updateTaskMock(...a),
  getTask: (...a: unknown[]) => getTaskMock(...a),
  listTasks: (...a: unknown[]) => listTasksMock(...a),
  clearTasks: (...a: unknown[]) => clearTasksMock(...a),
  isClosedTaskStatus: (status: string) => status === 'completed' || status === 'cancelled',
}));
vi.mock('../../../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    recordTodoFeedbackForTask: vi.fn(),
    clearTodoFeedbackForTask: vi.fn(),
  }),
  isDesktopDerivedSessionTask: () => false,
}));

import { taskManagerModule } from '../../../../../src/host/tools/modules/planning/taskManager';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'sess-gate',
    workingDir: '/tmp',
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: vi.fn(),
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeTask(id: string, overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id,
    subject: `task ${id}`,
    description: `desc ${id}`,
    activeForm: `doing ${id}`,
    status: 'pending',
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionTask;
}

async function run(args: Record<string, unknown>) {
  const handler = await taskManagerModule.createHandler();
  return handler.execute(args, makeCtx(), allowAll);
}

beforeEach(() => {
  vi.clearAllMocks();
  listTasksMock.mockReturnValue([]);
  createTaskMock.mockImplementation((_s: string, input: { subject: string }) =>
    makeTask(`new-${input.subject}`, { subject: input.subject }));
  updateTaskMock.mockImplementation((_s: string, id: string) => makeTask(id));
});

describe('证据门 — update 路径', () => {
  beforeEach(() => {
    getTaskMock.mockReturnValue(makeTask('1', { status: 'in_progress' }));
    listTasksMock.mockReturnValue([makeTask('1', { status: 'in_progress' })]);
  });

  it('completed 缺 completionEvidence 时拒绝，且不写库', async () => {
    const result = await run({ action: 'update', taskId: '1', status: 'completed' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('completionEvidence');
    }
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('空白字符串不算证据', async () => {
    const result = await run({
      action: 'update', taskId: '1', status: 'completed', completionEvidence: '   ',
    });

    expect(result.ok).toBe(false);
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('带证据时放行，并把证据落成 EvidenceRef', async () => {
    const result = await run({
      action: 'update',
      taskId: '1',
      status: 'completed',
      completionEvidence: 'Ran npm test — 214 passed, 0 failed',
    });

    expect(result.ok).toBe(true);
    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    const refs = updates.evidenceRefs as Array<{ ref: string; kind: string }>;
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('tool');
    expect(refs[0].ref).toContain('214 passed');
  });

  it('blocked 缺 blockedReason 时拒绝', async () => {
    const result = await run({ action: 'update', taskId: '1', status: 'blocked' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('blockedReason');
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('blocked 的人话原因原样保留给 UI', async () => {
    const result = await run({
      action: 'update',
      taskId: '1',
      status: 'blocked',
      blockedReason: '这个报表页需要公司账号登录，我们没有',
    });

    expect(result.ok).toBe(true);
    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    expect(updates.blockedReason).toBe('这个报表页需要公司账号登录，我们没有');
  });

  it('cancelled 不强制原因，但会把原因带进审计摘要', async () => {
    const result = await run({
      action: 'update', taskId: '1', status: 'cancelled', cancelReason: '需求取消了',
    });

    expect(result.ok).toBe(true);
    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    expect(updates.statusSummary).toBe('需求取消了');
  });
});

describe('证据门 — 语义化翻译层（依赖 A）', () => {
  beforeEach(() => {
    getTaskMock.mockReturnValue(makeTask('1', { status: 'in_progress' }));
    listTasksMock.mockReturnValue([makeTask('1', { status: 'in_progress' })]);
  });

  it('raw 报错不会原样进展示字段，改用语义类别兜底', async () => {
    const result = await run({
      action: 'update',
      taskId: '1',
      status: 'blocked',
      blockedReason: 'AxiosError: Request failed with status code 403\n'
        + '    at settle (/app/node_modules/axios/lib/core/settle.js:19:12)',
    });

    expect(result.ok).toBe(true);
    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    // 展示字段为空 → UI 用类别文案，用户看不到 stack trace
    expect(updates.blockedReason).toBe('');
    expect(updates.blockedReasonCategory).toBe('permission');
    // 原文只进审计日志
    expect(updates.statusSummary).toContain('AxiosError');
  });

  it('JSON 响应体同样被判为机器噪音', async () => {
    await run({
      action: 'update',
      taskId: '1',
      status: 'blocked',
      blockedReason: '{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}',
    });

    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    expect(updates.blockedReason).toBe('');
    expect(updates.blockedReasonCategory).toBe('rate_limit');
  });

  it('过长的证据被截断，不把整屏日志灌进账本', async () => {
    await run({
      action: 'update',
      taskId: '1',
      status: 'completed',
      completionEvidence: 'x'.repeat(500),
    });

    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    const refs = updates.evidenceRefs as Array<{ ref: string }>;
    expect(refs[0].ref.length).toBeLessThanOrEqual(160);
  });
});

describe('证据门 — 批量路径（模型绕行的最短路）', () => {
  it('patch 把任务改成 completed 也要证据', async () => {
    listTasksMock.mockReturnValue([makeTask('1', { status: 'in_progress' })]);

    const result = await run({
      action: 'patch',
      tasks: [{ taskId: '1', status: 'completed' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('completionEvidence');
    }
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('patch 带证据时放行并落库', async () => {
    listTasksMock.mockReturnValue([makeTask('1', { status: 'in_progress' })]);

    const result = await run({
      action: 'patch',
      tasks: [{ taskId: '1', status: 'completed', completionEvidence: '重新打开页面确认三段文案已替换' }],
    });

    expect(result.ok).toBe(true);
    const updates = updateTaskMock.mock.calls[0][2] as Record<string, unknown>;
    expect((updates.evidenceRefs as unknown[]).length).toBe(1);
  });

  it('patch 不改状态的条目不需要证据（沿用 ≠ 新声称）', async () => {
    listTasksMock.mockReturnValue([makeTask('1', { status: 'completed' })]);

    const result = await run({
      action: 'patch',
      tasks: [{ taskId: '1', subject: '改个标题' }],
    });

    expect(result.ok).toBe(true);
  });

  it('replace 里新写 completed 的条目要证据', async () => {
    const result = await run({
      action: 'replace',
      tasks: [{ subject: '写周报', status: 'completed' }, { subject: '发周报' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('completionEvidence');
    expect(clearTasksMock).not.toHaveBeenCalled();
  });

  it('replace 里 blocked 条目要 blockedReason', async () => {
    const result = await run({
      action: 'replace',
      tasks: [{ subject: '抓竞品价格', status: 'blocked' }, { subject: '整理表格' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('blockedReason');
  });

  it('replace 沿用同名任务的既有 completed 状态时不重复举证，并带上原证据', async () => {
    const previousRef = {
      id: 'evidence_prev',
      kind: 'tool' as const,
      ref: '之前已核实',
      source: 'task_update:1',
      freshness: { capturedAtMs: 1, state: 'read' as const },
      redactionStatus: 'clean' as const,
    };
    listTasksMock.mockReturnValue([
      makeTask('1', { subject: '写周报', status: 'completed', evidenceRefs: [previousRef] }),
    ]);

    const result = await run({
      action: 'replace',
      tasks: [{ subject: '写周报', status: 'completed' }, { subject: '发周报' }],
    });

    expect(result.ok).toBe(true);
    const completedUpdate = updateTaskMock.mock.calls
      .map((call) => call[2] as Record<string, unknown>)
      .find((updates) => updates.status === 'completed');
    expect(completedUpdate?.evidenceRefs).toEqual([previousRef]);
  });
});
