// G1 回归门：语音派出去的活失败了，必须有人把这件事说出去。
//
// 真机现场（2026-07-28 验收报告 §4.5，自评最严重）：执行侧连续抛异常/401 死亡，
// 界面上一个字的错误提示都没有，语音模型继续说「已经写入 hello 了」——
// 而工作目录里那两个文件根本不存在，一次工具调用都没发生。
//
// 根因不是"链路没建"：账本早就把 task_error 映射成 settle(failed)。断的是最后一米——
// 没有任何出口把 failed 说出去。所以这里钉的是**出口真的被调用**，不是状态字段被赋值。
//
// 三条承重断言：
//   1. 失败带**真实原因**出去（不是兜底的「执行失败」四个字）；
//   2. **挂断之后**才死的活，失败出口**仍然触发**——emit 挂断即 null，而语音派出的 run
//      常常比通话活得久，「挂断后才死」正是最需要留痕的那种失败；
//   3. 失败出口自己抛异常，不许影响还票与后续事件（fail-safe，不是 fail-silent）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';
import type { VoiceWorkFailureMarker } from '../../src/shared/contract/voice';

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
  interruptAndContinue: vi.fn(async (_sessionId: string, _message: string) => ({ outcome: 'steered' as const })),
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

const clearLiveVoiceSession = vi.hoisted(() => vi.fn());
const notifyVoiceWorkSettled = vi.hoisted(() => vi.fn());

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    // §2 进度旁路：真 TaskManager 有这个方法，替身不给就会让 ensureListener 走降级分支，
    // 测到的就不是产品真实路径。
    observeAgentEvents: () => () => {},
    getSessionState: () => ({ status: runtime.status }),
    startBackgroundTask: (
      _taskId: string,
      sessionId: string,
      message: string,
      attachments: unknown,
      options: AgentRunOptions,
    ) => runtime.startTask(sessionId, message, attachments, options),
    cancelBackgroundTask: (_taskId: string) => runtime.cancelTask('session-1').then(() => true),
    interruptBackgroundTask: (_taskId: string, message: string) => runtime.interruptAndContinue('session-1', message),
    startTask: runtime.startTask,
    interruptAndContinue: runtime.interruptAndContinue,
    cancelTask: runtime.cancelTask,
  }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => '<role/>'),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/voice/voiceWorkEvidence', () => ({
  resolveVoiceWorkOutcome: vi.fn(async () => 'done'),
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => ({ messages: [] }) }),
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
    clearLiveVoiceSession,
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

type Item = { id: string; status: string; title: string; detail?: string; failure?: VoiceWorkFailureMarker };

let upserts: Item[];
let failures: Item[];
let failHookThrows: boolean;

function bind(): void {
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: (item) => { upserts.push({ ...item }); },
    onEndCall: () => {},
    onWorkNarration: () => {},
    onWorkFailed: (item) => {
      failures.push({ ...item });
      if (failHookThrows) throw new Error('reporter exploded');
    },
  });
}

async function spawn(title = '建个文件'): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'delegate_task', title, prompt: '建一个 test-b.txt' });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  runtime.listeners.clear();
  runtime.startTask.mockClear();
  clearLiveVoiceSession.mockClear();
  notifyVoiceWorkSettled.mockClear();
  upserts = [];
  failures = [];
  failHookThrows = false;
  endVoiceDispatch();
});

describe('G1 语音派活失败必须被说出去', () => {
  it('失败带真实原因出去，不是兜底的「执行失败」', async () => {
    bind();
    await spawn('建个文件');

    runtime.emit('task_error', 'session-1', { error: '服务认证异常' });

    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe('failed');
    expect(failures[0].title).toBe('建个文件');
    // 这条是重点：真实原因必须活着到出口。退化成「执行失败」等于告诉用户一句废话。
    expect(failures[0].detail).toBe('服务认证异常');
    expect(failures[0].detail).not.toBe('执行失败');
    expect(notifyVoiceWorkSettled).not.toHaveBeenCalled();
  });

  it('挂断之后才死的活，失败出口仍然触发（UI 回流已断，留痕不许跟着断）', async () => {
    bind();
    await flush();
    await spawn();
    const upsertsBeforeHangup = upserts.length;

    // 挂断：endVoiceDispatch 把 emit 置 null（只断 UI 回流，账本继续活）
    endVoiceDispatch();
    runtime.emit('task_error', 'session-1', { error: '服务认证异常' });
    await flush();

    // UI 回流确实断了……
    expect(upserts).toHaveLength(upsertsBeforeHangup);
    // ……但失败出口必须照样响。这是 G1 里最需要留痕的那种失败。
    expect(failures).toHaveLength(1);
    // 账本内部（onFailed 出口）保留原始原因——后续消费方（落库 metadata）还要用它。
    expect(failures[0].detail).toBe('服务认证异常');
    // 但通知 body 是用户可见文案，必须过⑤的统一出口（批 X）：认不出的错误
    // 给通用人话，原始原因只活在会话消息的 metadata 里，不进通知正文。
    expect(notifyVoiceWorkSettled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      taskTitle: '建个文件',
      status: 'failed',
      detail: '执行时出了问题，没有完成',
    });
  });

  it('done / cancelled 不触发失败出口（别把正常终态也报成失败）', async () => {
    bind();
    await spawn();
    runtime.emit('task_completed');
    await flush();
    expect(failures).toEqual([]);

    bind();
    await spawn();
    expect(runtime.startTask).toHaveBeenCalledTimes(2);
    runtime.emit('task_cancelled');
    expect(failures).toEqual([]);
  });

  it('失败出口自己抛异常，不影响还票（fail-safe，不是 fail-silent）', async () => {
    bind();
    await spawn();
    failHookThrows = true;

    expect(() => runtime.emit('task_error', 'session-1', { error: '炸了' })).not.toThrow();
    expect(failures).toHaveLength(1);
    // 还票必须照做——出口抛异常不许把 D4 的抬严票据永久扣在会话上。
    expect(clearLiveVoiceSession).toHaveBeenCalled();
  });

  // 批 X5 ③：标记要**穿过**无类型的事件总线到账本，文案出口才认得出。
  it('鉴权失败标记穿过 task_error 落进账本（认不出的形状一律丢弃）', async () => {
    bind();
    await spawn();

    runtime.emit('task_error', 'session-1', {
      error: "OpenAI API (401): You didn't provide an API key.",
      failure: { code: 'MODEL_AUTH', provider: 'openai', model: 'gpt-4o' },
    });

    expect(failures[0].failure).toEqual({ code: 'MODEL_AUTH', provider: 'openai', model: 'gpt-4o' });

    failures.length = 0;
    endVoiceDispatch();
    bind();
    await spawn();
    runtime.emit('task_error', 'session-1', { error: '炸了', failure: { code: 'SOMETHING_ELSE' } });
    expect(failures[0].failure).toBeUndefined();
  });

  it('事件里带的不是字符串时 detail 只能退化成兜底——这就是 TaskManager 必须发字符串的原因', async () => {
    bind();
    await spawn();

    // 修复前 TaskManager 发的就是 Error 对象，于是每一次失败都长这样。
    runtime.emit('task_error', 'session-1', { error: new Error('服务认证异常') });

    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toBe('执行失败');
  });
});
