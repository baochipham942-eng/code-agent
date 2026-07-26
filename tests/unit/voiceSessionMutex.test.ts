// 全局单路互斥与挂断释放（方案 §2.6 / Phase 0 出口「验证互斥与挂断」）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { isVoiceInputMessage, type Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport } from '../../src/shared/contract/voice';

const close = vi.fn(async () => undefined);
const sendAudio = vi.fn();
const addMessageToSession = vi.fn(async () => undefined);
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  return { kind: 'relay', provider: 'qwen-omni', sendAudio, interrupt: vi.fn(), close };
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
      return { kind: 'relay', provider: 'qwen-omni', sendAudio, interrupt: vi.fn(), close };
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

  it('二进制帧转发到上游，文本帧不当音频转发', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'interrupt' })), false);

    expect(sendAudio).toHaveBeenCalledTimes(1);
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
    const [, message] = addMessageToSession.mock.calls[0] as [string, Message];
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
      expect(addMessageToSession.mock.calls.some(([, message]) => Boolean((message as Message).metadata?.voiceCallSummary))).toBe(true);
    });
    const [, summaryMessage] = addMessageToSession.mock.calls.find(([, message]) =>
      Boolean((message as Message).metadata?.voiceCallSummary)
    ) as [string, Message];
    expect(summaryMessage.role).toBe('system');
    expect(summaryMessage.metadata?.source).toBe('voice');
    expect(summaryMessage.metadata?.voiceCallSummary).toMatchObject({
      durationSec: 75,
      provider: 'qwen-omni',
      conversationModel: 'qwen3-omni-flash-realtime',
      workItemCount: 0,
      startedAt,
      endedAt,
    });
    expect(summaryMessage.content).toBe('语音通话结束，时长 1 分 15 秒');
    nowSpy.mockRestore();
  });
});
