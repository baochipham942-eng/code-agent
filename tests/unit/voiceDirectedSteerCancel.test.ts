// ============================================================================
// R2 定向 steer / cancel：编号可引用 + 对不上就 fail-closed
//
// 要钉死的是一条**否定**语义：给了 target 却对不上时，绝不退回作用于「手上那件」。
// 这类门最容易写成假绿——只测「对得上时能用」的话，一个「找不到就用当前活」的
// fail-open 实现照样全绿，而那正是「想停 2 号却停了 1 号」。所以每条拒绝断言都同时
// 断言**底层动作一次都没被调用**（cancelTask / interruptAndContinue），
// 光断言回复文案挡不住「嘴上拒绝、手上照做」。
//
// 另一半是编号本身要稳：编号取账本登记次序，不取「当前存活项里的第几个」——
// 后者每落一件活就整体前移，用户听到的号和他说出口的号会指向不同的活。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/shared/contract/agent';
import type { AgentRunOptions } from '../../src/host/research/types';
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
    onWorkItem: () => {},
    onEndCall: () => {},
    onWorkNarration: (narration) => { narrations.push(narration) },
    onWorkFailed: () => {},
  });
}

/** 派一件活并让它跑起来。 */
async function spawnRunning(title: string): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'spawn_task', title, prompt: `做${title}` });
  runtime.emit('task_started');
  runtime.status = 'running';
}

/**
 * 造出「账本里两件活都没落终态」的局面。
 *
 * 这不是假设出来的形状：run 的终态事件丢了（进程重启 / 事件总线断过）之后，
 * TaskManager 会说 idle 而账本里那件仍停在 running，下一次派活就会叠上去。
 * 定向指错活的风险恰恰只在这种局面下才存在，所以它必须是被测的那个局面。
 */
async function spawnTwoLive(): Promise<void> {
  await spawnRunning('写周报');
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'spawn_task', title: '订机票', prompt: '订机票' });
  runtime.emit('task_started');
  runtime.status = 'running';
}

function clearCalls(): void {
  runtime.startTask.mockClear();
  runtime.cancelTask.mockClear();
  runtime.interruptAndContinue.mockClear();
}

/** 拒绝语义的完整判据：嘴上拒绝**且**手上什么都没动。 */
function expectNothingTouched(): void {
  expect(runtime.cancelTask).not.toHaveBeenCalled();
  expect(runtime.interruptAndContinue).not.toHaveBeenCalled();
  expect(runtime.startTask).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.listeners.clear();
  runtime.observers.clear();
  runtime.incompleteTasks = [];
  runtime.status = 'idle';
  clearCalls();
  begin();
});

afterEach(() => {
  endVoiceDispatch();
  vi.useRealTimers();
});

describe('get_active_tasks — 可指挥的带编号，不可指挥的不带', () => {
  it('我派出去的活带编号', async () => {
    await spawnRunning('写周报');

    const reply = await dispatchVoiceIntent({ kind: 'status' });

    expect(reply).toContain('1. 写周报');
    expect(reply).toContain('把编号传给 target');
  });

  it('执行侧计划条目单列且写明改不了停不了', async () => {
    runtime.incompleteTasks = [{ subject: '修一个 bug', status: 'in_progress' }];
    await spawnRunning('写周报');

    const reply = await dispatchVoiceIntent({ kind: 'status' });

    // 计划条目不带编号——带了就会被拿去当 target，而它根本不是 run。
    expect(reply).toContain('- 修一个 bug');
    expect(reply).not.toContain('2. 修一个 bug');
    expect(reply).toContain('改不了也停不了');
  });

  it('编号取登记次序：先跑完一件，后一件不会顶替它的号', async () => {
    await spawnRunning('写周报');
    runtime.status = 'idle';
    runtime.emit('task_completed');
    await vi.advanceTimersByTimeAsync(0);
    await dispatchVoiceIntent({ kind: 'spawn_task', title: '订机票', prompt: '订机票' });

    const reply = await dispatchVoiceIntent({ kind: 'status' });

    // 「订机票」是第 2 件登记的，就永远是 2 号。若改成「存活项里的第几个」，
    // 这里会显示 1——而用户刚听过的 1 号是「写周报」。
    expect(reply).toContain('2. 订机票');
    expect(reply).not.toContain('1. 订机票');
  });

  it('一件活都没有时照旧直说', async () => {
    const reply = await dispatchVoiceIntent({ kind: 'status' });
    expect(reply).toBe('当前没有进行中的任务。');
  });
});

describe('不给 target = 原语义（零行为回归）', () => {
  it('steer_task 照旧打断当前这轮', async () => {
    await spawnRunning('写周报');
    clearCalls();

    await dispatchVoiceIntent({ kind: 'steer_task', instruction: '改成月报' });

    expect(runtime.interruptAndContinue).toHaveBeenCalledTimes(1);
  });

  it('cancel_task 照旧发出停止', async () => {
    await spawnRunning('写周报');
    clearCalls();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task' });

    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);
    expect(reply).toContain('正在让');
  });
});

describe('给了对得上的编号 = 与不给一致', () => {
  it('steer 到 1 号（就是手上那件）照常改方向', async () => {
    await spawnRunning('写周报');
    clearCalls();

    await dispatchVoiceIntent({ kind: 'steer_task', instruction: '改成月报', target: '1' });

    expect(runtime.interruptAndContinue).toHaveBeenCalledTimes(1);
  });

  it('cancel 到 1 号照常叫停', async () => {
    await spawnRunning('写周报');
    clearCalls();

    await dispatchVoiceIntent({ kind: 'cancel_task', target: '1' });

    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);
  });

  it('「2号」这种带字的写法也认', async () => {
    await spawnTwoLive();
    clearCalls();

    await dispatchVoiceIntent({ kind: 'cancel_task', target: '2号' });

    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);
  });
});

describe('对不上就 fail-closed —— 绝不退回作用于当前活', () => {
  it('查无此编号：什么都不动，让用户重新看一眼', async () => {
    await spawnRunning('写周报');
    clearCalls();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task', target: '7' });

    expectNothingTouched();
    expect(reply).toContain('没有编号是「7」的活');
    expect(reply).toContain('get_active_tasks');
  });

  it('查无此编号的 steer 同样什么都不动', async () => {
    await spawnRunning('写周报');
    clearCalls();

    const reply = await dispatchVoiceIntent({
      kind: 'steer_task', instruction: '改成月报', target: '7',
    });

    expectNothingTouched();
    expect(reply).toContain('没有编号是「7」的活');
  });

  it('指到已经结束的活：不动，也不假装停了', async () => {
    await spawnRunning('写周报');
    runtime.status = 'idle';
    runtime.emit('task_completed');
    await vi.advanceTimersByTimeAsync(0);
    await spawnRunning('订机票');
    clearCalls();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task', target: '1' });

    expectNothingTouched();
    expect(reply).toContain('写周报');
    expect(reply).toContain('不用再停它');
  });

  it('指到还活着但不是手上那件：如实说停不了，当前那件毫发无伤', async () => {
    await spawnTwoLive();
    clearCalls();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task', target: '1' });

    // 这是整条链存在的理由：宁可停不了，也不能把「停 1 号」办成「停 2 号」。
    expectNothingTouched();
    expect(reply).toContain('不是我手上正在跑的那件');
    expect(reply).toContain('订机票');
    expect(reply).toContain('不要说你已经动了它');
  });

  it('一句里有两个数字（「1 或 2」）：认不出就拒绝，不替用户挑一个', async () => {
    await spawnTwoLive();
    clearCalls();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task', target: '1 或 2' });

    expectNothingTouched();
    expect(reply).toContain('没有编号是');
  });
});

describe('多活时口播点名是哪件的进度', () => {
  /** 走真链路产一条进度：先播一次快照，再让其中一条跃迁到 completed。 */
  async function emitCompletedStep(step: string): Promise<void> {
    runtime.emitAgent({ type: 'todo_update', data: [{ content: step, status: 'in_progress', activeForm: step }] });
    runtime.emitAgent({ type: 'todo_update', data: [{ content: step, status: 'completed', activeForm: step }] });
    await vi.advanceTimersByTimeAsync(0);
  }

  it('只有一件活时不点名（没有歧义就别多话）', async () => {
    await spawnRunning('写周报');
    narrations.length = 0;

    await emitCompletedStep('列提纲');

    const milestone = narrations.find((n) => n.status === 'milestone');
    expect(milestone?.summary).toContain('列提纲，这步做完了');
    expect(milestone?.summary).not.toContain('「写周报」这边');
  });

  it('两件活都没落终态时，进度带上活名', async () => {
    await spawnTwoLive();
    narrations.length = 0;

    await emitCompletedStep('查航班');

    const milestone = narrations.find((n) => n.status === 'milestone');
    expect(milestone?.summary).toContain('「订机票」这边，查航班，这步做完了');
  });
});
