// @vitest-environment jsdom
// 单 B：renderer 侧语音字幕覆盖与合并交接回归。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(async () => ({ voice: { live: { interrupt: 'server_vad', echoCancellation: 'off' } } })),
  },
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  isNativeDesktopAvailable: () => false,
}));
vi.mock('../../../src/renderer/services/voiceEchoHint', () => ({
  maybeShowSpeakerEchoHint: vi.fn(async () => undefined),
  showVoiceAecFallbackWarning: vi.fn(),
}));
const pipelineStub = {
  setCaptureOpen() {}, async start() {}, stop() {}, setMuted() {}, enqueuePlayback() {}, clearPlayback() {},
};
vi.mock('../../../src/renderer/services/voiceAudioPipeline', () => ({
  VoiceAudioPipeline: class { constructor() { return { ...pipelineStub }; } },
}));
vi.mock('../../../src/renderer/services/nativeVoiceAudioPipeline', () => ({
  NativeVoiceAudioPipeline: class { constructor() { return { ...pipelineStub }; } },
}));

const { voiceCallBridge } = await import('../../../src/renderer/services/voiceCallBridge');
const { useVoiceCallStore } = await import('../../../src/renderer/stores/voiceCallStore');
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send() {}
  close() { this.readyState = 3; }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

let sockets: FakeWebSocket[] = [];

function sendEvent(socket: FakeWebSocket, event: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(event) });
}

async function dialAndOpen(): Promise<FakeWebSocket> {
  await voiceCallBridge.dial('session-voice-overwrite');
  const socket = sockets[sockets.length - 1];
  socket.simulateOpen();
  await Promise.resolve();
  return socket;
}

const partialUser = () => useVoiceCallStore.getState().partialUser;

describe('语音用户字幕逐 item 累积', () => {
  beforeEach(() => {
    sockets = [];
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    });
    useVoiceCallStore.getState().reset();
    useSessionStore.setState({ currentSessionId: 'session-voice-overwrite', messages: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).domainAPI;
    useVoiceCallStore.getState().reset();
    useSessionStore.setState({ currentSessionId: null, messages: [] });
  });

  it('连续三个 item 的 partial 只增不减，并保留已定稿前缀', async () => {
    const socket = await dialAndOpen();
    const shown: string[] = [];

    sendEvent(socket, { type: 'user.transcript', itemId: 'item-a', text: 'aaaa', done: false });
    shown.push(partialUser());
    sendEvent(socket, { type: 'user.transcript', itemId: 'item-b', text: 'bbbb', done: false });
    shown.push(partialUser());
    sendEvent(socket, { type: 'user.transcript', itemId: 'item-c', text: 'cccc', done: false });
    shown.push(partialUser());

    expect(shown).toEqual(['aaaa', 'aaaa bbbb', 'aaaa bbbb cccc']);
    expect(shown.every((text, index) => index === 0 || text.length >= shown[index - 1]!.length)).toBe(true);
  });

  it('host 合并行包含当前 final 片段时，临时气泡可以撤掉', async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).domainAPI = {
      invoke: vi.fn(async () => ({
        success: true,
        data: {
          messages: [
            { id: 'voice-user-merged', role: 'user', content: 'aaaa bbbb cccc', timestamp: 0, metadata: { source: 'voice' } },
          ],
        },
      })),
    };
    const socket = await dialAndOpen();

    sendEvent(socket, { type: 'user.transcript', itemId: 'item-c', text: 'cccc', done: true });
    expect(partialUser()).toBe('cccc');

    await vi.advanceTimersByTimeAsync(500);
    expect(partialUser()).toBe('');
  });

  it('单字符片段不能仅凭包含关系撤掉临时气泡', async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).domainAPI = {
      invoke: vi.fn(async () => ({
        success: true,
        data: {
          messages: [
            { id: 'voice-user-unrelated', role: 'user', content: 'aaaa', timestamp: 0, metadata: { source: 'voice' } },
          ],
        },
      })),
    };
    const socket = await dialAndOpen();

    sendEvent(socket, { type: 'user.transcript', itemId: 'item-short', text: 'a', done: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(partialUser()).toBe('a');
  });
});
