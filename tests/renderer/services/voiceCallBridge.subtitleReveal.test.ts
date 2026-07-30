// @vitest-environment jsdom
// 字幕揭示器（批 X5.5-A4，2026-07-30 协议层实测定案）。
//
// 真机量到的事实：上游把整段转写在 544ms 内吐完，而同一段语音要播 24.6 秒。
// 照 delta 到达直接上屏 = 字幕比语音早跑完 20 多秒，肉眼就是「攒整句一次性铺满」。
// 所以揭示进度绑音频播放进度。这里钉住核心节流 + 监工点名的四条边界。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_DOWNSTREAM_SAMPLE_RATE,
  VOICE_SUBTITLE_STALL_FLUSH_MS,
} from '../../../src/shared/constants/voice';
import { computeRevealedSubtitle } from '../../../src/renderer/utils/voicePartialOverlay';

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
  setCaptureOpen() {},
  async start() {},
  stop() {},
  setMuted() {},
  enqueuePlayback() {},
  clearPlayback() {},
};
vi.mock('../../../src/renderer/services/voiceAudioPipeline', () => ({
  VoiceAudioPipeline: class { constructor() { return { ...pipelineStub }; } },
}));
vi.mock('../../../src/renderer/services/nativeVoiceAudioPipeline', () => ({
  NativeVoiceAudioPipeline: class { constructor() { return { ...pipelineStub }; } },
}));

const { voiceCallBridge } = await import('../../../src/renderer/services/voiceCallBridge');
const { useVoiceCallStore } = await import('../../../src/renderer/stores/voiceCallStore');

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

const FULL_TEXT = '一二三四五六七八九十'.repeat(10); // 100 字，够看出揭示比例
const AUDIO_SECONDS = 10;

function sendEvent(socket: FakeWebSocket, event: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(event) });
}

/** 灌 N 秒下行音频（一帧灌完，模拟上游按生成速度突发下发）。 */
function sendAudio(socket: FakeWebSocket, seconds: number): void {
  socket.onmessage?.({ data: new ArrayBuffer(Math.round(seconds * VOICE_DOWNSTREAM_SAMPLE_RATE) * 2) });
}

/** 上游那 544ms 突发：整段转写一次性到齐。 */
function burstDeltas(socket: FakeWebSocket, text: string): void {
  for (let i = 0; i < text.length; i += 3) {
    sendEvent(socket, { type: 'assistant.transcript', text: text.slice(i, i + 3), done: false });
  }
}

const partial = () => useVoiceCallStore.getState().partialAssistant;

async function dialAndOpen(): Promise<FakeWebSocket> {
  await voiceCallBridge.dial('session-1');
  const socket = sockets[sockets.length - 1];
  socket.simulateOpen();
  await Promise.resolve();
  return socket;
}

describe('voiceCallBridge 字幕揭示绑播放进度', () => {
  beforeEach(() => {
    sockets = [];
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() { super(); sockets.push(this); }
    });
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useVoiceCallStore.getState().reset();
  });

  it('揭示比例跟播放进度走：整段 delta 突发到齐也不一次性铺满', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    burstDeltas(socket, FULL_TEXT);
    sendAudio(socket, AUDIO_SECONDS);

    // 突发刚落地：文本全到了，但一个字都还没播出去
    await vi.advanceTimersByTimeAsync(100);
    expect(partial().length).toBeGreaterThan(0);
    expect(partial().length).toBeLessThan(10); // 这是本单的核心断言：没有攒整句一次性铺满

    // 播到一半 → 字幕跟到一半
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 / 2);
    expect(partial().length).toBeGreaterThan(FULL_TEXT.length * 0.35);
    expect(partial().length).toBeLessThan(FULL_TEXT.length * 0.65);

    // 播完 → 全文
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 / 2);
    expect(partial()).toBe(FULL_TEXT);
  });

  it('final 是内容真源不是揭示时机：到达时不跳变到全文，且以 final 校正已揭示前缀', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    burstDeltas(socket, '甲甲甲甲甲甲甲甲甲甲');
    sendAudio(socket, AUDIO_SECONDS);
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 / 2);
    expect(partial().length).toBeGreaterThan(0);
    expect(partial().startsWith('甲')).toBe(true);

    // final 全文到达（内容与 delta 拼接不同 → 防漂移要以 final 为准）
    sendEvent(socket, { type: 'assistant.transcript', text: '乙乙乙乙乙乙乙乙乙乙', done: true });
    expect(partial()).not.toBe('乙乙乙乙乙乙乙乙乙乙'); // 没有跳变到全文
    expect(partial().startsWith('乙')).toBe(true); // 已揭示前缀被 final 静默替换

    // 快播完时定稿到 final 全文；停在交接延时（500ms）之前，交接本身由下一条覆盖
    await vi.advanceTimersByTimeAsync(4_600);
    expect(partial()).toBe('乙乙乙乙乙乙乙乙乙乙');
  });

  it('真消息交接推迟到揭示完成才发生，不在 final 到达时就换脸', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    burstDeltas(socket, FULL_TEXT);
    sendAudio(socket, AUDIO_SECONDS);
    sendEvent(socket, { type: 'assistant.transcript', text: FULL_TEXT, done: true });

    // final 已到、语音才播了两成：临时气泡必须还在顶着，且没有被拉成全文
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 * 0.2);
    expect(partial().length).toBeGreaterThan(0);
    expect(partial().length).toBeLessThan(FULL_TEXT.length);

    // 揭示完成 + 交接延时到点 → 临时气泡才让位给真消息
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000 * 0.8 + 600);
    expect(partial()).toBe('');
  });

  it('边界1 挂断：立即定稿并停表，通话结束不留半句、也不留活定时器', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    burstDeltas(socket, FULL_TEXT);
    sendAudio(socket, AUDIO_SECONDS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(partial().length).toBeLessThan(FULL_TEXT.length);

    voiceCallBridge.hangUp();
    // 挂断后揭示器必须死透：再走多久都不会有人往 store 里补写字幕
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000);
    expect(partial()).toBe('');
  });

  it('边界2 barge-in：用户开口掐掉播放队列，揭示器同步停、不空转', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    burstDeltas(socket, FULL_TEXT);
    sendAudio(socket, AUDIO_SECONDS);
    await vi.advanceTimersByTimeAsync(1000);
    const revealedBefore = partial().length;
    expect(revealedBefore).toBeGreaterThan(0);

    sendEvent(socket, { type: 'speech.started' });
    expect(partial()).toBe(''); // 沿用既有 partial 清理语义

    // 剩下的文本永远不会被念出来，揭示器不许继续长
    await vi.advanceTimersByTimeAsync(AUDIO_SECONDS * 1000);
    expect(partial()).toBe('');
  });

  it('边界3+4 拿不到播放进度：停滞兜底放完全文，字幕绝不永久悬着', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    // 一帧音频都不来（原生管线降级 / 这一轮压根没有音频）
    burstDeltas(socket, FULL_TEXT);
    await vi.advanceTimersByTimeAsync(500);
    expect(partial()).toBe(''); // 还在等播放时间轴

    await vi.advanceTimersByTimeAsync(VOICE_SUBTITLE_STALL_FLUSH_MS);
    expect(partial()).toBe(FULL_TEXT); // fail-open：宁可回到现状，也不能字幕不出
  });
});

describe('computeRevealedSubtitle', () => {
  it('按已播比例切前缀，分母为 0 时不揭示', () => {
    expect(computeRevealedSubtitle('一二三四', 0, 0)).toBe('');
    expect(computeRevealedSubtitle('一二三四', 10, 0)).toBe('');
    expect(computeRevealedSubtitle('一二三四', 10, 5)).toBe('一二');
    expect(computeRevealedSubtitle('一二三四', 10, 10)).toBe('一二三四');
  });

  it('播放进度越界不越界揭示（比例钳在 0..1）', () => {
    expect(computeRevealedSubtitle('一二三四', 10, 99)).toBe('一二三四');
    expect(computeRevealedSubtitle('一二三四', 10, -5)).toBe('');
  });
});
