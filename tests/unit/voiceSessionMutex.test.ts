// 全局单路互斥与挂断释放（方案 §2.6 / Phase 0 出口「验证互斥与挂断」）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { isVoiceInputMessage, type Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport } from '../../src/shared/contract/voice';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

const close = vi.fn(async () => undefined);
const sendAudio = vi.fn();
const commitMock = vi.fn();
const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), close };
});

vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({ qwenOmniTransport: { id: 'qwen-omni', connect } }));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => 'test-key' }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { attachVoiceClient, getActiveVoiceSessionId } = await import('../../src/host/services/voice/voiceSessionService');

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
    addMessageToSession.mockClear();
    lastOnEvent = null;
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

    first.close();
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
  });

  it('并发拨号只建一条上游连接（闸门必须早于 await）', async () => {
    // 上游握手不是瞬时的：让它挂一拍，模拟真实的 await 窗口
    connect.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { kind: 'relay', provider: 'qwen-omni', sendAudio, commit: commitMock, interrupt: vi.fn(), close };
    });

    const a = new FakeClient();
    const b = new FakeClient();
    await Promise.all([attachVoiceClient(a as never, 's1'), attachVoiceClient(b as never, 's2')]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(types(b)).toContain('VOICE_SESSION_BUSY');
    a.close();
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
  });

  it('挂断释放上游并允许续拨', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
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

    lastOnEvent?.({ type: 'error', code: 'COMMON_ERROR', message: '上游炸了' });
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
    expect(close).toHaveBeenCalled(); // 上游连接也要放掉，别留着继续计费

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

  it('挂断后写入 voiceCallSummary，durationSec 来自真实起止时间', async () => {
    const startedAt = 1_800_000_000_000;
    const endedAt = startedAt + 75_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    nowSpy.mockReturnValue(endedAt);

    client.close();

    await vi.waitFor(() => {
      expect(addMessageToSession.mock.calls.some(([, message]) => Boolean(message.metadata?.voiceCallSummary))).toBe(true);
    });
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

    client.close();
    await vi.waitFor(() => expect(getActiveVoiceSessionId()).toBeNull());
    expect(manager.isLiveVoiceSession('session-live')).toBe(false);
  });
});
