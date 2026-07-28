import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
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
});
