// 全局单路互斥与挂断释放（方案 §2.6 / Phase 0 出口「验证互斥与挂断」）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { isVoiceInputMessage, type Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport, VoiceWorkItem } from '../../src/shared/contract/voice';
import { QWEN_OMNI_REALTIME_MODEL, VOICE_DOWNSTREAM_SAMPLE_RATE, VOICE_END_CALL_GOODBYE_TIMEOUT_MS, VOICE_HANGUP_REACTION_WINDOW_MS, VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS, VOICE_TRANSCRIPT_MERGE_WINDOW_MS, VOICE_WS_CLOSE_TERMINAL, VOICE_MILESTONE_FIRST_DELAY_MS, VOICE_MILESTONE_MAX_PER_WORK_ITEM, VOICE_MILESTONE_MIN_INTERVAL_MS, VOICE_MILESTONE_STALE_MS } from '../../src/shared/constants/voice';

const vocabulary = vi.hoisted(() => ({ block: '' }));
vi.mock('../../src/host/services/voice/voiceVocabulary', () => ({
  buildVocabularyBlock: () => vocabulary.block,
}));

const close = vi.fn(async () => undefined);
const sendAudio = vi.fn();
const commitMock = vi.fn();
const respondMock = vi.fn();
const updateInstructions = vi.fn();
const injectItem = vi.fn();
const injectItemWithAck = vi.fn(async (_text: string) => undefined);
let upstreamResponding = false;
const isResponding = vi.fn(() => upstreamResponding);
let interruptResponseId: string | null = null;
const interruptMock = vi.fn(() => {
  upstreamResponding = false;
  return interruptResponseId;
});
const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
const patchSessionMetadata = vi.fn(async (_sessionId: string, _patch: Record<string, unknown>) => true);
const getSession = vi.fn(async (_sessionId: string) => ({ workingDirectory: '/repo/voice-session' }));
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
let lastOnAudio: ((frame: Buffer) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  lastOnAudio = input.onAudio;
  return {
    kind: 'relay',
    provider: 'qwen-omni',
    sendAudio,
    commit: commitMock,
    respond: respondMock,
    interrupt: interruptMock,
    updateInstructions,
    injectItem,
    injectItemWithAck,
    isResponding,
    close,
  };
});

vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({ qwenOmniTransport: { id: 'qwen-omni', connect } }));
const dashscopeKey = vi.hoisted(() => ({ value: 'test-key' }));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => dashscopeKey.value }));
const updateMessage = vi.fn(async (_messageId: string, _updates: Partial<Message>) => undefined);
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  // getSessionMetadata：建连时读 teamLead 用（语音批 B）。这些用例不是团会话，给 undefined。
  getSessionManager: () => ({ addMessageToSession, patchSessionMetadata, getSession, updateMessage, getSessionMetadata: () => undefined }),
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
    status: 'done' | 'milestone';
    title: string;
    summary: string;
    worthHearing?: true;
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

const { attachVoiceClient, getActiveVoiceSessionId, endActiveVoiceSession, injectVoiceUserText } = await import('../../src/host/services/voice/voiceSessionService');

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

function ackNarration(client: FakeClient, narrationId: string): void {
  client.emit('message', Buffer.from(JSON.stringify({
    type: 'narration.playback_started',
    narrationId,
  })), false);
}

describe('voiceSessionService 互斥与挂断', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    sendAudio.mockClear();
    commitMock.mockClear();
    respondMock.mockClear();
    updateInstructions.mockClear();
    injectItem.mockClear();
    injectItemWithAck.mockClear();
    injectItemWithAck.mockImplementation(async (_text: string) => undefined);
    isResponding.mockClear();
    interruptMock.mockClear();
    interruptResponseId = null;
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
      return {
        kind: 'relay',
        provider: 'qwen-omni',
        sendAudio,
        commit: commitMock,
        respond: respondMock,
        interrupt: vi.fn(),
        injectItem,
        injectItemWithAck,
        isResponding,
        updateInstructions,
        close,
      };
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

  it('空闲结束按正常终态释放通话并保留结构化原因', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();

    lastOnEvent?.({ type: 'session.ended', reason: 'idle-timeout' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });

    const events = client.sent
      .filter((entry) => entry !== '<binary>')
      .map((entry) => JSON.parse(entry) as VoiceEvent);
    expect(events).toContainEqual({ type: 'session.ended', reason: 'idle-timeout' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(voiceLogger.info).toHaveBeenCalledWith(
      'session ended',
      expect.objectContaining({ reason: 'idle-timeout' }),
    );
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
    expect(addMessageToSession.mock.calls
      .map(([, message]) => message.metadata?.voiceCallFailure)
      .find((failure) => failure?.code === 'UPSTREAM_ERROR')).toMatchObject({
      code: 'UPSTREAM_ERROR',
      phase: 'upstream',
      neoSessionId: 'session-1',
    });

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
    await vi.waitFor(() => expect(addMessageToSession.mock.calls
      .some(([, message]) => message.metadata?.voiceCallFailure?.code === 'VOICE_UPSTREAM_UNAVAILABLE')).toBe(true));

    // ④ 缺 provider key
    dashscopeKey.value = '';
    const unconfigured = new FakeClient();
    await attachVoiceClient(unconfigured as never, 'session-1');
    expect(unconfigured.closeCode).toBe(VOICE_WS_CLOSE_TERMINAL);
    await vi.waitFor(() => expect(addMessageToSession.mock.calls
      .some(([, message]) => message.metadata?.voiceCallFailure?.code === 'VOICE_PROVIDER_UNCONFIGURED')).toBe(true));
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

  it('relay live 后 8 秒仍无上行帧就留 warn，首帧到达则撤销', async () => {
    vi.useFakeTimers();
    try {
      const silent = new FakeClient();
      await attachVoiceClient(silent as never, 'session-silent-audio');
      await vi.advanceTimersByTimeAsync(VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS);
      expect(voiceLogger.warn).toHaveBeenCalledWith('client audio missing after session start', expect.objectContaining({
        waitedMs: VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS,
      }));
      const endingSilentCall = endActiveVoiceSession();
      await vi.advanceTimersByTimeAsync(2_000);
      await endingSilentCall;

      voiceLogger.warn.mockClear();
      const healthy = new FakeClient();
      await attachVoiceClient(healthy as never, 'session-healthy-audio');
      healthy.emit('message', Buffer.from([1, 0, 2, 0]), true);
      await vi.advanceTimersByTimeAsync(VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS + 1);
      expect(voiceLogger.warn).not.toHaveBeenCalledWith(
        'client audio missing after session start',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('AEC sidecar 诊断码经媒体 WS 落 host 结构化日志', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-aec-diagnostic');

    client.emit('message', Buffer.from(JSON.stringify({
      type: 'audio_diagnostic',
      code: 'configuration-recovered',
    })), false);

    expect(voiceLogger.info).toHaveBeenCalledWith('client audio diagnostic', expect.objectContaining({
      code: 'configuration-recovered',
    }));
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

  it('真打断期间保留用户 final，只创建一次新回复，取消旧 assistant 不落库', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-interrupt');
    interruptResponseId = 'resp-old';
    upstreamResponding = true;

    lastOnEvent?.({ type: 'response.created', responseId: 'resp-old' });
    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-old',
      itemId: 'item-old',
      text: '旧回答开头',
      done: false,
    });
    lastOnEvent?.({ type: 'speech.started', candidateId: 'turn-2' });
    client.emit('message', Buffer.from(JSON.stringify({
      type: 'interrupt.playback',
      candidateId: 'turn-2',
      playing: true,
      playedMs: 600,
      queuedMs: 1600,
    })), false);
    lastOnEvent?.({ type: 'user.transcript', itemId: 'user-2', text: '等一下', done: false });

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(client.sent.map((raw) => raw === '<binary>' ? null : JSON.parse(raw)).filter(Boolean)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'response.cancelled', responseId: 'resp-old' }),
        expect.objectContaining({ type: 'interrupt.decision', action: 'cancel_discard', responseId: 'resp-old' }),
      ]),
    );

    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-old',
      itemId: 'item-old',
      text: '旧回答完整 final',
      done: true,
    });
    lastOnEvent?.({ type: 'response.done', responseId: 'resp-old' });
    lastOnEvent?.({
      type: 'user.transcript',
      itemId: 'user-2',
      text: '等一下，改成从十倒数到一',
      done: true,
    });

    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(respondMock).toHaveBeenCalledWith(expect.stringContaining('等一下，改成从十倒数到一'));

    lastOnEvent?.({ type: 'response.created', responseId: 'resp-new' });
    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-new',
      itemId: 'item-new',
      text: '十、九、八、七、六、五、四、三、二、一',
      done: true,
    });
    lastOnEvent?.({ type: 'response.done', responseId: 'resp-new' });

    await vi.waitFor(() => {
      const transcripts = addMessageToSession.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.role === 'user' || message.role === 'assistant');
      expect(transcripts).toHaveLength(2);
    });
    const transcripts = addMessageToSession.mock.calls
      .map(([, message]) => message)
      .filter((message) => message.role === 'user' || message.role === 'assistant');
    expect(transcripts.map((message) => [message.role, message.content])).toEqual([
      ['user', '等一下，改成从十倒数到一'],
      ['assistant', '十、九、八、七、六、五、四、三、二、一'],
    ]);
    expect(transcripts[1].metadata?.voiceTranscript).toEqual({
      responseId: 'resp-new',
      itemId: 'item-new',
    });
    expect(transcripts.some((message) => message.content.includes('旧回答'))).toBe(false);
  });

  it('附和 final 恢复播放，不取消、不建回复、不落用户消息', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-ack');
    upstreamResponding = true;

    lastOnEvent?.({ type: 'response.created', responseId: 'resp-playing' });
    lastOnEvent?.({ type: 'speech.started', candidateId: 'turn-ack' });
    client.emit('message', Buffer.from(JSON.stringify({
      type: 'interrupt.playback',
      candidateId: 'turn-ack',
      playing: true,
      playedMs: 500,
      queuedMs: 1500,
    })), false);
    lastOnEvent?.({
      type: 'user.transcript',
      itemId: 'user-ack',
      text: '好的，知道了。',
      done: true,
    });

    expect(interruptMock).not.toHaveBeenCalled();
    expect(respondMock).not.toHaveBeenCalled();
    expect(addMessageToSession).not.toHaveBeenCalled();
    expect(client.sent.map((raw) => raw === '<binary>' ? null : JSON.parse(raw)).filter(Boolean)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'interrupt.decision',
          classification: 'acknowledgement',
          action: 'resume',
        }),
      ]),
    );
  });

  it('1.2 秒宽限到点不把空文本定成 background，迟到 final 仍下发并落库', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-late-user-final');
      upstreamResponding = true;
      interruptResponseId = 'resp-late-user-final';
      lastOnEvent?.({ type: 'response.created', responseId: 'resp-late-user-final' });
      lastOnEvent?.({ type: 'speech.started', candidateId: 'turn-late-user-final' });
      client.emit('message', Buffer.from(JSON.stringify({
        type: 'interrupt.playback',
        candidateId: 'turn-late-user-final',
        playing: true,
        playedMs: 600,
        queuedMs: 900,
      })), false);
      lastOnEvent?.({
        type: 'speech.stopped',
        candidateId: 'turn-late-user-final',
        durationMs: 900,
      });

      const interruptDecisions = () => client.sent
        .filter((raw) => raw !== '<binary>')
        .map((raw) => JSON.parse(raw) as VoiceEvent)
        .filter((event) => event.type === 'interrupt.decision');

      await vi.advanceTimersByTimeAsync(1_199);
      expect(interruptDecisions()).toHaveLength(0);
      expect(addMessageToSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(interruptDecisions()).toHaveLength(0);
      expect(addMessageToSession).not.toHaveBeenCalled();

      lastOnEvent?.({
        type: 'user.transcript',
        itemId: 'user-late-user-final',
        candidateId: 'turn-late-user-final',
        text: '请改成从一数到三',
        done: true,
      });
      await vi.advanceTimersByTimeAsync(0);

      const events = client.sent
        .filter((raw) => raw !== '<binary>')
        .map((raw) => JSON.parse(raw) as VoiceEvent);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'user.transcript',
          itemId: 'user-late-user-final',
          text: '请改成从一数到三',
          done: true,
        }),
      ]));
      expect(addMessageToSession.mock.calls.some(([, message]) => (
        message.role === 'user' && message.content === '请改成从一数到三'
      ))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上一段 final 晚到且下一段已完成附和时，按 itemId 保留上一段字幕', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-late-previous-candidate');
      upstreamResponding = true;
      interruptResponseId = 'resp-late-previous-candidate';
      lastOnEvent?.({ type: 'response.created', responseId: 'resp-late-previous-candidate' });

      lastOnEvent?.({ type: 'speech.started', candidateId: 'candidate-a' });
      lastOnEvent?.({
        type: 'user.transcript',
        candidateId: 'candidate-a',
        itemId: 'item-a',
        text: '上一段还在转写',
        done: false,
      });
      lastOnEvent?.({ type: 'speech.stopped', candidateId: 'candidate-a', durationMs: 900 });

      const interruptDecisions = () => client.sent
        .filter((raw) => raw !== '<binary>')
        .map((raw) => JSON.parse(raw) as VoiceEvent)
        .filter((event) => event.type === 'interrupt.decision');

      await vi.advanceTimersByTimeAsync(1_199);
      expect(interruptDecisions()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(interruptDecisions()).toHaveLength(0);

      lastOnEvent?.({ type: 'speech.started', candidateId: 'candidate-b' });
      client.emit('message', Buffer.from(JSON.stringify({
        type: 'interrupt.playback',
        candidateId: 'candidate-b',
        playing: true,
        playedMs: 400,
        queuedMs: 800,
      })), false);
      lastOnEvent?.({
        type: 'user.transcript',
        candidateId: 'candidate-b',
        itemId: 'item-b',
        text: '好的，知道了',
        done: true,
      });

      lastOnEvent?.({
        type: 'user.transcript',
        itemId: 'item-a',
        text: '上一段改成从一数到三',
        done: true,
      });
      await vi.advanceTimersByTimeAsync(0);

      const events = client.sent
        .filter((raw) => raw !== '<binary>')
        .map((raw) => JSON.parse(raw) as VoiceEvent);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'interrupt.decision',
          candidateId: 'candidate-a',
          classification: 'true_interrupt',
        }),
        expect.objectContaining({
          type: 'user.transcript',
          itemId: 'item-a',
          text: '上一段改成从一数到三',
          done: true,
        }),
      ]));
      expect(addMessageToSession.mock.calls.some(([, message]) => (
        message.role === 'user' && message.content === '上一段改成从一数到三'
      ))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('空文本宽限兜底即使误产出终局分类，也不能抑制迟到 final 落库', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-empty-fallback-guard');
      upstreamResponding = true;
      interruptResponseId = 'resp-empty-fallback-guard';
      lastOnEvent?.({ type: 'response.created', responseId: 'resp-empty-fallback-guard' });
      lastOnEvent?.({ type: 'speech.started', candidateId: 'candidate-empty-fallback' });
      client.emit('message', Buffer.from(JSON.stringify({
        type: 'interrupt.playback',
        candidateId: 'candidate-empty-fallback',
        playing: true,
        playedMs: 600,
        queuedMs: 900,
      })), false);
      lastOnEvent?.({
        type: 'speech.stopped',
        candidateId: 'candidate-empty-fallback',
        durationMs: 900,
      });

      await vi.advanceTimersByTimeAsync(1_199);
      expect(client.sent.filter((raw) => raw.includes('interrupt.decision'))).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.sent.filter((raw) => raw.includes('interrupt.decision'))).toHaveLength(0);

      lastOnEvent?.({
        type: 'user.transcript',
        candidateId: 'candidate-empty-fallback',
        itemId: 'item-empty-fallback',
        text: '好的，知道了',
        done: true,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sent).toContainEqual(expect.stringContaining('好的，知道了'));
      expect(addMessageToSession.mock.calls.some(([, message]) => (
        message.role === 'user' && message.content === '好的，知道了'
      ))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('通话中打字注入（E）', () => {
  beforeEach(() => {
    injectItem.mockClear();
    injectItemWithAck.mockClear();
    injectItemWithAck.mockImplementation(async (_text: string) => undefined);
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('把原话以 [USER] 前缀送进通话 brain，并等待注入确认', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-typed-input');

    const result = await injectVoiceUserText('session-typed-input', '别等了，改做 Y');

    expect(result).toEqual({ outcome: 'injected' });
    expect(injectItemWithAck).toHaveBeenCalledWith('[USER] 别等了，改做 Y');
    expect(injectItem).not.toHaveBeenCalled();
  });

  it('VOICE_TOOLS_DROPPED 时 fail-closed 回退，不把用户话静默吞掉', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-typed-tools-dropped');
    lastOnEvent?.({
      type: 'notice',
      code: 'VOICE_TOOLS_DROPPED',
      message: 'tools dropped',
    });

    const result = await injectVoiceUserText('session-typed-tools-dropped', '改做 Y');

    expect(result).toEqual({ outcome: 'fallback', reason: 'tools_unavailable' });
    expect(injectItemWithAck).not.toHaveBeenCalled();
  });

  it('上游拒绝注入时返回 fallback，让 renderer 把同一条话放回 durable queue', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-typed-rejected');
    injectItemWithAck.mockRejectedValueOnce(new Error('active response'));

    const result = await injectVoiceUserText('session-typed-rejected', '改做 Y');

    expect(result).toEqual({ outcome: 'fallback', reason: 'injection_rejected' });
    expect(injectItemWithAck).toHaveBeenCalledTimes(1);
  });

  it('挂断开始后拒绝新的注入，不启动第二个文本轮', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-typed-hangup');
    const ending = endActiveVoiceSession();

    const result = await injectVoiceUserText('session-typed-hangup', '改做 Y');

    expect(result).toEqual({ outcome: 'fallback', reason: 'no_active_call' });
    expect(injectItemWithAck).not.toHaveBeenCalled();
    await ending;
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
    expect(injectItem).toHaveBeenCalledWith(
      '[BACKEND] 「建个文件」做完了。已经建好 a.txt。',
      narration.workItemId,
    );
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
    expect(injectItem).toHaveBeenLastCalledWith(
      '[BACKEND] 「建个文件」做完了。已经建好 a.txt。',
      narration.workItemId,
    );

    client.emit('message', Buffer.from(JSON.stringify({
      type: 'narration.playback_started',
      narrationId: narration.workItemId,
    })), false);

    lastOnEvent?.({ type: 'response.done' });
    expect(injectItem).toHaveBeenCalledTimes(2);
    expect(injectItem).toHaveBeenLastCalledWith(
      '[BACKEND] 「查个问题」做完了。已经建好 a.txt。',
      'work-2',
    );
  });

  it('注入拒绝后按指数退避继续重试且通话不死', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-injection-retry');

    voiceDispatchProbe.narrate?.(narration);
    expect(injectItem).toHaveBeenCalledTimes(1);

    lastOnEvent?.({ type: 'injection.rejected', message: 'Conversation already has an active response' });
    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(injectItem).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(injectItem).toHaveBeenCalledTimes(2), { timeout: 1_000 });

    lastOnEvent?.({ type: 'injection.rejected', message: 'still busy' });
    await vi.waitFor(() => expect(injectItem).toHaveBeenCalledTimes(3), { timeout: 1_500 });
    expect(getActiveVoiceSessionId()).not.toBeNull();
  });

  it('注入确认窗内连接真的 close 仍按致命错误释放通话', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-close-during-injection');
    voiceDispatchProbe.narrate?.(narration);

    lastOnEvent?.({ type: 'state', state: 'closed' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
  });

  it('终态连续压过两个用户轮仍保留，轮末继续尝试送达', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-stale-narration');

    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(narration);
    lastOnEvent?.({ type: 'speech.started' });
    lastOnEvent?.({ type: 'response.done' });

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(voiceLogger.info).not.toHaveBeenCalledWith(
      'narration dropped',
      expect.objectContaining({ workItemId: narration.workItemId, reason: 'suppressed_two_turns' }),
    );
  });

  it('同一 workItemId 的终态重复到达也只注入一条', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-dedup-narration');

    voiceDispatchProbe.narrate?.(narration);
    voiceDispatchProbe.narrate?.({ ...narration, summary: '重复终态不该覆盖。' });

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem).toHaveBeenCalledWith(
      '[BACKEND] 「建个文件」做完了。已经建好 a.txt。',
      narration.workItemId,
    );
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
// R5 · 连续用户字幕并入上一条。VAD 把一句话切成几轮，消息流里就成了一串碎片。
// 合并是「落库后回头改上一条」，不是攒着晚点写——晚写会让近窗/挂断闸都晚看到。
// ============================================================================
describe('连续用户字幕合并（R5）', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    addMessageToSession.mockClear();
    updateMessage.mockClear();
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  function userMessages(): Message[] {
    return addMessageToSession.mock.calls.map(([, m]) => m).filter((m) => m.role === 'user');
  }

  it('2 秒内的第二条 final 并进上一条，不新增消息', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-merge');

    lastOnEvent?.({ type: 'user.transcript', text: '帮我看一下', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(1));
    lastOnEvent?.({ type: 'user.transcript', text: '这个文件', done: true });
    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));

    expect(userMessages()).toHaveLength(1);
    expect(updateMessage.mock.calls[0][1].content).toBe('帮我看一下 这个文件');
  });

  it('中间隔了 assistant 字幕就不合并（那是新的一轮）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-merge-turn');

    lastOnEvent?.({ type: 'user.transcript', text: '帮我看一下', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(1));
    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-merge-turn',
      itemId: 'item-merge-turn',
      text: '好的。',
      done: true,
    });
    lastOnEvent?.({ type: 'response.done', responseId: 'resp-merge-turn' });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(2));
    lastOnEvent?.({ type: 'user.transcript', text: '这个文件', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(3));

    expect(userMessages()).toHaveLength(2);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('超过合并窗就不合并', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-merge-window');
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      lastOnEvent?.({ type: 'user.transcript', text: '帮我看一下', done: true });
      await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(1));
      nowSpy.mockReturnValue(base + VOICE_TRANSCRIPT_MERGE_WINDOW_MS + 1);
      lastOnEvent?.({ type: 'user.transcript', text: '这个文件', done: true });
      await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(2));

      expect(userMessages()).toHaveLength(2);
      expect(updateMessage).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  // 护栏：合并动的是消息流，不许动挂断闸的判定顺序（R2 的反悔就吃这条顺序）。
  it('合并开着时 R2 反悔仍然成立，且挂断闸照常认挂断词', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-merge-hangup');

    lastOnEvent?.({ type: 'user.transcript', text: '先这样吧拜拜', done: true });
    // 等上一条真落库再说下一句：真机上两条 final 至少隔一个 VAD 静音窗，
    // 落库早就完成了；不等的话合并会退化成「各落各的」（安全，但测的就不是合并了）。
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(1));
    lastOnEvent?.({ type: 'speech.started' });
    lastOnEvent?.({ type: 'response.done' });
    expect(getActiveVoiceSessionId()).not.toBeNull();

    // 这一条会被并进上一条（<2s），但反悔判定必须照样生效
    lastOnEvent?.({ type: 'user.transcript', text: '不要挂断', done: true });
    lastOnEvent?.({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));
  });

  it('合并后 transcriptCount 只算一条（消息没多，计数也不该多）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-merge-count');

    lastOnEvent?.({ type: 'user.transcript', text: '帮我看一下', done: true });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalledTimes(1));
    lastOnEvent?.({ type: 'user.transcript', text: '这个文件', done: true });
    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => {
      expect(addMessageToSession.mock.calls.some(([, m]) => Boolean(m.metadata?.voiceCallSummary))).toBe(true);
    }, { timeout: 4000 });
    const summary = addMessageToSession.mock.calls.find(([, m]) => Boolean(m.metadata?.voiceCallSummary));
    expect(summary?.[1].metadata?.voiceCallSummary).toMatchObject({ transcriptCount: 1 });
  }, 10_000);
});

// ============================================================================
// R6 · 内部工具标签不当字幕（2026-07-30 真机：模型把 <end_call> 当话说了出来，
// 又上屏又落库）。标签是暗号不是话。
// ============================================================================
describe('纯工具标签字幕不上屏不落库（R6）', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    addMessageToSession.mockClear();
    lastOnEvent = null;
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  function assistantEvents(client: FakeClient): { text: string }[] {
    return client.sent
      .filter((entry) => entry !== '<binary>')
      .map((entry) => JSON.parse(entry) as VoiceEvent)
      .filter((event): event is Extract<VoiceEvent, { type: 'assistant.transcript' }> => event.type === 'assistant.transcript');
  }

  it('整条只有 <end_call>：不下发 renderer，也不落库', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-tool-tag');

    lastOnEvent?.({ type: 'assistant.transcript', text: '<end_call>', done: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(assistantEvents(client)).toHaveLength(0);
    expect(addMessageToSession.mock.calls.some(([, m]) => m.content.includes('end_call'))).toBe(false);
  });

  it('流式半截标签也压住（<end 到货时还看不出是整条标签）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-tool-tag-stream');

    lastOnEvent?.({ type: 'assistant.transcript', text: '<end', done: false });
    lastOnEvent?.({ type: 'assistant.transcript', text: '_call>', done: false });

    expect(assistantEvents(client)).toHaveLength(0);
  });

  it('标签后面接上正文就恢复下发，正文一个字不动', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-tool-tag-mixed');

    lastOnEvent?.({ type: 'assistant.transcript', text: '<end_call>', done: false });
    lastOnEvent?.({ type: 'assistant.transcript', text: ' 好的，这就去办', done: false });
    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-tool-tag-mixed',
      itemId: 'item-tool-tag-mixed',
      text: '<end_call> 好的，这就去办',
      done: true,
    });
    lastOnEvent?.({ type: 'response.done', responseId: 'resp-tool-tag-mixed' });
    await vi.waitFor(() => expect(addMessageToSession).toHaveBeenCalled());

    expect(assistantEvents(client).some((e) => e.text.includes('好的，这就去办'))).toBe(true);
    expect(addMessageToSession.mock.calls.some(([, m]) => m.content === '<end_call> 好的，这就去办')).toBe(true);
  });

  it('挂断排水窗冲刷的半截缓冲若只有标签，同样不落库', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-tool-tag-drain');
    lastOnEvent?.({ type: 'assistant.transcript', text: '<end_call>', done: false });

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });

    expect(addMessageToSession.mock.calls.some(([, m]) => m.content.includes('end_call'))).toBe(false);
  }, 10_000);
});

// ============================================================================
// A3 · 空对话不落摘要卡（2026-07-30）。那通 16 秒空通话在消息流里留下一张
// 「这通电话没有对话内容」——记录零内容的事不是记录，是噪音。
// ============================================================================
describe('空对话不出通话摘要卡（A3）', () => {
  beforeEach(() => {
    connect.mockClear();
    // close 是「teardown 走完了」的路标，上一条用例的收尾会污染它，必须清
    close.mockClear();
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
    lastOnEvent?.({
      type: 'assistant.transcript',
      responseId: 'resp-with-transcript',
      itemId: 'item-with-transcript',
      text: '好的，我看看。',
      done: true,
    });
    lastOnEvent?.({ type: 'response.done', responseId: 'resp-with-transcript' });
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

  // R2（2026-07-30 真机 14:39:42）：「先这样吧拜拜」之后紧跟「不要挂断」，电话照样挂了。
  // 武装不等于判决——告别窗里的新一句话就是反悔的机会。
  it('武装后用户反悔：新的非挂断字幕解除武装，response.done 不再挂断', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-hangup-recant');

    lastOnEvent?.({ type: 'user.transcript', text: '先这样吧拜拜', done: true });
    // barge-in：用户抢话，这一轮的 response.done 可能抢在他的字幕前面到
    lastOnEvent?.({ type: 'speech.started' });
    lastOnEvent?.({ type: 'response.done' });
    expect(getActiveVoiceSessionId()).not.toBeNull();

    lastOnEvent?.({ type: 'user.transcript', text: '不要挂断', done: true });
    lastOnEvent?.({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('反悔后兜底定时器也撤掉（不能 5 秒后自己挂了）', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-hangup-recant-timer');
      lastOnEvent?.({ type: 'user.transcript', text: '拜拜', done: true });
      lastOnEvent?.({ type: 'user.transcript', text: '等一下我还有事要问', done: true });

      await vi.advanceTimersByTimeAsync(VOICE_END_CALL_GOODBYE_TIMEOUT_MS + 1000);

      expect(getActiveVoiceSessionId()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('武装后不说话：兜底定时器照旧挂断', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-hangup-timeout');
      lastOnEvent?.({ type: 'user.transcript', text: '拜拜', done: true });

      await vi.advanceTimersByTimeAsync(VOICE_END_CALL_GOODBYE_TIMEOUT_MS + 1000);

      expect(getActiveVoiceSessionId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // E2（2026-07-30 真机）：武装→挂断只隔 2 秒，因为触发点是 response.done——
  // 那是模型「生成完」，不是用户「听完」。告别音频那时才刚开始播。
  it('response.done 不当场挂断：等告别音频播完 + 反应窗', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-goodbye-playback');

      lastOnEvent?.({ type: 'user.transcript', text: '拜拜', done: true });
      // 2 秒的告别音频（PCM16@24k 单声道 = 每秒 48000 字节）
      const goodbyeMs = 2_000;
      lastOnAudio?.(Buffer.alloc((VOICE_DOWNSTREAM_SAMPLE_RATE * 2 * goodbyeMs) / 1000));
      lastOnEvent?.({ type: 'response.done' });

      // 音频才刚开始播，这会儿挂断 = 用户根本没听到告别
      await vi.advanceTimersByTimeAsync(goodbyeMs + VOICE_HANGUP_REACTION_WINDOW_MS - 300);
      expect(getActiveVoiceSessionId()).not.toBeNull();

      // 播完 + 反应窗过了才挂
      await vi.advanceTimersByTimeAsync(600);
      expect(getActiveVoiceSessionId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 12_000);

  // 窗口到点时用户还在说（字幕还没转写出来）——不许挂。真机上「不要挂断」这种话
  // 从开口到 final 字幕有一秒多，正好跨过窗口末尾。
  it('反应窗到点时用户仍在说话：不挂断，等他那句字幕', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      await attachVoiceClient(client as never, 'session-goodbye-midsentence');

      lastOnEvent?.({ type: 'user.transcript', text: '拜拜', done: true });
      lastOnEvent?.({ type: 'response.done' });
      lastOnEvent?.({ type: 'speech.started' });

      await vi.advanceTimersByTimeAsync(VOICE_HANGUP_REACTION_WINDOW_MS + 2_000);

      expect(getActiveVoiceSessionId()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 12_000);

  it('告别播放窗里用户反悔：不挂断（这正是真机那次没拦住的）', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-goodbye-recant');

    lastOnEvent?.({ type: 'user.transcript', text: '先这样吧，拜拜', done: true });
    lastOnEvent?.({ type: 'response.done' });
    // 反应窗里抢话
    lastOnEvent?.({ type: 'speech.started' });
    lastOnEvent?.({ type: 'user.transcript', text: '不要挂断', done: true });

    await new Promise((resolve) => setTimeout(resolve, VOICE_HANGUP_REACTION_WINDOW_MS + 500));
    // 判据只看「这通电话还在」：close 是共享替身，上一条用例 teardown 的排水窗尾巴
    // （1.5s 后才调 upstream.close）会跨用例边界打进来，拿它当判据是假红。
    expect(getActiveVoiceSessionId()).not.toBeNull();
  }, 12_000);

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

// ============================================================================
// §2 中途进度节流闸。
//
// 这一组**刻意不把输入一次性喂完**：闸的语义全在时间轴上（首条延迟 / 间隔下限 /
// 保质期），一次性喂完只能证明「调用了几次」，证明不了「在正确的时刻放行/丢弃」。
// X5.5 的教训就是这个——协议零字节改动时，一次性喂完的测试掩盖了速率缺陷。
// 所以每条都按真实时间线推进 fake timer，并在推进**前后各断言一次**。
// ============================================================================
describe('中途进度节流闸（回放时间线）', () => {
  const milestone = (n: number) => ({
    workItemId: `work-1:milestone-${n}`,
    status: 'milestone' as const,
    title: '写周报',
    summary: `第 ${n} 步做完了`,
  });
  const terminal = {
    workItemId: 'work-1',
    status: 'done' as const,
    title: '写周报',
    summary: '写完了。',
  };

  /** 派一件活：让 firstDispatchAt 落定，首条延迟才有基准。 */
  const dispatch = () => voiceDispatchProbe.work?.({ id: 'work-1', title: '写周报', status: 'queued' });

  beforeEach(() => {
    injectItem.mockClear();
    voiceDispatchProbe.narrate = null;
    voiceDispatchProbe.work = null;
    lastOnEvent = null;
  });

  afterEach(async () => {
    // 先回真实计时器再收尾：teardown 里有排水窗等真定时器，假计时器下它永远等不到。
    vi.useRealTimers();
    await endActiveVoiceSession();
  });

  /** 建连必须在真实计时器下完成（连接链路自带定时器），连上之后再接管时间轴。 */
  async function dialThenFreezeClock(sessionId: string): Promise<FakeClient> {
    const client = new FakeClient();
    await attachVoiceClient(client as never, sessionId);
    vi.useFakeTimers();
    return client;
  }

  it('首条进度必须等过延迟窗——推进前不播，推进后才播', async () => {
    const client = await dialThenFreezeClock('session-milestone-delay');
    dispatch();
    injectItem.mockClear();

    voiceDispatchProbe.narrate?.(milestone(1));
    // 推进之前：一条都不许出去。派活开场白和第一条进度不该挤在同一口气里。
    expect(injectItem).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    voiceDispatchProbe.narrate?.(milestone(2));
    expect(injectItem).toHaveBeenCalledTimes(1);
    ackNarration(client, milestone(2).workItemId);
  });

  it('间隔窗内的第二条被丢；推过间隔窗才放行', async () => {
    const client = await dialThenFreezeClock('session-milestone-interval');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    voiceDispatchProbe.narrate?.(milestone(1));
    expect(injectItem).toHaveBeenCalledTimes(1);
    ackNarration(client, milestone(1).workItemId);

    // 间隔窗内：丢。
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_MIN_INTERVAL_MS - 1000);
    voiceDispatchProbe.narrate?.(milestone(2));
    expect(injectItem).toHaveBeenCalledTimes(1);

    // 推过间隔窗：放行。
    await vi.advanceTimersByTimeAsync(2000);
    voiceDispatchProbe.narrate?.(milestone(3));
    expect(injectItem).toHaveBeenCalledTimes(2);
    ackNarration(client, milestone(3).workItemId);
  });

  it('两件并行活各算各的进度间隔，甲刚播过不压住乙', async () => {
    const client = await dialThenFreezeClock('session-milestone-per-task');
    dispatch();
    voiceDispatchProbe.work?.({ id: 'work-2', title: '查风险', status: 'queued' });
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    voiceDispatchProbe.narrate?.(milestone(1));
    ackNarration(client, milestone(1).workItemId);

    const siblingMilestone = {
      workItemId: 'work-2:milestone-1',
      status: 'milestone' as const,
      title: '查风险',
      summary: '风险清单已经整理完。',
    };
    voiceDispatchProbe.narrate?.(siblingMilestone);

    expect(injectItem).toHaveBeenCalledTimes(2);
    expect(injectItem).toHaveBeenLastCalledWith(
      `[BACKEND] ${siblingMilestone.summary}`,
      siblingMilestone.workItemId,
    );
    ackNarration(client, siblingMilestone.workItemId);
  });

  it('每件活最多播上限条，之后一律沉默', async () => {
    const client = await dialThenFreezeClock('session-milestone-cap');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    for (let n = 1; n <= VOICE_MILESTONE_MAX_PER_WORK_ITEM + 2; n += 1) {
      voiceDispatchProbe.narrate?.(milestone(n));
      if (n <= VOICE_MILESTONE_MAX_PER_WORK_ITEM) {
        ackNarration(client, milestone(n).workItemId);
      }
      await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_MIN_INTERVAL_MS + 1);
    }

    expect(injectItem).toHaveBeenCalledTimes(VOICE_MILESTONE_MAX_PER_WORK_ITEM);
  });

  it('用户一开口，排队的进度当场全丢——但终态只排队不丢', async () => {
    await dialThenFreezeClock('session-milestone-usertalk');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    // 借「模型正在说」把两条都压进队列。**刻意不用 speech.started 入队**——那会预先
    // 消耗掉终态的一轮压制额度，两轮满了它会被既有规则丢掉，测出来的就不是本条想测的事。
    upstreamResponding = true;
    voiceDispatchProbe.narrate?.(milestone(1));
    voiceDispatchProbe.narrate?.(terminal);
    expect(injectItem).not.toHaveBeenCalled();

    // 用户开口：进度当场丢，终态只记一轮压制、留在队里
    lastOnEvent?.({ type: 'speech.started' });
    upstreamResponding = false;
    lastOnEvent?.({ type: 'response.done' });

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem.mock.calls[0]?.[0]).toContain('写完了');
  });

  it('排队超过保质期的进度不播——终态不设保质期（正对照）', async () => {
    await dialThenFreezeClock('session-milestone-stale');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(milestone(1));
    voiceDispatchProbe.narrate?.(terminal);

    // 静置超过保质期后再放行
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_STALE_MS + 1000);
    lastOnEvent?.({ type: 'response.done' });

    // 过期进度被丢，终态照播——没有这条正对照，一个「什么都不播」的实现也会通过上一条。
    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem.mock.calls[0]?.[0]).toContain('写完了');
  });

  it('进度的注入文本就是算好的那整段台词，不套终态模板', async () => {
    await dialThenFreezeClock('session-milestone-format');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    voiceDispatchProbe.narrate?.(milestone(1));

    // 正向等值断言：措辞只有一个家（voiceNarration），队列一个字都不该再加。
    // 上一版 formatNarration 没有 milestone 分支，落到终态兜底模板，开头变成
    // 「『写周报』做完了。」——而真实 summary 里紧接着写「整件事还没做完」。
    // 这里不能用 not.toContain('做完了') 之类的宽否定：进度台词本身就含「这步做完了」
    // （指单步），宽否定会误红，也会在措辞一改动就退化成永远成立的空断言。
    expect(injectItem).toHaveBeenCalledWith(
      `[BACKEND] ${milestone(1).summary}`,
      milestone(1).workItemId,
    );
  });

  it('终态不受任何进度闸限制（正对照）', async () => {
    await dialThenFreezeClock('session-milestone-terminal-free');
    dispatch();
    injectItem.mockClear();

    // 首条延迟窗内、零间隔——进度会被丢，终态必须照播。
    voiceDispatchProbe.narrate?.(terminal);
    expect(injectItem).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// R3 worth-hearing：只加权，不抢麦
//
// 这一组要同时钉住**放行**和**压住**两半，缺一半都会变成假绿：
//   - 只测放行：一个「worth-hearing 无视一切闸直接播」的实现全绿，而它会插用户的话。
//   - 只测压住：一个「worth-hearing 什么都不做」的实现全绿，而标记就成了摆设。
// 所以每条豁免都配一条同时刻的普通进度做反证（证明此刻闸确实是关着的），
// 每条抢占都配一条「换成普通进度也是这个下场」的对照（证明压制不是碰巧）。
// ============================================================================
describe('worth-hearing 标记（只加权，绝不豁免 userSpeaking）', () => {
  const worthHearing = (n: number) => ({
    workItemId: `work-1:blocked-${n}`,
    status: 'milestone' as const,
    worthHearing: true as const,
    title: '写周报',
    summary: `卡住了，第 ${n} 次`,
  });
  const milestone = (n: number) => ({
    workItemId: `work-1:milestone-${n}`,
    status: 'milestone' as const,
    title: '写周报',
    summary: `第 ${n} 步做完了`,
  });

  const dispatch = () => voiceDispatchProbe.work?.({ id: 'work-1', title: '写周报', status: 'queued' });

  beforeEach(() => {
    injectItem.mockClear();
    voiceDispatchProbe.narrate = null;
    voiceDispatchProbe.work = null;
    lastOnEvent = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await endActiveVoiceSession();
  });

  async function dialThenFreezeClock(sessionId: string): Promise<FakeClient> {
    const client = new FakeClient();
    await attachVoiceClient(client as never, sessionId);
    vi.useFakeTimers();
    return client;
  }

  it('首条延迟窗内：普通进度被丢，worth-hearing 照播', async () => {
    const client = await dialThenFreezeClock('session-wh-firstdelay');
    dispatch();
    injectItem.mockClear();

    // 反证：同一时刻同一条闸，普通进度确实被关在外面。
    voiceDispatchProbe.narrate?.(milestone(1));
    expect(injectItem).not.toHaveBeenCalled();

    voiceDispatchProbe.narrate?.(worthHearing(1));
    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(injectItem.mock.calls[0]?.[0]).toContain('卡住了');
    ackNarration(client, worthHearing(1).workItemId);
  });

  it('最小间隔窗内：普通进度被丢，worth-hearing 照播', async () => {
    const client = await dialThenFreezeClock('session-wh-interval');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    voiceDispatchProbe.narrate?.(milestone(1));
    expect(injectItem).toHaveBeenCalledTimes(1);
    ackNarration(client, milestone(1).workItemId);

    // 刚播完，间隔窗正关着。
    voiceDispatchProbe.narrate?.(milestone(2));
    expect(injectItem).toHaveBeenCalledTimes(1);

    voiceDispatchProbe.narrate?.(worthHearing(1));
    expect(injectItem).toHaveBeenCalledTimes(2);
    ackNarration(client, worthHearing(1).workItemId);
  });

  it('per-item 上限只让一格：上限外播得出第 N+1 条，播不出第 N+2 条', async () => {
    const client = await dialThenFreezeClock('session-wh-cap');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    for (let n = 1; n <= VOICE_MILESTONE_MAX_PER_WORK_ITEM; n += 1) {
      voiceDispatchProbe.narrate?.(milestone(n));
      ackNarration(client, milestone(n).workItemId);
      await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_MIN_INTERVAL_MS + 1);
    }
    expect(injectItem).toHaveBeenCalledTimes(VOICE_MILESTONE_MAX_PER_WORK_ITEM);

    // 超额那一格：重要转折不该被上限静默吞掉。
    voiceDispatchProbe.narrate?.(worthHearing(1));
    expect(injectItem).toHaveBeenCalledTimes(VOICE_MILESTONE_MAX_PER_WORK_ITEM + 1);
    ackNarration(client, worthHearing(1).workItemId);

    // 但只让一格——豁免不是无限额度，否则一件活能把整通电话说满。
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_MIN_INTERVAL_MS + 1);
    voiceDispatchProbe.narrate?.(worthHearing(2));
    expect(injectItem).toHaveBeenCalledTimes(VOICE_MILESTONE_MAX_PER_WORK_ITEM + 1);
  });

  it('用户正在说话：worth-hearing 一样播不出去（硬边界）', async () => {
    await dialThenFreezeClock('session-wh-usertalk');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    lastOnEvent?.({ type: 'speech.started' });
    voiceDispatchProbe.narrate?.(worthHearing(1));

    // 「重要」是相对其它播报说的，不是相对用户说的。插话没有任何一档重要性配得上。
    expect(injectItem).not.toHaveBeenCalled();
  });

  it('用户开口时，排队中的 worth-hearing 与普通进度同样被丢', async () => {
    await dialThenFreezeClock('session-wh-drop');
    dispatch();
    await vi.advanceTimersByTimeAsync(VOICE_MILESTONE_FIRST_DELAY_MS + 1);
    injectItem.mockClear();

    // 借「模型正在说」把它压进队列（不预先消耗用户轮额度）。
    upstreamResponding = true;
    voiceDispatchProbe.narrate?.(worthHearing(1));
    expect(injectItem).not.toHaveBeenCalled();

    lastOnEvent?.({ type: 'speech.started' });
    upstreamResponding = false;
    lastOnEvent?.({ type: 'response.done' });

    // 用户说完之后再补一句几十秒前的卡点，是打断他而不是帮他——过期语义对它同样成立。
    expect(injectItem).not.toHaveBeenCalled();
  });
});
