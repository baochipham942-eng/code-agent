// ============================================================================
// X5.5-A2-a 完成语义证据门：「派活成功 ≠ 用户目标完成」
//
// 真机病症：一轮 run 什么产物都没留下，只在末尾说了句「我已经帮你建好了」，
// 任务卡照样绿、耳朵里照样听到「做完了」。run 终态只证明循环退出了。
//
// 这里钉两层，缺一层门就有盲区：
//   1. 判据本身（hasVoiceWorkEvidence）——什么算证据、什么不算；
//   2. **接线**（coordinator 收到 task_completed 之后真去查了证据，且四条出口
//      拿到的都是查完的结果）。只测第 1 层的话，把 coordinator 里那次查询删掉
//      测试照样全绿——本批在 autoAdvance 那边刚亲手验过这种盲区。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionSummaryRecord } from '../../src/shared/contract';
import type { AgentRunOptions } from '../../src/host/research/types';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  status: 'idle' as string,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

const readLatestCompletionSummaryRecord = vi.hoisted(() =>
  vi.fn(async (_sessionId: string) => null as CompletionSummaryRecord | null));
const addMessageToSession = vi.hoisted(() => vi.fn(async (_id: string, _msg: unknown) => undefined));
const notifyVoiceWorkSettled = vi.hoisted(() => vi.fn());

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    // §2 进度旁路：真 TaskManager 有这个方法，替身不给就会让 ensureListener 走降级分支，
    // 测到的就不是产品真实路径。
    observeAgentEvents: () => () => {},
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: vi.fn(),
    cancelTask: vi.fn(),
  }),
}));
vi.mock('../../src/host/session/completionSummaryService', () => ({
  readLatestCompletionSummaryRecord,
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => '<role/>'),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ messages: [{ role: 'assistant', content: '我已经帮你建好了。' }] }),
    addMessageToSession,
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyVoiceWorkSettled },
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
    isLiveVoiceSession: () => true,
    getModeForSession: () => 'readOnly',
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => undefined }),
}));

const { hasVoiceWorkEvidence } = await import('../../src/host/services/voice/voiceWorkEvidence');
const { beginVoiceDispatch, endVoiceDispatch, dispatchVoiceIntent } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');

function recordOf(overrides: Partial<CompletionSummaryRecord> = {}): CompletionSummaryRecord {
  return {
    schemaVersion: 1,
    id: 'completion_1',
    sessionId: 'session-1',
    objective: '建个文件',
    status: 'completed',
    startedAt: 0,
    endedAt: Number.MAX_SAFE_INTEGER,
    durationMs: 1,
    iterations: 1,
    tokenUsage: { input: 1, output: 1, total: 2 },
    toolCallCount: 1,
    changedFiles: [],
    commands: [],
    verificationEvidence: [],
    commitIds: [],
    risks: [],
    blockers: [],
    artifactRefs: [],
    // 模型嘴上说做完了。它**不是**证据——这正是要防的那样东西。
    visibleFinalAnswer: { messageId: 'm1', timestamp: 1, sha256: 'x', preview: '我已经帮你建好了。' },
    ...overrides,
  };
}

type Item = { id: string; status: string; title: string };
let upserts: Item[];
let narrations: Array<{ status: string; title: string }>;

function bind(): void {
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: (item) => { upserts.push({ ...item }); },
    onEndCall: () => {},
    onWorkNarration: (narration) => { narrations.push({ status: narration.status, title: narration.title }); },
    onWorkFailed: () => {},
  });
}

async function spawnAndComplete(): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'delegate_task', title: '建个文件', prompt: '建一个 a.txt' });
  runtime.emit('task_completed');
  // 证据查询是异步的（读 run 级 completion summary），终态落在它之后。
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function lastUpsert(): Item {
  return upserts[upserts.length - 1];
}

function settledMarkers(): Array<{ workItemId: string; title: string; outcome: string }> {
  return addMessageToSession.mock.calls
    .map(([, message]) => (message as { metadata?: { voiceWorkSettled?: { workItemId: string; title: string; outcome: string } } }).metadata?.voiceWorkSettled)
    .filter((marker): marker is { workItemId: string; title: string; outcome: string } => Boolean(marker));
}

beforeEach(() => {
  runtime.listeners.clear();
  runtime.startTask.mockClear();
  readLatestCompletionSummaryRecord.mockReset();
  readLatestCompletionSummaryRecord.mockResolvedValue(null);
  addMessageToSession.mockClear();
  notifyVoiceWorkSettled.mockClear();
  upserts = [];
  narrations = [];
  endVoiceDispatch();
});

describe('证据判据（什么算产物证据）', () => {
  it('改过文件 / 有工件 / 有 commit / 有通过的校验，任一成立即算有证据', () => {
    expect(hasVoiceWorkEvidence(recordOf({ changedFiles: ['/tmp/a.txt'] }))).toBe(true);
    expect(hasVoiceWorkEvidence(recordOf({ artifactRefs: [{ kind: 'file', path: '/tmp/a.txt' }] }))).toBe(true);
    expect(hasVoiceWorkEvidence(recordOf({ commitIds: ['abc1234'] }))).toBe(true);
    expect(hasVoiceWorkEvidence(recordOf({
      verificationEvidence: [{ kind: 'command', toolCallId: 'tc-1', command: 'npm test', success: true }],
    }))).toBe(true);
  });

  it('只有模型自述「已经建好了」不算证据；失败的校验命令也不算', () => {
    expect(hasVoiceWorkEvidence(recordOf())).toBe(false);
    expect(hasVoiceWorkEvidence(recordOf({
      verificationEvidence: [{ kind: 'command', toolCallId: 'tc-1', command: 'npm test', success: false }],
    }))).toBe(false);
  });

  it('压根没有 run 记录 = 没有证据（不是「默认通过」）', () => {
    expect(hasVoiceWorkEvidence(null)).toBe(false);
    expect(hasVoiceWorkEvidence(undefined)).toBe(false);
  });
});

describe('接线：task_completed 之后真的去查了证据', () => {
  it('有产物 → 卡片 done、播报 done、结局印章 done', async () => {
    readLatestCompletionSummaryRecord.mockResolvedValue(recordOf({ changedFiles: ['/tmp/a.txt'] }));
    bind();
    await spawnAndComplete();

    expect(readLatestCompletionSummaryRecord).toHaveBeenCalledWith('session-1');
    expect(lastUpsert().status).toBe('done');
    expect(narrations).toEqual([{ status: 'done', title: '建个文件' }]);
    expect(settledMarkers()).toEqual([
      { workItemId: lastUpsert().id, title: '建个文件', outcome: 'done' },
    ]);
  });

  it('零产物 → 四条出口一致落 unverified，绝不出现 done', async () => {
    readLatestCompletionSummaryRecord.mockResolvedValue(recordOf());
    bind();
    await spawnAndComplete();

    expect(lastUpsert().status).toBe('unverified');
    // 耳朵这一路不许比屏幕那一路乐观（同批真机踩过「卡片待核验、模型说做完了」）。
    expect(narrations).toEqual([{ status: 'unverified', title: '建个文件' }]);
    expect(settledMarkers()[0].outcome).toBe('unverified');
    expect(upserts.some((item) => item.status === 'done')).toBe(false);
  });

  it('上一轮遗留的 completion summary 不算这件活的证据（按派活时刻排除）', async () => {
    readLatestCompletionSummaryRecord.mockResolvedValue(recordOf({
      changedFiles: ['/tmp/上一轮改的.txt'],
      endedAt: 1, // 远早于本次派活
    }));
    bind();
    await spawnAndComplete();

    expect(lastUpsert().status).toBe('unverified');
  });

  it('证据读不出来时 fail-closed 落 unverified，不是默认放行', async () => {
    readLatestCompletionSummaryRecord.mockRejectedValue(new Error('disk on fire'));
    bind();
    await spawnAndComplete();

    expect(lastUpsert().status).toBe('unverified');
  });

  it('挂断之后才落地的活：通知走待核验口径，一个「完成」字都没有', async () => {
    readLatestCompletionSummaryRecord.mockResolvedValue(recordOf());
    bind();
    runtime.status = 'idle';
    await dispatchVoiceIntent({ kind: 'delegate_task', title: '建个文件', prompt: '建一个 a.txt' });
    endVoiceDispatch(); // 挂断：播报通道断，通知通道接手
    runtime.emit('task_completed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(narrations).toHaveLength(0);
    expect(notifyVoiceWorkSettled).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', taskTitle: '建个文件', status: 'unverified' }),
    );
  });
});
