import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent: Array<{ data: string | Buffer; options?: { binary?: boolean } }> = [];

  send(data: string | Buffer, options?: { binary?: boolean }) {
    this.sent.push({ data, options });
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.readyState = 3;
  }
}

const upstreams: FakeUpstream[] = [];
const logger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('ws', () => {
  class MockWebSocket extends FakeUpstream {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      super();
      upstreams.push(this);
      queueMicrotask(() => this.emit('open'));
    }
  }
  return { default: MockWebSocket };
});

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logger.warn, error: vi.fn(), debug: vi.fn() }),
}));

const { connectGummyRealtime } = await import('../../../../src/host/services/speech/gummyRealtimeTransport');

function emitEvent(upstream: FakeUpstream, event: object) {
  upstream.emit('message', JSON.stringify(event));
}

describe('Gummy realtime transport', () => {
  beforeEach(() => {
    upstreams.length = 0;
    vi.clearAllMocks();
  });

  it('task-started 前不推音频，开始后用二进制帧透传', async () => {
    const handle = await connectGummyRealtime({
      apiKey: 'test-key',
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const upstream = upstreams[0];
    const before = upstream.sent.length;

    handle.sendAudio(Buffer.from([1, 2, 3]));
    expect(upstream.sent).toHaveLength(before);

    emitEvent(upstream, { header: { event: 'task-started' }, payload: {} });
    handle.sendAudio(Buffer.from([4, 5, 6]));
    expect(upstream.sent.at(-1)).toMatchObject({
      data: Buffer.from([4, 5, 6]),
      options: { binary: true },
    });
    handle.close();
  });

  it('sentence_end false/true 分别映射 partial/final', async () => {
    const onTranscript = vi.fn();
    const handle = await connectGummyRealtime({
      apiKey: 'test-key',
      onTranscript,
      onError: vi.fn(),
    });
    const upstream = upstreams[0];

    emitEvent(upstream, {
      header: { event: 'result-generated' },
      payload: { output: { transcription: { sentence_id: 7, text: '你', sentence_end: false } } },
    });
    emitEvent(upstream, {
      header: { event: 'result-generated' },
      payload: { output: { transcription: { sentence_id: 7, text: '你好', sentence_end: true } } },
    });

    expect(onTranscript.mock.calls.map(([value]) => value)).toEqual([
      { text: '你', sentenceId: 7, done: false },
      { text: '你好', sentenceId: 7, done: true },
    ]);
    handle.close();
  });

  it('task-failed 把 error_message 传给错误出口和日志并关闭连接', async () => {
    const onError = vi.fn();
    await connectGummyRealtime({
      apiKey: 'test-key',
      onTranscript: vi.fn(),
      onError,
    });
    const upstream = upstreams[0];

    emitEvent(upstream, {
      header: { event: 'task-failed', error_code: 'COMMON_ERROR', error_message: '真实失败原因' },
      payload: {},
    });

    expect(onError).toHaveBeenCalledWith('COMMON_ERROR', '真实失败原因');
    expect(logger.warn).toHaveBeenCalledWith(
      'upstream task failed',
      expect.objectContaining({ code: 'COMMON_ERROR', message: '真实失败原因' }),
    );
    expect(upstream.readyState).toBe(3);
  });
});
