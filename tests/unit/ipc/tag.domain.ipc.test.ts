import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// tag.ipc.ts 的 TAG domain dispatch 特征测试（RQ-183 续作·TAG 刀迁表前先钉住现状）：
// 参数校验文案与 INVALID_ARGS / NOT_FOUND、别名 action、reviewer/actor 字段回退、
// 服务层错误 code 透传 / TAG_ERROR 兜底 + 日志、未知 action 的 UNKNOWN_ACTION 契约、
// TAG_EVENT 推送、后台 run 失败只记日志不影响响应。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => {
  class NeoWorkCardServiceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  const detail = (id = 'wc1') => ({
    workCard: { id, projectId: 'p1', sourceConversationId: 'c1', status: 'draft' },
  });
  return {
    NeoWorkCardServiceError,
    detail,
    send: vi.fn(),
    logError: vi.fn(),
    service: {
      createDraft: vi.fn(() => detail()),
      get: vi.fn((id: string) => detail(id) as ReturnType<typeof detail> | null),
      listByProject: vi.fn(() => ['byProject']),
      listAll: vi.fn(() => ['all']),
      listBySourceConversation: vi.fn(() => ['bySource']),
      updateDraftRevision: vi.fn(() => detail()),
      updateMeta: vi.fn(() => ({ id: 'wc1' })),
      approveRevision: vi.fn(() => ({ approved: true })),
      rejectRevision: vi.fn(() => ({ rejected: true })),
      cancel: vi.fn(() => ({ id: 'wc1' }) as { id: string } | null),
      archive: vi.fn(() => ({ id: 'wc1' }) as { id: string } | null),
      acceptResult: vi.fn(() => ({ accepted: true })),
      requestChanges: vi.fn(() => ({ changed: true })),
      approveMemoryCandidate: vi.fn(() => ({ workCardId: 'wc1' })),
      rejectMemoryCandidate: vi.fn(() => ({ workCardId: 'wc1' })),
      appendDelta: vi.fn(() => ({ delta: 1 })),
    },
    runtime: {
      createAndRun: vi.fn(() => ({ workCard: { id: 'wc1' }, revision: { id: 'r1' }, run: Promise.resolve({}) as Promise<unknown> })),
      continueAndRun: vi.fn((..._a: unknown[]) => ({ workCard: { id: 'wc1' }, revision: { id: 'r2' }, run: Promise.resolve({}) as Promise<unknown> })),
      launchApproved: vi.fn(async () => ({})),
    },
  };
});

vi.mock('../../../src/host/services/project/neoWorkCardService', () => ({
  getNeoWorkCardService: () => h.service,
  NeoWorkCardServiceError: h.NeoWorkCardServiceError,
}));
vi.mock('../../../src/host/services/project/neoTagRuntimeService', () => ({
  createAndRunNeoWorkCard: (...a: unknown[]) => h.runtime.createAndRun(...(a as [])),
  continueAndRunNeoWorkCard: (...a: unknown[]) => h.runtime.continueAndRun(...a),
  launchApprovedNeoWorkCard: (...a: unknown[]) => h.runtime.launchApproved(...(a as [])),
}));
vi.mock('../../../src/host/task', () => ({ getTaskManager: () => ({}) }));
vi.mock('../../../src/host/platform', () => ({
  AppWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.send } }] },
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerTagHandlers } from '../../../src/host/ipc/tag.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: HandlerFn;
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.service.get.mockImplementation((id: string) => h.detail(id));
  h.service.cancel.mockReturnValue({ id: 'wc1' });
  h.service.archive.mockReturnValue({ id: 'wc1' });
  const handlers = new Map<string, HandlerFn>();
  registerTagHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  handler = handlers.get(IPC_DOMAINS.TAG)!;
});

describe('dispatch 兜底与错误映射', () => {
  it('未知 action → UNKNOWN_ACTION + Unknown tag action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown tag action: bogus' } });
  });

  it('服务层 NeoWorkCardServiceError → code 透传，不记错误日志', async () => {
    h.service.updateMeta.mockImplementationOnce(() => {
      throw new h.NeoWorkCardServiceError('CONFLICT', 'stale revision');
    });
    expect(await call('updateMeta', { workCardId: 'wc1', actorUserId: 'u1' }))
      .toEqual({ success: false, error: { code: 'CONFLICT', message: 'stale revision' } });
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('其他 Error → TAG_ERROR + message 并记日志；非 Error 抛出 → Unknown error', async () => {
    h.service.listAll.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    expect(await call('listAll')).toEqual({ success: false, error: { code: 'TAG_ERROR', message: 'db down' } });
    expect(h.logError).toHaveBeenCalledWith('Tag IPC error', expect.any(Error));
    h.service.listAll.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('listAll')).toEqual({ success: false, error: { code: 'TAG_ERROR', message: 'Unknown error' } });
  });
});

describe('草稿与读取', () => {
  it('createDraft：缺 payload → INVALID_ARGS；成功返回详情并推 TAG_EVENT', async () => {
    expect(await call('createDraft')).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'payload is required' } });
    const res = await call('createDraft', { projectId: 'p1' });
    expect(res).toEqual({ success: true, data: h.detail() });
    expect(h.send).toHaveBeenCalledWith(IPC_CHANNELS.TAG_EVENT, expect.objectContaining({ type: 'work_card_updated', reason: 'draft_created', workCardId: 'wc1' }));
  });

  it.each(['get', 'read'])('%s：缺 workCardId → INVALID_ARGS；不存在 → NOT_FOUND；存在 → 详情', async (action) => {
    expect(await call(action, {})).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId is required' } });
    h.service.get.mockReturnValueOnce(null);
    expect(await call(action, { workCardId: 'x' })).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'work card not found' } });
    expect(await call(action, { workCardId: 'wc9' })).toEqual({ success: true, data: h.detail('wc9') });
  });

  it.each(['list', 'listByProject'])('%s：缺 projectId → INVALID_ARGS；透传过滤项', async (action) => {
    expect(await call(action)).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'projectId is required' } });
    expect(await call(action, { projectId: 'p1', includeArchived: true, statuses: ['draft'], limit: 5 })).toEqual({ success: true, data: ['byProject'] });
    expect(h.service.listByProject).toHaveBeenCalledWith('p1', { includeArchived: true, statuses: ['draft'], limit: 5 });
  });

  it('listAll 透传过滤项；listBySourceConversation 缺 sourceConversationId → INVALID_ARGS', async () => {
    expect(await call('listAll', { limit: 3 })).toEqual({ success: true, data: ['all'] });
    expect(h.service.listAll).toHaveBeenCalledWith({ includeArchived: undefined, statuses: undefined, limit: 3 });
    expect(await call('listBySourceConversation', {})).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'sourceConversationId is required' } });
    expect(await call('listBySourceConversation', { sourceConversationId: 'c1' })).toEqual({ success: true, data: ['bySource'] });
  });

  it.each(['updateRevision', 'updateDraftRevision'])('%s：缺 payload → INVALID_ARGS；成功推 draft_updated', async (action) => {
    expect(await call(action)).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'payload is required' } });
    expect((await call(action, { workCardId: 'wc1' })).success).toBe(true);
    expect(h.send).toHaveBeenCalledWith(IPC_CHANNELS.TAG_EVENT, expect.objectContaining({ reason: 'draft_updated' }));
  });

  it('updateMeta：缺 actorUserId → INVALID_ARGS', async () => {
    expect(await call('updateMeta', { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId and actorUserId are required' } });
  });
});

describe('运行入口', () => {
  it('createAndRun：缺 payload → INVALID_ARGS；返回 workCard+revision；后台 run 失败只记日志', async () => {
    expect(await call('createAndRun')).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'payload is required' } });
    h.runtime.createAndRun.mockReturnValueOnce({ workCard: { id: 'wc1' }, revision: { id: 'r1' }, run: Promise.reject(new Error('run boom')) });
    expect(await call('createAndRun', { projectId: 'p1' })).toEqual({ success: true, data: { workCard: { id: 'wc1' }, revision: { id: 'r1' } } });
    await flush();
    expect(h.logError).toHaveBeenCalledWith('Failed to run direct @neo work card', expect.any(Error));
  });

  it('continueAndRun：缺字段 → INVALID_ARGS；roundTurnId 取 trim 后的 clientSourceMessageId', async () => {
    expect(await call('continueAndRun', { workCardId: 'wc1' })).toEqual({
      success: false,
      error: { code: 'INVALID_ARGS', message: 'workCardId, conversationId and requesterUserId are required' },
    });
    const res = await call('continueAndRun', { workCardId: 'wc1', conversationId: 'c1', requesterUserId: 'u1', clientSourceMessageId: '  msg-1  ' });
    expect(res).toEqual({ success: true, data: { workCard: { id: 'wc1' }, revision: { id: 'r2' }, roundTurnId: 'msg-1' } });
    expect(h.runtime.continueAndRun).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'msg-1', userText: '', conversationId: 'c1' }));
  });
});

describe('审阅流转', () => {
  it.each([['approve', 'approvedByUserId'], ['approveRevision', 'approvedByUserId']])('%s：reviewer 回退 %s，批准后发起运行，运行失败只记日志', async (action, field) => {
    expect(await call(action, { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId and reviewerUserId are required' } });
    h.runtime.launchApproved.mockRejectedValueOnce(new Error('launch boom'));
    expect(await call(action, { workCardId: 'wc1', [field]: 'u2', feedback: 'ok' })).toEqual({ success: true, data: { approved: true } });
    expect(h.service.approveRevision).toHaveBeenCalledWith({ workCardId: 'wc1', revisionId: undefined, reviewerUserId: 'u2', feedback: 'ok', expiresAt: undefined });
    await flush();
    expect(h.logError).toHaveBeenCalledWith('Failed to launch approved Neo work card runtime', expect.any(Error));
  });

  it.each(['reject', 'rejectRevision'])('%s：reviewer 回退 rejectedByUserId', async (action) => {
    expect(await call(action, { workCardId: 'wc1', rejectedByUserId: 'u3' })).toEqual({ success: true, data: { rejected: true } });
    expect(h.service.rejectRevision).toHaveBeenCalledWith({ workCardId: 'wc1', revisionId: undefined, reviewerUserId: 'u3', feedback: undefined });
  });

  it('cancel：actor 回退 cancelledByUserId；服务返回 null → NOT_FOUND', async () => {
    expect(await call('cancel', { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId and actorUserId are required' } });
    expect(await call('cancel', { workCardId: 'wc1', cancelledByUserId: 'u4' })).toEqual({ success: true, data: { id: 'wc1' } });
    expect(h.service.cancel).toHaveBeenCalledWith({ workCardId: 'wc1', actorUserId: 'u4', feedback: undefined });
    h.service.cancel.mockReturnValueOnce(null);
    expect(await call('cancel', { workCardId: 'wc1', actorUserId: 'u4' })).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'work card not found' } });
  });

  it('archive：带 actor 传对象、不带传 id；null → NOT_FOUND', async () => {
    expect(await call('archive', {})).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId is required' } });
    await call('archive', { workCardId: 'wc1', actorUserId: 'u5', feedback: 'bye' });
    expect(h.service.archive).toHaveBeenLastCalledWith({ workCardId: 'wc1', actorUserId: 'u5', feedback: 'bye' });
    await call('archive', { workCardId: 'wc1' });
    expect(h.service.archive).toHaveBeenLastCalledWith('wc1');
    h.service.archive.mockReturnValueOnce(null);
    expect(await call('archive', { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'work card not found' } });
  });

  it('acceptResult / requestChanges：缺 actor → INVALID_ARGS；透传 feedback/openQuestions', async () => {
    expect(await call('acceptResult', { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId and actorUserId are required' } });
    expect(await call('acceptResult', { workCardId: 'wc1', actorUserId: 'u6', feedback: 'good' })).toEqual({ success: true, data: { accepted: true } });
    expect(await call('requestChanges', { workCardId: 'wc1', actorUserId: 'u6', openQuestions: ['why?'] })).toEqual({ success: true, data: { changed: true } });
    expect(h.service.requestChanges).toHaveBeenCalledWith({ workCardId: 'wc1', actorUserId: 'u6', feedback: undefined, openQuestions: ['why?'] });
  });

  it('approve/rejectMemoryCandidate：缺 candidateId → INVALID_ARGS；reject 带 reason', async () => {
    expect(await call('approveMemoryCandidate', { actorUserId: 'u7' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'candidateId and actorUserId are required' } });
    expect(await call('approveMemoryCandidate', { candidateId: 'm1', actorUserId: 'u7' })).toEqual({ success: true, data: { workCardId: 'wc1' } });
    await call('rejectMemoryCandidate', { candidateId: 'm1', actorUserId: 'u7', reason: 'dup' });
    expect(h.service.rejectMemoryCandidate).toHaveBeenCalledWith({ candidateId: 'm1', actorUserId: 'u7', reason: 'dup' });
  });

  it('appendDelta：缺 runId → INVALID_ARGS；成功推 delta_appended', async () => {
    expect(await call('appendDelta', { workCardId: 'wc1' })).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'workCardId and runId are required' } });
    expect(await call('appendDelta', { workCardId: 'wc1', runId: 'run1' })).toEqual({ success: true, data: { delta: 1 } });
    expect(h.send).toHaveBeenCalledWith(IPC_CHANNELS.TAG_EVENT, expect.objectContaining({ reason: 'delta_appended' }));
  });
});
