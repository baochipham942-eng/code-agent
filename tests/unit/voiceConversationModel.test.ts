// 工单③：通话模型可配的 host 侧判据。
// 判据打在行为上——「建连时真把那个模型发给 transport」，不是「某个字段被赋了值」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Message } from '../../src/shared/contract/message';
import type { VoiceEvent, VoiceTransport } from '../../src/shared/contract/voice';
import type { VoiceLiveSettings } from '../../src/shared/contract/settings';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

const close = vi.fn(async () => undefined);
const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
const patchSessionMetadata = vi.fn(async (_sessionId: string, _patch: Record<string, unknown>) => true);
const getSession = vi.fn(async (_sessionId: string) => ({ workingDirectory: '/repo/voice-session' }));
let lastOnEvent: ((event: VoiceEvent) => void) | null = null;
const connect = vi.fn(async (input: Parameters<VoiceTransport['connect']>[0]) => {
  lastOnEvent = input.onEvent;
  return { kind: 'relay', provider: 'qwen-omni', sendAudio: vi.fn(), commit: vi.fn(), interrupt: vi.fn(), updateInstructions: vi.fn(), close };
});

// 设置真源的替身：每个用例直接改 value，不走 IPC。
const mockSettings = vi.hoisted(() => ({
  value: {} as { voice?: { turnDetection?: unknown; live?: VoiceLiveSettings } },
}));

vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({ qwenOmniTransport: { id: 'qwen-omni', connect } }));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => mockSettings.value }),
}));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => 'test-key' }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession, patchSessionMetadata, getSession }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/task', () => ({ getTaskManager: () => undefined }));
vi.mock('../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(async () => undefined),
    hasHooksFor: () => false,
    triggerVoiceCall: vi.fn(async () => ({ blocked: false })),
  }),
}));

const { attachVoiceClient, getActiveVoiceSessionId, endActiveVoiceSession } = await import('../../src/host/services/voice/voiceSessionService');

/** 最小 ws 替身（同 voiceSessionMutex 先例）。 */
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

function lastConnectConfig(): { model?: string } {
  const input = connect.mock.calls.at(-1)?.[0];
  if (!input) throw new Error('transport.connect was not called');
  return input.config;
}

describe('通话模型可配（工单③）', () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    addMessageToSession.mockClear();
    lastOnEvent = null;
    mockSettings.value = {};
  });

  afterEach(async () => {
    await endActiveVoiceSession();
  });

  it('设置里配了模型 → 建连时真把那个模型发给 transport，挂断摘要也如实记它', async () => {
    mockSettings.value = { voice: { live: { conversationModel: 'qwen3-omni-flash-realtime' } } };
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');
    expect(getActiveVoiceSessionId()).not.toBeNull();

    expect(lastConnectConfig().model).toBe('qwen3-omni-flash-realtime');

    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    await vi.waitFor(() => {
      expect(addMessageToSession.mock.calls.some(([, m]) => Boolean(m.metadata?.voiceCallSummary))).toBe(true);
    }, { timeout: 4000 });
    const summary = addMessageToSession.mock.calls.find(([, m]) => Boolean(m.metadata?.voiceCallSummary));
    expect(summary?.[1].metadata?.voiceCallSummary).toMatchObject({
      conversationModel: 'qwen3-omni-flash-realtime',
    });
  }, 10_000);

  it('设置为空 → 回落到默认常量（存量用户没有 conversationModel 字段）', async () => {
    mockSettings.value = {};
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    expect(lastConnectConfig().model).toBe(QWEN_OMNI_REALTIME_MODEL);
    client.close();
  });

  it('表外 id（手改设置 JSON）→ 回落默认模型，表外 id 绝不上线', async () => {
    mockSettings.value = { voice: { live: { conversationModel: 'some-random-model' } } };
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    expect(lastConnectConfig().model).toBe(QWEN_OMNI_REALTIME_MODEL);
    client.close();
  });

  it('上游 notice（tools 被静默丢弃）原样透传给通话客户端', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-1');

    lastOnEvent?.({ type: 'notice', code: 'VOICE_TOOLS_DROPPED', message: '只能聊天' });

    const frames = client.sent.map((s) => (s === '<binary>' ? null : (JSON.parse(s) as { type: string; code?: string })));
    expect(frames.some((f) => f?.type === 'notice' && f.code === 'VOICE_TOOLS_DROPPED')).toBe(true);
    client.close();
  });
});
