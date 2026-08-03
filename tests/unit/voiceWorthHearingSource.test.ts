// ============================================================================
// R3 worth-hearing 的取值口：只认任务轨上「刚刚卡住」的那一下
//
// 这一组管的是**标记从哪来**（队列怎么对待标记见 voiceSessionMutex 的
// 「worth-hearing 标记」组）。两条边界一样承重：
//   - 认跃迁不认状态：task_update 每次带全量列表，认「当前是 blocked」会让同一条
//     卡点在后续每个事件里被反复念。
//   - 只认 blocked：标记一旦泛化成「进展重要时标一下」，节制闸等于没有——
//     每个生产者都觉得自己那条重要。所以完成/创建/取消都必须**不**标。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/shared/contract/agent';
import type { AgentRunOptions } from '../../src/host/research/types';
import type { SessionTask } from '../../src/shared/contract/planning';
import type { VoiceWorkNarration } from '../../src/shared/contract/voice';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  observers: new Set<(sessionId: string, event: AgentEvent) => void>(),
  status: 'idle' as string,
  incompleteTasks: [] as Array<{ subject: string; status: string }>,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  interruptAndContinue: vi.fn(async (
    _sessionId: string,
    _instruction: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
  emitAgent(event: AgentEvent, sessionId = 'session-1') {
    for (const observer of [...this.observers]) observer(sessionId, event);
  },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    observeAgentEvents: (observer: (sessionId: string, event: AgentEvent) => void) => {
      runtime.observers.add(observer);
      return () => { runtime.observers.delete(observer); };
    },
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: runtime.interruptAndContinue,
    cancelTask: runtime.cancelTask,
  }),
}));
vi.mock('../../src/host/session/completionSummaryService', () => ({
  readLatestCompletionSummaryRecord: vi.fn(async () => null),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => '<role/>'),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => runtime.incompleteTasks,
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ messages: [{ role: 'assistant', content: '做完了。' }] }),
    addMessageToSession: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyVoiceWorkSettled: vi.fn() },
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

const { beginVoiceDispatch, endVoiceDispatch, dispatchVoiceIntent } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');

const narrations: VoiceWorkNarration[] = [];

function begin(): void {
  narrations.length = 0;
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: () => {},
    onEndCall: () => {},
    onWorkNarration: (narration) => { narrations.push(narration) },
    onWorkFailed: () => {},
  });
}

/** 派一件活并让它跑起来（worth-hearing 只在有活在跑时才产）。 */
async function spawnRunning(title: string): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'spawn_task', title, prompt: `做${title}` });
  runtime.emit('task_started');
  runtime.status = 'running';
}

function task(overrides: Partial<SessionTask> & { id: string; status: SessionTask['status'] }): SessionTask {
  return {
    subject: '登录后台',
    description: '',
    activeForm: '登录后台中',
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionTask;
}

/** 推一轮任务轨。第一轮只播种（认跃迁要求上一次存在），所以造卡点要推两轮。 */
async function pushTasks(tasks: SessionTask[]): Promise<void> {
  runtime.emitAgent({ type: 'task_update', data: { tasks, action: 'update' } });
  await vi.advanceTimersByTimeAsync(0);
}

const worthHearing = () => narrations.filter((n) => n.worthHearing === true);

beforeEach(() => {
  vi.useFakeTimers();
  runtime.listeners.clear();
  runtime.observers.clear();
  runtime.incompleteTasks = [];
  runtime.status = 'idle';
  runtime.startTask.mockClear();
  runtime.cancelTask.mockClear();
  runtime.interruptAndContinue.mockClear();
  begin();
});

afterEach(() => {
  endVoiceDispatch();
  vi.useRealTimers();
});

describe('刚刚卡住 → worth-hearing', () => {
  it('从非 blocked 跃迁到 blocked 时产一条带标记的进度，并说清卡在哪一步', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    narrations.length = 0;

    await pushTasks([task({
      id: 't1', status: 'blocked', blockedReason: '这个报表页要公司账号登录，我们没有',
    })]);

    const spoken = worthHearing();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.status).toBe('milestone');
    expect(spoken[0]?.summary).toContain('『写周报』这边卡住了');
    expect(spoken[0]?.summary).toContain('登录后台');
    expect(spoken[0]?.summary).toContain('要公司账号登录');
  });

  it('措辞同时挡住两种润色：既不是做完了，也不是失败了', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    narrations.length = 0;

    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);

    const summary = worthHearing()[0]?.summary ?? '';
    expect(summary).toContain('既没有做完，也不算失败');
    expect(summary).toContain('不要说它完成了，也不要说它失败了');
  });

  it('原因被清洗层剥空时只说卡在哪一步，不编原因', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    narrations.length = 0;

    // blockedReason 存的已是清洗后的结果；模型贴日志时它就是空串。
    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '' })]);

    const summary = worthHearing()[0]?.summary ?? '';
    expect(summary).toContain('卡在「登录后台」这一步');
    expect(summary).not.toContain('未知');
  });

  it('同一条卡点后续每轮都带 blocked，但只念一次', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);
    narrations.length = 0;

    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);
    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);

    // 认「当前是 blocked」而不是认跃迁的实现，会在这里念两遍。
    expect(worthHearing()).toHaveLength(0);
  });

  it('同一拍卡住好几条：只播最后一条，不连发', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' }), task({ id: 't2', status: 'in_progress' })]);
    narrations.length = 0;

    await pushTasks([
      task({ id: 't1', status: 'blocked', subject: '登录后台', blockedReason: '缺权限' }),
      task({ id: 't2', status: 'blocked', subject: '导出报表', blockedReason: '站点拒绝' }),
    ]);

    // 注入一条就会立刻请求一次 response，同一拍连发多条会让 response.create 互相碰撞。
    const spoken = worthHearing();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('导出报表');
  });

  it('同一拍里被略过的那条，之后不会被当成「刚刚卡住」补念', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' }), task({ id: 't2', status: 'in_progress' })]);
    await pushTasks([
      task({ id: 't1', status: 'blocked', subject: '登录后台', blockedReason: '缺权限' }),
      task({ id: 't2', status: 'blocked', subject: '导出报表', blockedReason: '站点拒绝' }),
    ]);
    narrations.length = 0;

    await pushTasks([
      task({ id: 't1', status: 'blocked', subject: '登录后台', blockedReason: '缺权限' }),
      task({ id: 't2', status: 'blocked', subject: '导出报表', blockedReason: '站点拒绝' }),
    ]);

    // 快照必须把被略过的那条也记成 blocked，否则它会在下一轮诈尸。
    expect(worthHearing()).toHaveLength(0);
  });

  it('解开之后再次卡住，算新的一次转折', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    narrations.length = 0;

    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '站点拒绝了' })]);

    expect(worthHearing()).toHaveLength(1);
  });
});

describe('别的都不标（标记必须稀缺）', () => {
  it('一步做完了不标：那是普通进度', async () => {
    await spawnRunning('写周报');
    narrations.length = 0;

    runtime.emitAgent({ type: 'todo_update', data: [{ content: '列提纲', status: 'in_progress', activeForm: '列提纲' }] });
    runtime.emitAgent({ type: 'todo_update', data: [{ content: '列提纲', status: 'completed', activeForm: '列提纲' }] });
    await vi.advanceTimersByTimeAsync(0);

    // 正对照：确实产了一条进度，只是没带标记——否则这条断言在「什么都没产」时也成立。
    expect(narrations.filter((n) => n.status === 'milestone')).toHaveLength(1);
    expect(worthHearing()).toHaveLength(0);
  });

  it('任务完成 / 取消 / 新建都不标', async () => {
    await spawnRunning('写周报');
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    narrations.length = 0;

    await pushTasks([task({ id: 't1', status: 'completed' })]);
    await pushTasks([task({ id: 't1', status: 'cancelled' })]);
    await pushTasks([task({ id: 't1', status: 'cancelled' }), task({ id: 't2', status: 'pending' })]);

    expect(worthHearing()).toHaveLength(0);
  });

  it('开跑那一刻就已经卡着的任务不念（首轮只播种）', async () => {
    await spawnRunning('写周报');
    narrations.length = 0;

    // 这些是上一轮遗留的卡点，用户早知道了。一开跑就涌一串出来是噪音。
    await pushTasks([
      task({ id: 't1', status: 'blocked', blockedReason: '缺权限' }),
      task({ id: 't2', status: 'blocked', blockedReason: '站点拒绝' }),
    ]);

    expect(worthHearing()).toHaveLength(0);
  });

  it('没有正在跑的语音派活时，任务轨怎么变都不往通话里插播', async () => {
    // 没派活 = pendingId 为空。用户自己在键盘上干的事不该插进电话。
    await pushTasks([task({ id: 't1', status: 'in_progress' })]);
    await pushTasks([task({ id: 't1', status: 'blocked', blockedReason: '缺权限' })]);

    expect(narrations).toHaveLength(0);
  });
});
