// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nativeCallbacks: null as null | { onError?: () => void; onPlaybackStarted?: () => void },
  nativeStop: vi.fn(),
  webStart: vi.fn(async () => undefined),
  fallbackWarning: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(async () => ({ voice: { live: { interrupt: 'server_vad', echoCancellation: 'auto' } } })),
  },
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  isNativeDesktopAvailable: () => true,
}));
vi.mock('../../../src/renderer/services/voiceEchoHint', () => ({
  maybeShowSpeakerEchoHint: vi.fn(async () => undefined),
  showVoiceAecFallbackWarning: mocks.fallbackWarning,
}));
vi.mock('../../../src/renderer/services/voiceAudioPipeline', () => ({
  VoiceAudioPipeline: class {
    setCaptureOpen() {}
    async start() { await mocks.webStart(); }
    stop() {}
    setMuted() {}
    enqueuePlayback() {}
    clearPlayback() {}
  },
}));
vi.mock('../../../src/renderer/services/nativeVoiceAudioPipeline', () => ({
  NativeVoiceAudioPipeline: class {
    constructor(callbacks: { onError?: () => void; onPlaybackStarted?: () => void }) {
      mocks.nativeCallbacks = callbacks;
    }
    setCaptureOpen() {}
    async start() {}
    stop() { mocks.nativeStop(); }
    setMuted() {}
    enqueuePlayback() { mocks.nativeCallbacks?.onPlaybackStarted?.(); }
    clearPlayback() {}
  },
}));

const { voiceCallBridge } = await import('../../../src/renderer/services/voiceCallBridge');
const { useVoiceCallStore } = await import('../../../src/renderer/stores/voiceCallStore');

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: unknown) { if (typeof data === 'string') this.sent.push(data); }
  close() { this.readyState = 3; }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
}

let socket: FakeWebSocket;

describe('voiceCallBridge 原生 AEC 运行时降级', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.nativeCallbacks = null;
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() {
        super();
        socket = this;
      }
    });
    useVoiceCallStore.getState().reset();
    await voiceCallBridge.dial('session-native-fallback');
    socket.simulateOpen();
    await vi.waitFor(() => expect(mocks.nativeCallbacks).not.toBeNull());
  });

  afterEach(() => {
    voiceCallBridge.hangUp();
    vi.unstubAllGlobals();
    useVoiceCallStore.getState().reset();
  });

  it('sidecar error 会停原生管线、启动 Web Audio 并上报 headphones', async () => {
    mocks.nativeCallbacks?.onError?.();

    await vi.waitFor(() => expect(mocks.webStart).toHaveBeenCalledTimes(1));
    expect(mocks.nativeStop).toHaveBeenCalled();
    expect(mocks.fallbackWarning).toHaveBeenCalled();
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'audio_mode',
      mode: 'headphones',
      reason: 'native-runtime-error',
    });
  });

  it('Host 标记播报响应后，真实播放首帧才回 narration ack', () => {
    socket.onmessage?.({
      data: JSON.stringify({ type: 'response.created', responseId: 'response-1', narrationId: 'narration-1' }),
    });
    expect(socket.sent.map((raw) => JSON.parse(raw))).not.toContainEqual({
      type: 'narration.playback_started',
      narrationId: 'narration-1',
    });

    socket.onmessage?.({ data: new ArrayBuffer(4) });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'narration.playback_started',
      narrationId: 'narration-1',
    });
  });
});
