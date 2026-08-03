import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS, VOICE_UPSTREAM_SILENCE_TIMEOUT_MS } from '../../src/shared/constants/voice';

class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  send = vi.fn((data: string) => {
    const event = JSON.parse(data) as { type?: string; session?: Record<string, unknown> };
    if (event.type === 'session.update') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        type: 'session.updated',
        session: event.session,
      })));
    }
  });
  ping = vi.fn();
  close() {
    this.readyState = 3;
  }
  terminate = vi.fn(() => {
    this.readyState = 3;
  });
}

const upstreams: FakeUpstream[] = [];
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('ws', () => {
  class MockWebSocket extends FakeUpstream {
    static OPEN = 1;
    constructor() {
      super();
      upstreams.push(this);
      setTimeout(() => this.emit('open'), 0);
    }
  }
  return { default: MockWebSocket };
});

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => logger,
}));

vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
}));

const { qwenOmniTransport } = await import('../../src/host/services/voice/qwenOmniTransport');

describe('Qwen Omni 上游事件日志', () => {
  beforeEach(() => {
    upstreams.length = 0;
    vi.clearAllMocks();
  });

  it('每轮为事件类型留痕，且同轮 delta 只记一次', async () => {
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[0];

    for (let turn = 1; turn <= 3; turn += 1) {
      upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      upstream.emit('message', JSON.stringify({ type: 'response.created' }));
      upstream.emit('message', JSON.stringify({ type: 'response.audio.delta', delta: `audio-${turn}-1` }));
      upstream.emit('message', JSON.stringify({ type: 'response.audio.delta', delta: `audio-${turn}-2` }));
      upstream.emit('message', JSON.stringify({ type: 'response.audio_transcript.done', transcript: `secret-${turn}` }));
    }

    const upstreamEventLogs = logger.info.mock.calls.filter(([message]) => message === 'upstream event');
    expect(upstreamEventLogs).toContainEqual(['upstream event', { turn: 3, type: 'input_audio_buffer.speech_started' }]);
    expect(upstreamEventLogs).toContainEqual(['upstream event', { turn: 3, type: 'response.created' }]);
    expect(upstreamEventLogs).toContainEqual(['upstream event', { turn: 3, type: 'response.audio.delta' }]);
    expect(upstreamEventLogs).toContainEqual(['upstream event', { turn: 3, type: 'response.audio_transcript.done' }]);
    expect(upstreamEventLogs.filter(([, data]) => data.turn === 3 && data.type === 'response.audio.delta')).toHaveLength(1);
    expect(JSON.stringify(upstreamEventLogs)).not.toContain('audio-3');
    expect(JSON.stringify(upstreamEventLogs)).not.toContain('secret-3');

    await handle.close();
  });

  // E1 fail-loud：空 transcript 不许静默走过去，日志要说清有没有兜回来。
  it('completed 空文本时打 warn，说明兜底有没有救回来', async () => {
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[0];

    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-nostash', transcript: '',
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      'user transcript empty on completed, falling back to delta stash',
      expect.objectContaining({ hasStash: false, recovered: false }),
    );
    await handle.close();
  });

  // R3（2026-07-30 真机 silenceMs=30225）：丢一拍就把整通电话判死。DashScope 的
  // pong 已实测支持（探针 40s 空闲 8/8 回 pong），所以单拍不回是丢包，不是死亡。
  it('丢一拍不杀通话，连丢三拍才报 UPSTREAM_ERROR 并 terminate socket', async () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ type: string; code?: string; message?: string }> = [];
      const connecting = qwenOmniTransport.connect({
        apiKey: 'test-key',
        config: { neoSessionId: 's1' },
        onEvent: (event) => events.push(event),
        onAudio: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await connecting;
      const upstream = upstreams[0];

      // 丢一拍、丢两拍：通话得活着
      await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS * 2);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(upstream.terminate).not.toHaveBeenCalled();

      // 第三拍还是没回音 = 这条链真死了
      await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS);

      expect(events).toContainEqual({
        type: 'error',
        code: 'UPSTREAM_ERROR',
        message: '上游连接已断开（长时间无响应）',
      });
      expect(upstream.terminate).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'upstream heartbeat timed out',
        expect.objectContaining({ silenceMs: VOICE_UPSTREAM_SILENCE_TIMEOUT_MS, missedBeats: 3 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('中途回一次 pong 就重新计时（长时间没话说不等于死了）', async () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ type: string }> = [];
      const connecting = qwenOmniTransport.connect({
        apiKey: 'test-key',
        config: { neoSessionId: 's1' },
        onEvent: (event) => events.push(event),
        onAudio: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await connecting;
      const upstream = upstreams[0];

      await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS * 2);
      upstream.emit('pong');
      await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS * 2);

      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(upstream.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('主动 close 后清掉心跳定时器，不再发送 ping', async () => {
    vi.useFakeTimers();
    try {
      const connecting = qwenOmniTransport.connect({
        apiKey: 'test-key',
        config: { neoSessionId: 's1' },
        onEvent: vi.fn(),
        onAudio: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const handle = await connecting;
      const upstream = upstreams[0];

      await handle.close();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(upstream.ping).not.toHaveBeenCalled();
      expect(upstream.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('任何 message 和 pong 都会刷新上游活跃时间', async () => {
    vi.useFakeTimers();
    try {
      const connecting = qwenOmniTransport.connect({
        apiKey: 'test-key',
        config: { neoSessionId: 's1' },
        onEvent: vi.fn(),
        onAudio: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const handle = await connecting;
      const upstream = upstreams[0];

      await vi.advanceTimersByTimeAsync(20_000);
      upstream.emit('message', 'not-json-but-still-a-signal');
      await vi.advanceTimersByTimeAsync(25_000);
      upstream.emit('pong');
      await vi.advanceTimersByTimeAsync(25_000);

      expect(upstream.terminate).not.toHaveBeenCalled();
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('session.updated 日志区分 tools 空数组和字段缺失', async () => {
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[0];

    upstream.emit('message', JSON.stringify({ type: 'session.updated', session: { tools: [] } }));
    upstream.emit('message', JSON.stringify({ type: 'session.updated', session: {} }));

    const echoes = logger.info.mock.calls.filter(([message]) => message === 'session.updated echo');
    expect(echoes).toContainEqual([
      'session.updated echo',
      expect.objectContaining({ toolsLength: 0 }),
    ]);
    expect(echoes).toContainEqual([
      'session.updated echo',
      expect.objectContaining({ toolsLength: null }),
    ]);

    await handle.close();
  });
});
