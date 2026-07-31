import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  static nextEvent: unknown = { type: 'session.created' };
  static sessionUpdateEvent: unknown = { type: 'session.updated' };
  static beforeSessionUpdateEvent: unknown = null;
  static nextError: Error | null = null;
  sent: string[] = [];

  constructor(_url: string, _options: unknown) {
    super();
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
      if (FakeWebSocket.nextError) {
        this.emit('error', FakeWebSocket.nextError);
        return;
      }
      this.emit('message', JSON.stringify(FakeWebSocket.nextEvent));
    }, 0);
  }

  close() {
    this.readyState = 3;
  }

  send(data: string) {
    this.sent.push(data);
    const event = JSON.parse(data) as { type?: string };
    if (event.type === 'session.update') {
      if (FakeWebSocket.beforeSessionUpdateEvent) {
        setTimeout(() => this.emit('message', JSON.stringify(FakeWebSocket.beforeSessionUpdateEvent)), 0);
      }
      setTimeout(() => {
        this.emit('message', JSON.stringify(FakeWebSocket.sessionUpdateEvent));
        if ((FakeWebSocket.sessionUpdateEvent as { type?: string }).type !== 'session.updated') {
          this.emit('close');
        }
      }, 0);
    }
  }
}

const secureKeys = new Map<string, string>();
const settings = {
  voice: {
    live: {
      providerId: 'dashscope-qwen-omni',
      customProviders: [] as unknown[],
    },
  },
};
const updateSettings = vi.fn(async (update: typeof settings) => {
  settings.voice = update.voice;
});
const getHttpsAgentMock = vi.hoisted(() => vi.fn(() => undefined));

vi.mock('ws', () => ({ default: FakeWebSocket }));
vi.mock('../../src/host/model/providers/providerHttp', () => ({
  getHttpsAgent: getHttpsAgentMock,
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => settings,
    updateSettings,
    getApiKey: vi.fn(),
  }),
}));
vi.mock('../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    setApiKey: (slot: string, key: string) => secureKeys.set(slot, key),
    getApiKey: (slot: string) => secureKeys.get(slot),
    deleteApiKey: (slot: string) => secureKeys.delete(slot),
  }),
}));

const {
  deleteCustomRealtimeVoiceProvider,
  listCustomRealtimeVoiceProviders,
  normalizeCustomRealtimeProviderInput,
  resolveConfiguredRealtimeVoiceProfile,
  saveCustomRealtimeVoiceProvider,
  testCustomRealtimeVoiceProvider,
} = await import('../../src/host/services/voice/customRealtimeVoiceProviders');

const candidate = {
  id: 'acme-realtime',
  displayName: 'Acme Realtime',
  endpoint: 'wss://voice.example.com/v1/realtime',
  authStyle: 'bearer' as const,
  sessionShape: 'openai-realtime' as const,
  model: 'acme-voice-1',
  voices: ['zh-warm', 'en-clear', 'zh-warm'],
  defaultVoice: 'zh-warm',
  inputSampleRate: 24_000 as const,
};

describe('custom Realtime voice Provider registry', () => {
  beforeEach(() => {
    secureKeys.clear();
    settings.voice.live = {
      providerId: 'dashscope-qwen-omni',
      customProviders: [],
    };
    updateSettings.mockClear();
    getHttpsAgentMock.mockClear();
    FakeWebSocket.nextEvent = { type: 'session.created' };
    FakeWebSocket.sessionUpdateEvent = { type: 'session.updated' };
    FakeWebSocket.beforeSessionUpdateEvent = null;
    FakeWebSocket.nextError = null;
  });

  it('rejects non-WSS/private endpoints and unsupported protocol families', () => {
    expect(() => normalizeCustomRealtimeProviderInput({
      ...candidate,
      endpoint: 'ws://127.0.0.1:9000/realtime',
    })).toThrow();
    expect(() => normalizeCustomRealtimeProviderInput({
      ...candidate,
      endpoint: 'wss://127.0.0.1:9000/realtime',
    })).toThrow();
    expect(() => normalizeCustomRealtimeProviderInput({
      ...candidate,
      endpoint: 'wss://user:password@voice.example.com/realtime',
    })).toThrow();
    expect(() => normalizeCustomRealtimeProviderInput({
      ...candidate,
      authStyle: 'other',
    })).toThrow('NEEDS_CODE_ADAPTATION');
  });

  it('requires a compatible session.created event before save', async () => {
    FakeWebSocket.nextEvent = { type: 'vendor.ready' };

    await expect(testCustomRealtimeVoiceProvider(candidate, 'secret-value')).resolves.toMatchObject({
      success: false,
      needsCodeAdaptation: true,
    });
    await expect(saveCustomRealtimeVoiceProvider(candidate, 'secret-value')).rejects.toThrow(
      '端点未返回兼容的 session.created 事件',
    );
    expect(settings.voice.live.customProviders).toEqual([]);
    expect(secureKeys.size).toBe(0);
  });

  it('requires session.updated to echo the tested session.update before save', async () => {
    FakeWebSocket.sessionUpdateEvent = { type: 'vendor.updated' };

    await expect(testCustomRealtimeVoiceProvider(candidate, 'secret-value')).resolves.toMatchObject({
      success: false,
      needsCodeAdaptation: true,
      error: expect.stringContaining('session.updated'),
    });
    expect(settings.voice.live.customProviders).toEqual([]);
    expect(secureKeys.size).toBe(0);
  });

  it('ignores unrelated events between session.created and session.updated', async () => {
    FakeWebSocket.beforeSessionUpdateEvent = { type: 'rate_limits.updated' };

    await expect(testCustomRealtimeVoiceProvider(candidate, 'secret-value')).resolves.toMatchObject({
      success: true,
      needsCodeAdaptation: false,
    });
  });

  it('stores only metadata in settings and isolates the key by Provider id', async () => {
    const saved = await saveCustomRealtimeVoiceProvider(candidate, 'secret-value');

    expect(getHttpsAgentMock).toHaveBeenCalledWith('wss://voice.example.com/v1/realtime?model=acme-voice-1');
    expect(saved.voices).toEqual(['zh-warm', 'en-clear']);
    expect(listCustomRealtimeVoiceProviders()).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain('secret-value');
    expect(secureKeys.get('custom-realtime:acme-realtime')).toBe('secret-value');
    expect(resolveConfiguredRealtimeVoiceProfile('acme-realtime')).toMatchObject({
      id: 'acme-realtime',
      sessionShape: 'openai-realtime',
      defaultModel: 'acme-voice-1',
      defaultVoice: 'zh-warm',
    });
    const firstUpdatedAt = listCustomRealtimeVoiceProviders()[0].updatedAt;
    expect(listCustomRealtimeVoiceProviders()[0].updatedAt).toBe(firstUpdatedAt);
  });

  it('never returns a secret embedded in a connection error', async () => {
    const secret = 'sk-proj-super-sensitive-provider-key-1234567890';
    FakeWebSocket.nextError = new Error(`handshake rejected ${secret}`);

    const result = await testCustomRealtimeVoiceProvider(candidate, secret);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(secret);
    expect(result.error).toContain('secret hidden');
  });

  it('falls back to DashScope for unknown ids and deletes orphaned keys', async () => {
    await saveCustomRealtimeVoiceProvider(candidate, 'secret-value');
    settings.voice.live.providerId = 'acme-realtime';
    await deleteCustomRealtimeVoiceProvider('acme-realtime');

    expect(resolveConfiguredRealtimeVoiceProfile('missing-provider').id).toBe('dashscope-qwen-omni');
    expect(settings.voice.live.providerId).toBe('dashscope-qwen-omni');
    expect(secureKeys.has('custom-realtime:acme-realtime')).toBe(false);
  });
});
