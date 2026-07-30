// 全局单路互斥与挂断释放（方案 §2.6 / Phase 0 出口「验证互斥与挂断」）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { isVoiceInputMessage, type Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport, VoiceWorkItem } from '../../src/shared/contract/voice';
import { QWEN_OMNI_REALTIME_MODEL, VOICE_WS_CLOSE_TERMINAL } from '../../src/shared/constants/voice';

const vocabulary = vi.hoisted(() => ({ block: '' }));
vi.mock('../../src/host/services/voice/voiceVocabulary', () => ({
  buildVocabularyBlock: () => vocabulary.block,
}));

const close = vi.fn(async () => undefined);
const sendAudio = vi.fn();
const commitMock = vi.fn();
const updateInstructions = vi.fn();
const injectItem = vi.fn();
let upstreamResponding = false;
const isResponding = vi.fn(() => upstreamResponding);
const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
const patchSessionMetadata = vi.fn(async (_sessionId: string, _patch: Record<string, unknown>) => true);
const getSession = vi.fn(async (_sessionId: string) => ({ workingDirectory: '/repo/voice-session' }));
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), updateInstructions, injectItem, isResponding, close };
});

vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({ qwenOmniTransport: { id: 'qwen-omni', connect } }));
const dashscopeKey = vi.hoisted(() => ({ value: 'test-key' }));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => dashscopeKey.value }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession, patchSessionMetadata, getSession }),
}));
const voiceLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../src/host/services/infra/logger', () => ({ createLogger: () => voiceLogger }));

interface VoiceCallHookParams {
  voiceCallId: string;
  sessionId: string;
  durationSec: number;
  workItemCount?: number;
  reason?: string;
}
const triggerVoiceCall = vi.fn(async (_event: string, _params: VoiceCallHookParams) => ({ blocked: false }));
const initializeTemporaryHookManager = vi.fn(async () => undefined);
const hasTemporaryVoiceCallHook = vi.fn(() => true);
const temporaryTriggerVoiceCall = vi.fn(async (_event: string, _params: VoiceCallHookParams) => ({ blocked: false }));
let hasExistingOrchestrator = true;
vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrchestrator: () => (
      hasExistingOrchestrator ? { getHookManager: () => ({ triggerVoiceCall }) } : undefined
    ),
  }),
}));
vi.mock('../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: initializeTemporaryHookManager,
    hasHooksFor: hasTemporaryVoiceCallHook,
    triggerVoiceCall: temporaryTriggerVoiceCall,
  }),
}));

const voiceDispatchProbe = vi.hoisted(() => ({
  narrate: null as null | ((narration: {
    workItemId: string;
    status: 'done';
    title: string;
    summary: string;
  }) => void),
  fail: null as null | ((item: VoiceWorkItem) => void),
  work: null as null | ((item: VoiceWorkItem) => void),
}));
vi.mock('../../src/host/services/voice/voiceAgentCoordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/services/voice/voiceAgentCoordinator')>();
  return {
    ...actual,
    beginVoiceDispatch: (binding: Parameters<typeof actual.beginVoiceDispatch>[0]) => {
      voiceDispatchProbe.narrate = binding.onWorkNarration as typeof voiceDispatchProbe.narrate;
      voiceDispatchProbe.fail = binding.onWorkFailed;
      voiceDispatchProbe.work = binding.onWorkItem;
      actual.beginVoiceDispatch(binding);
    },
  };
});

const { attachVoiceClient, getActiveVoiceSessionId, endActiveVoiceSession } = await import('../../src/host/services/voice/voiceSessionService');

/** 最小 ws 替身：只要 readyState / OPEN / send / close / 事件。 */
class FakeClient extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  /** host 关的那一下带没带终止 close code；测试自己 close() 时是 undefined（= 模拟断线）。 */
  closeCode: number | undefined;
  send(data: unknown) {
    this.sent.push(typeof data === 'string' ? data : '<binary>');
  }
  close(code?: number) {
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
}

function types(client: FakeClient): string[] {
  return client.sent.filter((s) => s !== '<binary>').map((s) => (JSON.parse(s) as { type: string; code?: string }).code ?? (JSON.parse(s) as { type: string }).type);
}

describe('voiceSessionService 互斥与挂断', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    sendAudio.mockClear();
    commitMock.mockClear();
    updateInstructions.mockClear();
    injectItem.mockClear();
    isResponding.mockClear();
    upstreamResponding = false;
    voiceLogger.info.mockClear();
    voiceLogger.warn.mockClear();
    voiceDispatchProbe.narrate = null;
    voiceDispatchProbe.fail = null;
    addMessageToSession.mockClear();
    lastOnEvent = null;
    vocabulary.block = '';
  });

  // 批 H 起客户端断开只进宽限窗（不再等于挂断），残留会话会污染下一个用例。
  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('第二路通话被拒绝，第一路不受影响', async () => {
    const first = new FakeClient();
    await attachVoiceClient(first as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();

    const second = new FakeClient();
    await attachVoiceClient(second as never, 'session-2');

    expect(types(second)).toContain('VOICE_SESSION_BUSY');
    expect(second.closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1); // 没有为第二路建上游连接
    expect(first.closed).toBe(false);

    first.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull(), { timeout: 4000 });
  });

  it('并发拨号只建一条上游连接（闸门必须早于 await）', async () => {
    // 上游握手不是瞬时的：让它挂一拍，模拟真实的 await 窗口
    connect.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), injectItem, isResponding, updateInstructions, close };
    });

    const a = new FakeClient();
    const b = new FakeClient();
    await Promise.all([attachVoiceClient(a as never, 's1'), attachVoiceClient(b as never, 's2')]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(types(b)).toContain('VOICE_SESSION_BUSY');
    a.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull(), { timeout: 4000 });
  });

  it('挂断释放上游并允许续拨', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });
    expect(getActiveVoiceSessionId()).toBeNull();

    const again = new FakeClient();
    await attachVoiceClient(again as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(2);
    again.close();
  });

  // 2026-07-26 真机踩到的死锁：上游 COMMON_ERROR 后 Host 仍占着 active，
  // 而渲染侧收到 error 就把按钮切回「开始通话」——「挂断」从此点不到，
  // 再拨被自己的互斥挡成 VOICE_SESSION_BUSY，只能重启 app 或干等 10 分钟 max-duration。
  // 判据是「重拨能不能成」，不是「有没有打日志」。
  it('上游报错即释放通话，用户能立刻重拨', async () => {
    const first = new FakeClient();
    await attachVoiceClient(first as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();

    lastOnEvent?.({ type: 'error', code: 'UPSTREAM_ERROR', message: '上游炸了' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
    // 上游连接也要放掉，别留着继续计费（排水窗后才关，见 VOICE_TEARDOWN_DRAIN_MS）
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });

    const again = new FakeClient();
    await attachVoiceClient(again as never, 'session-1');
    expect(types(again)).not.toContain('VOICE_SESSION_BUSY');
    expect(getActiveVoiceSessionId()).not.toBeNull();
    again.close();
  });

  it('上游连接关闭即释放通话，用户能立刻重拨', async () => {
    const first = new FakeClient();
    await attachVoiceClient(first as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();

    lastOnEvent?.({ type: 'state', state: 'closed' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());

    const again = new FakeClient();
    await attachVoiceClient(again as never, 'session-1');
    expect(types(again)).not.toContain('VOICE_SESSION_BUSY');
    again.close();
  });

  // 2026-07-30 真机：模型 end_call 正常挂断 2 秒后 renderer 自动重连出一通新电话
  // （16 秒空通话、通话条不落、计时继续走）。根因是 host 主动结束与网络抖动关的 WS
  // 长得一模一样。这里逐条钉 host 侧终态出口——漏掉任何一条都会原样复发。
  it('host 侧终态关闭一律带终止 close code（renderer 据此不进重连宽限窗）', async () => {
    // ① teardown（model-end-call / watchdog / 上游死 / client-end 共用这一个出口）
    const call = new FakeClient();
    await attachVoiceClient(call as never, 'session-1');
    lastOnEvent?.({ type: 'error', code: 'UPSTREAM_ERROR', message: '上游炸了' });
    await vi.waitFor(() => expect(call.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL), { timeout: 4000 });

    // ② 会话互斥抢占
    const holder = new FakeClient();
    await attachVoiceClient(holder as never, 'session-1');
    const rejected = new FakeClient();
    await attachVoiceClient(rejected as never, 'session-2');
    expect(rejected.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL);
    await endActiveVoiceSession();

    // ③ 上游建连失败
    connect.mockRejectedValueOnce(new Error('handshake refused'));
    const upstreamDead = new FakeClient();
    await attachVoiceClient(upstreamDead as never, 'session-1');
    expect(upstreamDead.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL);

    // ④ 缺 provider key
    dashscopeKey.value = '';
    const unconfigured = new FakeClient();
    await attachVoiceClient(unconfigured as never, 'session-1');
    expect(unconfigured.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL);
    dashscopeKey.value = 'test-key';
  }, 15_000);

  it('二进制帧转发到上游，文本帧不当音频转发', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'interrupt' })), false);

    expect(sendAudio).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('commit 控制帧转发到 relay handle（PTT 手动提交路径）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'commit' })), false);

    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(sendAudio).not.toHaveBeenCalled();
    client.close();
  });

  it('语音来源只认 metadata.source，不认 message id 前缀', () => {
    const message: Message = {
      id: 'plain-message-id',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      metadata: { source: 'voice' },
    };

    expect(isVoiceInputMessage(message)).toBe(true);
  });

  it('final 字幕落库写入 metadata.source=voice', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    lastOnEvent?.({ type: 'user.transcript', text: '  你好  ', done: true });

    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalled());
    const [, message] = addMessageToSession.mock.calls[0];
    expect(message.content).toBe('你好');
    expect(message.metadata?.source).toBe('voice');

    client.close();
  });

  // 2026-07-26 真机：12s 通话挂断后落库只剩摘要——final 常在挂断后才到，
  // 立刻关上游等于把说过的话全丢。判据：未 done 的助手增量在挂断后必须落库。
  it('挂断时把未 done 的助手增量字幕冲成 final 落库（排水窗兜底）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    lastOnEvent?.({ type: 'assistant.transcript', text: '正在', done: false });
    lastOnEvent?.({ type: 'assistant.transcript', text: '创建文件。', done: false });

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);

    await vi.waitFor(() => {
      expect(addMessageToSession.mock.calls.some(
        ([, message]) => message.role === 'assistant' && message.content === '正在创建文件。',
      )).toBe(true);
    }, { timeout: 4000 });
  }, 10_000);

  it('挂断后写入 voiceCallSummary，durationSec 来自真实起止时间', async () => {
    const startedAt = 1_800_000_000_000;
    const endedAt = startedAt + 75_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    // 这通电话得真说过话，否则按 A3 根本不该落摘要卡
    lastOnEvent?.({ type: 'user.transcript', text: '你好', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalled());
    nowSpy.mockReturnValue(endedAt);

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);

    await vi.waitFor(() => {
      expect(addMessageToSession.mock.calls.some(([, message]) => Boolean(message.metadata?.voiceCallSummary))).toBe(true);
    }, { timeout: 4000 });
    const summaryCall = addMessageToSession.mock.calls.find(([, message]) => Boolean(message.metadata?.voiceCallSummary));
    if (!summaryCall) throw new Error('missing voiceCallSummary message');
    const [, summaryMessage] = summaryCall;
    expect(summaryMessage.role).toBe('system');
    expect(summaryMessage.metadata?.source).toBe('voice');
    expect(summaryMessage.metadata?.voiceCallSummary).toMatchObject({
      durationSec: 75,
      provider: 'qwen-omni',
      conversationModel: QWEN_OMNI_REALTIME_MODEL,
      workItemCount: 0,
      startedAt,
      endedAt,
    });
    expect(summaryMessage.content).toBe('语音通话结束，时长 1 分 15 秒');
    nowSpy.mockRestore();
  });

});

describe('终态结论节制播报', () => {
  const narration = {
    workItemId: 'work-1',
    status: 'done' as const,
    title: '建个文件',
    summary: '已经建好 a.txt。',
  };

  beforeEach(() => {
    injectItem.mockClear();
    voiceLogger.info.mockClear();
    voiceDispatchProbe.narrate = null;
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('用户说话时零注入，response.done 后恰好注入一条原结论', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-narration');

    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(narration);
    expect(injectItem).not.toHaveBeenCalled();

    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem).toHaveBeenCalledWith('[BACKEND] 「建个文件」做完了。已经建好 a.txt。');
  });

  it('模型响应窗内零注入，response.done 后才注入', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-model-response');

    upstreamResponding = true;
    voiceDispatchProbe.narrate?.(narration);
    expect(injectItem).not.toHaveBeenCalled();

    upstreamResponding = false;
    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(1);
  });

  it('两条结论排队时每个 response.done 只放一条', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-one-per-response');
    upstreamResponding = true;

    voiceDispatchProbe.narrate?.(narration);
    voiceDispatchProbe.narrate?.({ ...narration, workItemId: 'work-2', title: '查个问题' });
    upstreamResponding = false;

    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem).toHaveBeenLastCalledWith('[BACKEND] 「建个文件」做完了。已经建好 a.txt。');

    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(2);
    expect(injectItem).toHaveBeenLastCalledWith('[BACKEND] 「查个问题」做完了。已经建好 a.txt。');
  });

  it('注入拒绝后退回队列只重试一次，第二次拒绝只留屏幕且通话不死', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-injection-retry');

    voiceDispatchProbe.narrate?.(narration);
    expect(injectItem).toHaveBeenCalledTimes(1);

    lastOnEvent?.({ type: 'injection.rejected', message: 'Conversation already has an active response' });
    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(injectItem).toHaveBeenCalledTimes(1);

    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(2);

    lastOnEvent?.({ type: 'injection.rejected', message: 'still busy' });
    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(2);
    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(voiceLogger.warn).toHaveBeenCalledWith(
      'narration injection dropped after retry',
      expect.objectContaining({ workItemId: narration.workItemId }),
    );
  });

  it('注入确认窗内连接真的 close 仍按致命错误释放通话', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-close-during-injection');
    voiceDispatchProbe.narrate?.(narration);

    lastOnEvent?.({ type: 'state', state: 'closed' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
  });

  it('连续压过两个用户轮次就丢弃，并留下可诊断日志', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-stale-narration');

    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(narration);
    lastOnEvent?.({ type: 'speech.started' });
    lastOnEvent?.({ type: 'response.done' });

    expect(injectItem).not.toHaveBeenCalled();
    expect(voiceLogger.info).toHaveBeenCalledWith(
      'narration dropped after two suppressed user turns',
      expect.objectContaining({ workItemId: narration.workItemId }),
    );
  });

  it('同一 workItemId 的终态重复到达也只注入一条', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-dedup-narration');

    voiceDispatchProbe.narrate?.(narration);
    voiceDispatchProbe.narrate?.({ ...narration, summary: '重复终态不该覆盖。' });

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem).toHaveBeenCalledWith('[BACKEND] 「建个文件」做完了。已经建好 a.txt。');
  });

  it('挂断清掉仍在队列里的 narration，后到 response.done 也不注入', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup-narration');
    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(narration);

    await endActiveVoiceSession();
    lastOnEvent?.({ type: 'response.done' });

    expect(injectItem).not.toHaveBeenCalled();
  });
});

describe('失败告知出口', () => {
  beforeEach(() => {
    addMessageToSession.mockClear();
    voiceDispatchProbe.fail = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('未知异常只进 notice/detail 与落库 metadata，不进入主文案', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-failure-copy');
    const raw = 'Project Source trust identity changed: /Users/foo/secret/repo';

    voiceDispatchProbe.fail?.({
      id: 'failed-work',
      title: '建个文件',
      status: 'failed',
      detail: raw,
    });

    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalled());
    const notice = client.sent
      .filter((entry) => entry !== '<binary>')
      .map((entry) => JSON.parse(entry) as VoiceEvent)
      .find((event) => event.type === 'notice' && event.code === 'VOICE_WORK_FAILED');
    expect(notice).toMatchObject({
      type: 'notice',
      code: 'VOICE_WORK_FAILED',
      message: '执行时出了问题，没有完成',
      detail: raw,
    });
    if (notice?.type === 'notice') expect(notice.message).not.toContain(raw);

    const persisted = addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message.metadata?.voiceWorkFailure);
    expect(persisted?.content).not.toContain(raw);
    expect(persisted?.metadata?.voiceWorkFailure?.detail).toBe(raw);
  });
});

// ============================================================================
// A3 · 空对话不落摘要卡（2026-07-30）。那通 16 秒空通话在消息流里留下一张
// 「这通电话没有对话内容」——记录零内容的事不是记录，是噪音。
// ============================================================================
describe('空对话不出通话摘要卡（A3）', () => {
  beforeEach(() => {
    connect.mockClear();
    addMessageToSession.mockClear();
    voiceDispatchProbe.work = null;
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  function summaries(): Message[] {
    return addMessageToSession.mock.calls
      .map(([, message]) => message)
      .filter((message) => Boolean(message.metadata?.voiceCallSummary));
  }

  it('零字幕通话挂断：不落摘要卡', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-empty');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    // 等 teardown 真走过落卡那一步再断言：active 在排水窗**之前**就置空了，
    // 拿它当路标会在摘要写入前就判「没落卡」（假绿）。upstream.close() 在落卡之后。
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });

    expect(summaries()).toHaveLength(0);
  }, 10_000);

  it('有字幕就照落，且 transcriptCount 数得对', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-with-transcript');
    lastOnEvent?.({ type: 'user.transcript', text: '帮我看一下这个文件', done: true });
    lastOnEvent?.({ type: 'assistant.transcript', text: '好的，我看看。', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(2));

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(summaries()).toHaveLength(1), { timeout: 4000 });

    expect(summaries()[0].metadata?.voiceCallSummary).toMatchObject({ transcriptCount: 2 });
  }, 10_000);

  // 理论上派活必有字幕，但真出现「零字幕却派过活」时保守落卡：工作项就是那通电话的产物。
  it('零字幕但派过活：仍落摘要卡', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-work-only');
    voiceDispatchProbe.work?.({ id: 'work-1', title: '建个文件', status: 'queued' });

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(summaries()).toHaveLength(1), { timeout: 4000 });

    expect(summaries()[0].metadata?.voiceCallSummary).toMatchObject({ transcriptCount: 0, workItemCount: 1 });
  }, 10_000);
});

// ============================================================================
// A1 · 挂断确定性闸（2026-07-30）。模型答「好的，通话结束」却不调 end_call 已四次
// 复现、prompt 三连败——判据必须打在「电话真挂了」，不是「匹配器返回 true」。
// ============================================================================
describe('挂断确定性闸（A1）', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('用户 final 字幕命中挂断词：等这一轮说完才挂，且带终止 close code', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup');

    lastOnEvent?.({ type: 'user.transcript', text: '好了，挂断吧', done: true });
    // 告别还没说完，不许当场掐掉
    expect(getActiveVoiceSessionId()).not.toBeNull();

    lastOnEvent?.({ type: 'response.done' });

    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull(), { timeout: 4000 });
    await vi.waitFor(() => expect(client.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL), { timeout: 4000 });
    expect(close).toHaveBeenCalled();
  }, 10_000);

  it('否定式不触发：「别挂断」之后 response.done 也不挂', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup-negated');

    lastOnEvent?.({ type: 'user.transcript', text: '先别挂断', done: true });
    lastOnEvent?.({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('assistant 说同一个词不触发（闸只看用户说的话）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup-assistant');

    lastOnEvent?.({ type: 'assistant.transcript', text: '好的，通话结束，拜拜', done: true });
    lastOnEvent?.({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('未 done 的用户字幕不触发（说了一半的话不算数）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup-partial');

    lastOnEvent?.({ type: 'user.transcript', text: '挂断', done: false });
    lastOnEvent?.({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).not.toBeNull();
  });
});

// D4 的生产者接线：钳制函数写得再对，没人置位就是「建好不接电」。
// 这一条钉的是 attachVoiceClient/teardown 真的动了通话态标记。
describe('通话态标记（D4 生产者）', () => {
  it('建连即标记，挂断即解除', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const manager = getPermissionModeManager();
    expect(manager.isLiveVoiceSession('session-live')).toBe(false);

    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-live');
    expect(manager.isLiveVoiceSession('session-live')).toBe(true);

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull(), { timeout: 4000 });
    expect(manager.isLiveVoiceSession('session-live')).toBe(false);
  });
});

// ============================================================================
// 批 H · 断线重连 sticky。
// 关键契约：客户端断开**不等于**挂断——网络抖一下不该在消息流里落一张「通话结束」卡，
// 然后重连变成第二通电话。宽限窗内重新 attach = 同一通电话继续（同一条上游）。
// ============================================================================
describe('断线重连 sticky（批 H）', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    addMessageToSession.mockClear();
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('客户端断开先进宽限窗：不挂上游、不落摘要卡', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    const sessionId = getActiveVoiceSessionId();

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).toBe(sessionId);
    expect(close).not.toHaveBeenCalled();
    expect(addMessageToSession.mock.calls.some(([, m]) => Boolean(m.metadata?.voiceCallSummary))).toBe(false);
  });

  it('宽限窗内重连接回同一通电话：不建第二条上游', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    const sessionId = getActiveVoiceSessionId();
    client.close();

    const revived = new FakeClient();
    await attachVoiceClient(revived as never, 'session-1');

    expect(getActiveVoiceSessionId()).toBe(sessionId);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(types(revived)).not.toContain('VOICE_SESSION_BUSY');
    // 告诉 Renderer 接回来了，它据此保留 work items / 通话计时
    expect(types(revived)).toContain('state');
  });

  it('重连后上游事件发到新 socket（回调不能闭包捕获旧的那条）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    client.close();
    const revived = new FakeClient();
    await attachVoiceClient(revived as never, 'session-1');
    const before = revived.sent.length;

    lastOnEvent?.({ type: 'user.transcript', text: '还在吗', done: false });

    expect(revived.sent.length).toBeGreaterThan(before);
  });

  it('重连后二进制帧仍转发到上游（新 socket 的 handler 真绑上了）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    client.close();
    const revived = new FakeClient();
    await attachVoiceClient(revived as never, 'session-1');
    sendAudio.mockClear();

    revived.emit('message', Buffer.from([1, 2, 3, 4]), true);

    expect(sendAudio).toHaveBeenCalledTimes(1);
  });

  it('别的会话在宽限窗里拨进来仍被互斥挡住（宽限只认同一条会话）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    client.close();

    const other = new FakeClient();
    await attachVoiceClient(other as never, 'session-2');

    expect(types(other)).toContain('VOICE_SESSION_BUSY');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('用户显式挂断不进宽限窗（他不是断线，是不想打了）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);

    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull(), { timeout: 4000 });
  }, 10_000);
});

// ============================================================================
// 批 H · Context 注入（§6.5）。判据是「上游真收到了刷新」，不是「host 存下了焦点」——
// 存下但没人推给模型，正是本仓反复踩的「建好不接电」。
// ============================================================================
describe('焦点上报刷新 instructions（批 H）', () => {
  beforeEach(() => {
    updateInstructions.mockClear();
    connect.mockClear();
    vocabulary.block = '';
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('初始 session.update 带上非空口述词表', async () => {
    vocabulary.block = '[口述词表]\n- a.txt';
    const client = new FakeClient();

    await attachVoiceClient(client as never, 'session-1');

    expect(connect.mock.calls[0][0].config.instructions).toContain('[口述词表]');
    expect(connect.mock.calls[0][0].config.instructions).toContain('- a.txt');
  });

  it('空词表不污染初始 instructions', async () => {
    const client = new FakeClient();

    await attachVoiceClient(client as never, 'session-1');

    expect(connect.mock.calls[0][0].config.instructions).not.toContain('口述词表');
  });

  it('焦点变化推一次 session.update，且内容里带得上文件路径', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({
      type: 'focus',
      context: { view: 'preview:/repo/a.ts', filePath: '/repo/a.ts' },
    })), false);

    expect(updateInstructions).toHaveBeenCalledTimes(1);
    expect(updateInstructions.mock.calls[0][0]).toContain('/repo/a.ts');
  });

  it('焦点增量 session.update 同样带上口述词表', async () => {
    vocabulary.block = '[口述词表]\n- a.txt';
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({
      type: 'focus',
      context: { filePath: '/repo/a.ts' },
    })), false);

    expect(updateInstructions).toHaveBeenCalledTimes(1);
    expect(updateInstructions.mock.calls[0][0]).toContain('[口述词表]');
    expect(updateInstructions.mock.calls[0][0]).toContain('- a.txt');
  });

  it('同一份焦点重复上报不再推（上游每次刷新都有代价）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    const focus = Buffer.from(JSON.stringify({ type: 'focus', context: { filePath: '/repo/a.ts' } }));

    client.emit('message', focus, false);
    client.emit('message', focus, false);

    expect(updateInstructions).toHaveBeenCalledTimes(1);
  });

  it('刷新后的 instructions 仍带着通话身份的人设（别把人设冲掉）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({
      type: 'focus', context: { filePath: '/repo/a.ts' },
    })), false);

    expect(updateInstructions.mock.calls[0][0]).toContain('spawn_task');
  });
});

// ============================================================================
// 通话生命周期 hook（observer-only）：暂停/结束要让 agent 侧可编排——
// 典型用例是会议形态通话结束后问一句「要我整理一下吗」。
// 判据钉在「事件真发出去了且数字对得上」，不是「函数存在」。
// ============================================================================
describe('通话生命周期 hook', () => {
  beforeEach(() => {
    triggerVoiceCall.mockClear();
    temporaryTriggerVoiceCall.mockClear();
    initializeTemporaryHookManager.mockClear();
    hasTemporaryVoiceCallHook.mockClear();
    getSession.mockClear();
    hasExistingOrchestrator = true;
    connect.mockClear();
    addMessageToSession.mockClear();
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  function eventsOf(name: string): VoiceCallHookParams[] {
    return triggerVoiceCall.mock.calls.filter(([event]) => event === name).map(([, params]) => params);
  }

  it('建连发一次 VoiceCallStarted', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hook');

    await vi.waitFor(() => expect(eventsOf('VoiceCallStarted')).toHaveLength(1));
    const [params] = eventsOf('VoiceCallStarted');
    expect(params).toMatchObject({ sessionId: 'session-hook', durationSec: 0 });
    expect(typeof params.voiceCallId).toBe('string');
  });

  it('没有 orchestrator 的纯语音会话仍通过临时 hook manager 送达 VoiceCallStarted', async () => {
    hasExistingOrchestrator = false;
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hook-fallback');

    await vi.waitFor(() => expect(temporaryTriggerVoiceCall).toHaveBeenCalledWith(
      'VoiceCallStarted',
      expect.objectContaining({ sessionId: 'session-hook-fallback', durationSec: 0 }),
    ));
    expect(getSession).toHaveBeenCalledWith('session-hook-fallback', 1);
    expect(initializeTemporaryHookManager).toHaveBeenCalledOnce();
    expect(hasTemporaryVoiceCallHook).toHaveBeenCalledWith('VoiceCallStarted');
  });

  it('挂断发 VoiceCallEnded，时长与摘要卡同一个数（别各算各的）', async () => {
    const startedAt = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hook');
    lastOnEvent?.({ type: 'user.transcript', text: '你好', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalled());
    nowSpy.mockReturnValue(startedAt + 75_000);

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);

    await vi.waitFor(() => expect(eventsOf('VoiceCallEnded')).toHaveLength(1), { timeout: 4000 });
    const [params] = eventsOf('VoiceCallEnded');
    const summaryCall = addMessageToSession.mock.calls.find(([, m]) => Boolean(m.metadata?.voiceCallSummary));
    if (!summaryCall) throw new Error('missing voiceCallSummary message');
    const summary = summaryCall[1].metadata?.voiceCallSummary as { durationSec: number };
    expect(params.durationSec).toBe(summary.durationSec);
    expect(params).toMatchObject({ sessionId: 'session-hook', workItemCount: 0, reason: 'client-end' });
    nowSpy.mockRestore();
  }, 10_000);

  it('客户端断开发 Paused；宽限窗内接回来不再发第二次 Started（网络抖动 ≠ 新一通电话）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hook');
    await vi.waitFor(() => expect(eventsOf('VoiceCallStarted')).toHaveLength(1));

    client.close();
    await vi.waitFor(() => expect(eventsOf('VoiceCallPaused')).toHaveLength(1));

    const revived = new FakeClient();
    await attachVoiceClient(revived as never, 'session-hook');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(eventsOf('VoiceCallStarted')).toHaveLength(1);
    expect(eventsOf('VoiceCallEnded')).toHaveLength(0);
  });
});

// 侧栏那个语音图标靠会话 metadata 驱动。渲染侧的门只证明「有标记就会亮」，
// 证不了「真有人写这个标记」——本仓「建好不接电」就是这么发生的。
describe('实时语音会话标记（生产者接线）', () => {
  beforeEach(() => {
    patchSessionMetadata.mockClear();
    connect.mockClear();
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('建连即把 hadLiveVoice 写进会话 metadata', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-badge');

    await vi.waitFor(() => expect(patchSessionMetadata).toHaveBeenCalledWith('session-badge', { hadLiveVoice: true }));
  });
});
