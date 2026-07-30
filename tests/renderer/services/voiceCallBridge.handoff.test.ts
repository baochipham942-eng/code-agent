// @vitest-environment jsdom
// R1 交接闪断（2026-07-30 真机）：助手回复揭示完成后「突然清空 → 再出现」。
//
// 根因是撤临时气泡与真消息上屏之间**不原子**：旧逻辑只要「当前 partial 还等于定稿文本」
// 就撤，完全不管真消息到底进没进消息流。host 落库有延迟（reload 那一下常常拉了个空），
// 于是出现一段两边都没有这句话的空帧——肉眼就是闪断。
//
// 这里用回放 harness 复现空帧：逐帧检查「partial 为空 且 消息流里没有真消息」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_DOWNSTREAM_SAMPLE_RATE } from '../../../src/shared/constants/voice';

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
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
}

let sockets: FakeWebSocket[] = [];

const SESSION_ID = 'session-1';
const TEXT = '这是助手说的一整句话，用来验证交接是不是原子的';
const AUDIO_SECONDS = 4;

/** host 落库延迟：早于它去拉消息，一定拉不到——真机就是这么闪断的。 */
let persistedAt = Number.POSITIVE_INFINITY;

function sendEvent(socket: FakeWebSocket, event: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(event) });
}
function sendAudio(socket: FakeWebSocket, seconds: number): void {
  socket.onmessage?.({ data: new ArrayBuffer(Math.round(seconds * VOICE_DOWNSTREAM_SAMPLE_RATE) * 2) });
}

const partial = () => useVoiceCallStore.getState().partialAssistant;
const realMessageLanded = () =>
  useSessionStore.getState().messages.some((m) => m.role === 'assistant' && m.content.trim() === TEXT);

async function dialAndOpen(): Promise<FakeWebSocket> {
  await voiceCallBridge.dial(SESSION_ID);
  const socket = sockets[sockets.length - 1];
  socket.simulateOpen();
  await Promise.resolve();
  return socket;
}

describe('R1 临时气泡与真消息的交接必须原子', () => {
  beforeEach(() => {
    sockets = [];
    persistedAt = Number.POSITIVE_INFINITY;
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() { super(); sockets.push(this); }
    });
    // 消息流：只有过了 persistedAt 这条真消息才会被拉到（模拟 host 落库延迟）
    vi.stubGlobal('domainAPI', undefined);
    (window as unknown as Record<string, unknown>).domainAPI = {
      invoke: vi.fn(async () => ({
        success: true,
        data: {
          messages: Date.now() >= persistedAt
            ? [{ id: 'voice-assistant-1', role: 'assistant', content: TEXT, timestamp: Date.now(), metadata: { source: 'voice' } }]
            : [],
        },
      })),
    };
    useVoiceCallStore.getState().reset();
    useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).domainAPI;
    useVoiceCallStore.getState().reset();
    useSessionStore.setState({ currentSessionId: null, messages: [] });
  });

  it('host 落库晚于首次拉取时，撤气泡与真消息上屏之间不出现空帧', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();
    // 落库比第一次 reload（final 后 500ms）晚——真机的常态
    persistedAt = Date.now() + AUDIO_SECONDS * 1000 + 2_000;

    for (let i = 0; i < TEXT.length; i += 3) {
      sendEvent(socket, { type: 'assistant.transcript', text: TEXT.slice(i, i + 3), done: false });
    }
    sendAudio(socket, AUDIO_SECONDS);
    sendEvent(socket, { type: 'assistant.transcript', text: TEXT, done: true });

    let blankFrames = 0;
    for (let t = 0; t < 12_000; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      // 空帧 = 临时气泡撤了，真消息又还没上屏，这句话哪儿都不在
      if (partial() === '' && !realMessageLanded()) blankFrames += 1;
    }

    expect(realMessageLanded()).toBe(true);
    expect(blankFrames).toBe(0);
  });

  it('真消息先到时照常撤气泡，不留重影', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();
    persistedAt = Date.now(); // 落库已完成，第一次拉就能拿到

    for (let i = 0; i < TEXT.length; i += 3) {
      sendEvent(socket, { type: 'assistant.transcript', text: TEXT.slice(i, i + 3), done: false });
    }
    sendAudio(socket, AUDIO_SECONDS);
    sendEvent(socket, { type: 'assistant.transcript', text: TEXT, done: true });

    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 + 2_000);
    expect(realMessageLanded()).toBe(true);
    expect(partial()).toBe(''); // 真消息接手后临时气泡必须撤掉，否则同一句话出现两遍
  });
});
