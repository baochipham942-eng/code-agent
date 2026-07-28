// 全局单路互斥与挂断释放（方案 §2.6 / Phase 0 出口「验证互斥与挂断」）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { isVoiceInputMessage, type Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport } from '../../src/shared/contract/voice';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

const close = vi.fn(async () => undefined);
const sendAudio = vi.fn();
const commitMock = vi.fn();
const updateInstructions = vi.fn();
const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
const patchSessionMetadata = vi.fn(async (_sessionId: string, _patch: Record<string, unknown>) => true);
const getSession = vi.fn(async (_sessionId: string) => ({ workingDirectory: '/repo/voice-session' }));
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), updateInstructions, close };
});

vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({ qwenOmniTransport: { id: 'qwen-omni', connect } }));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => 'test-key' }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession, patchSessionMetadata, getSession }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

const { attachVoiceClient, getActiveVoiceSessionId, endActiveVoiceSession } = await import('../../src/host/services/voice/voiceSessionService');

/** 最小 ws 替身：只要 readyState / OPEN / send / close / 事件。 */
class FakeClient extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  send(data: unknown) {
    this.sent.push(typeof data === 'string' ? data : '<binary>');
  }
  close() {
    this.closed = true;
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
    addMessageToSession.mockClear();
    lastOnEvent = null;
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
      return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), updateInstructions, close };
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
  });

  afterEach(async () => {
    await endActiveVoiceSession();
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
