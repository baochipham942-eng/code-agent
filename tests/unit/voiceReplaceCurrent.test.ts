// ============================================================================
// §1 打断原子性：replace_current 异步确认 + cancel fail-closed
//
// 要钉死的是**一道门和它的两条出口**：
//   门：确认旧 run 落终态之前，绝不 startRun（防双跑）。
//   出口 A：终态到了 → 派新活 + 注入「旧的收尾了，新的开始了」。
//   出口 B：等不到（超时，重发 cancel 一次仍不到）→ **不派新活** + fail-loud 注入。
//
// 为什么必须有出口 B 的断言：一个「先 cancel，然后无论如何都 startRun」的实现，
// 只测出口 A 照样全绿——而它正是这条链要防的双跑。
//
// 时间这一维用 fake timers 显式推进：门的语义是「在终态到达**之前**的那段时间里
// 什么都没发生」，所以每条断言都分「推进之前」「推进之后」两次看，不把时间线压成一发。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';
import type { VoiceWorkNarration } from '../../src/shared/contract/voice';
import { VOICE_STOP_CONFIRM_RETRIES, VOICE_STOP_CONFIRM_TIMEOUT_MS } from '../../src/shared/constants/voice';

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
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  observeAgentEvents: (_o: unknown) => () => {},
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    // §2 进度旁路：真 TaskManager 有这个方法，替身不给就会让 ensureListener 走降级分支，
    // 测到的就不是产品真实路径。
    observeAgentEvents: runtime.observeAgentEvents,
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: vi.fn(),
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
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
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

/** 先派一件活并让它跑起来，作为「手上那件」。 */
async function spawnRunning(): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'spawn_task', title: '写周报', prompt: '写一份周报' });
  runtime.emit('task_started');
  runtime.status = 'running';
  runtime.startTask.mockClear();
}

/** 把确认窗全部走完（初次 + 全部重试）。 */
async function exhaustConfirmWindow(): Promise<void> {
  for (let i = 0; i <= VOICE_STOP_CONFIRM_RETRIES; i += 1) {
    await vi.advanceTimersByTimeAsync(VOICE_STOP_CONFIRM_TIMEOUT_MS);
  }
  await vi.advanceTimersByTimeAsync(0);
}

const announcements = () => narrations.filter((n) => n.status === 'announcement');

beforeEach(() => {
  vi.useFakeTimers();
  runtime.listeners.clear();
  runtime.startTask.mockClear();
  runtime.cancelTask.mockClear();
  runtime.status = 'idle';
  begin();
});

afterEach(() => {
  endVoiceDispatch();
  vi.useRealTimers();
});

describe('replace_current — 确认终态前绝不 startRun', () => {
  it('工具立即返回且不阻塞，但新活一次都没派出去', async () => {
    await spawnRunning();

    const reply = await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });

    // 硬门：终态还没到，startTask 必须一次都没调。
    expect(runtime.startTask).not.toHaveBeenCalled();
    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);
    // 台词只描述「正在停」这件已经真发生的事，不许声称新活已经开始。
    expect(reply).toContain('正在把手上那件停下来');
    expect(reply).toContain('还没有开始做');
  });

  it('旧的落终态后才派新活，并注入「旧的收尾了、新的开始了」', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });
    expect(runtime.startTask).not.toHaveBeenCalled();

    runtime.status = 'idle';
    runtime.emit('task_cancelled');
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.startTask).toHaveBeenCalledTimes(1);
    const spoken = announcements();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('手上那件已经收尾了');
    expect(spoken[0]?.summary).toContain('建个文件');
  });

  it('超时（含重发 cancel）仍等不到终态 → 不派新活 + 说清两件事都没成', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });

    await exhaustConfirmWindow();

    // 出口 B：这是整条链存在的理由——等不到就宁可丢掉替换意图，也不双跑。
    expect(runtime.startTask).not.toHaveBeenCalled();
    const spoken = announcements();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('没能确认它停下来');
    expect(spoken[0]?.summary).toContain('没有开始做');
  });

  it('第一次超时会重发 cancel，而不是直接放弃', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });
    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(VOICE_STOP_CONFIRM_TIMEOUT_MS);

    expect(runtime.cancelTask).toHaveBeenCalledTimes(1 + VOICE_STOP_CONFIRM_RETRIES);
    // 重试期间门依然关着。
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('超时之后旧活自己跑完了，它的结局照样念（抑制已解除）', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });
    await exhaustConfirmWindow();
    narrations.length = 0;

    runtime.emit('task_completed');
    await vi.advanceTimersByTimeAsync(0);

    // 它没被顶掉成功，就还是一件正常的活——结局必须说。
    expect(narrations.some((n) => n.status !== 'announcement')).toBe(true);
  });
});

describe('replace_current — 正对照与边界', () => {
  it('没有活在跑时 replace_current=true 直接派，一次 startTask，不走停旧链', async () => {
    runtime.status = 'idle';

    const reply = await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });

    expect(runtime.startTask).toHaveBeenCalledTimes(1);
    expect(runtime.cancelTask).not.toHaveBeenCalled();
    expect(reply).toContain('我已经开始做');
  });

  it('有活在跑但没传 replace_current → 维持拒新，不 cancel 也不 startRun', async () => {
    await spawnRunning();

    const reply = await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt',
    });

    expect(runtime.startTask).not.toHaveBeenCalled();
    expect(runtime.cancelTask).not.toHaveBeenCalled();
    expect(reply).toContain('还有一件活在跑');
  });

  it('停旧的在途时再来一次 replace → 不覆盖、不排队，如实说', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '第一件', prompt: 'A', replaceCurrent: true,
    });
    runtime.cancelTask.mockClear();

    const reply = await dispatchVoiceIntent({
      kind: 'spawn_task', title: '第二件', prompt: 'B', replaceCurrent: true,
    });

    expect(reply).toContain('还没停稳');
    expect(runtime.cancelTask).not.toHaveBeenCalled();
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('挂断作废在途的替换：终态再到也不派新活', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });

    endVoiceDispatch();
    runtime.emit('task_cancelled');
    await vi.advanceTimersByTimeAsync(0);

    // 挂断 = 用户不要执行。「通话结束补派」那条链已被整条删掉，不许从这里长回来。
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('被顶掉的活不回头念它的结局', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({
      kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt', replaceCurrent: true,
    });

    runtime.status = 'idle';
    runtime.emit('task_completed');
    await vi.advanceTimersByTimeAsync(0);

    // 唯一该出声的是替换回报；旧活的 done 不念。
    expect(narrations.every((n) => n.status === 'announcement')).toBe(true);
  });
});

describe('进度旁路接不上时，派活必须照常', () => {
  it('observeAgentEvents 抛异常 → 活照样派出去，只是没有中途进度', async () => {
    // 2026-08-02 实测：T5 把 observeAgentEvents 接进 ensureListener 后，替身缺这个方法
    // 让**整条派活链**在 30 条测试里全炸。中途进度是锦上添花的功能，它接不上时
    // 用户该失去的是「听不到进度」，不是「语音派活整个不能用」。这道门钉住这件事。
    const spy = vi.spyOn(runtime, 'observeAgentEvents').mockImplementation(() => {
      throw new Error('observer unavailable');
    });
    try {
      runtime.status = 'idle';
      const reply = await dispatchVoiceIntent({ kind: 'spawn_task', title: '建个文件', prompt: '建 a.txt' });
      expect(runtime.startTask).toHaveBeenCalledTimes(1);
      expect(reply).toContain('我已经开始做');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cancel_task — 从 fail-open 改为异步确认', () => {
  it('立即返回时只说「正在停」，绝不说「已经停了」', async () => {
    await spawnRunning();

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task' });

    expect(reply).toContain('正在让');
    // 上一版这里返回「已经让『X』停下来了」——终态事件还没到就宣布停了，是 fail-open 的谎报。
    // 现在必须带上明确禁令；断言禁令本身，而不是「不含某子串」（禁令句里就有那个子串）。
    expect(reply).toContain('不要说它已经停了');
    expect(runtime.cancelTask).toHaveBeenCalledTimes(1);
    expect(announcements()).toHaveLength(0);
  });

  it('task_cancelled 到达后才注入「已经停下来了」', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({ kind: 'cancel_task' });

    runtime.status = 'idle';
    runtime.emit('task_cancelled');
    await vi.advanceTimersByTimeAsync(0);

    const spoken = announcements();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('已经停下来了');
    // 纯 cancel 不该顺手派活。
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('停不下来时如实说没停稳，不假装停了', async () => {
    await spawnRunning();
    await dispatchVoiceIntent({ kind: 'cancel_task' });

    await exhaustConfirmWindow();

    const spoken = announcements();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('没能确认它停下来');
    expect(spoken[0]?.summary).not.toContain('已经停下来了');
  });

  it('没有活在跑时照旧直说不用停', async () => {
    runtime.status = 'idle';
    const reply = await dispatchVoiceIntent({ kind: 'cancel_task' });
    expect(reply).toContain('不用停');
    expect(runtime.cancelTask).not.toHaveBeenCalled();
  });
});
