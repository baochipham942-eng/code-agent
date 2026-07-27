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

  it('task-started 前不推音频而是缓冲，开始后先补发再透传（别吞掉第一个字）', async () => {
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
    // 缓冲的首帧必须补发出去，否则用户说的第一个字永远到不了上游
    expect(upstream.sent.at(-1)).toMatchObject({
      data: Buffer.from([1, 2, 3]),
      options: { binary: true },
    });

    handle.sendAudio(Buffer.from([4, 5, 6]));
    expect(upstream.sent.at(-1)).toMatchObject({
      data: Buffer.from([4, 5, 6]),
      options: { binary: true },
    });
    handle.close();
  });

  it('上游不回 task-finished 时 finish 会超时收尾并关连接（不让 UI 卡在识别中、不留计费连接）', async () => {
    vi.useFakeTimers();
    try {
      const handle = await connectGummyRealtime({
        apiKey: 'test-key',
        onTranscript: vi.fn(),
        onError: vi.fn(),
      });
      const upstream = upstreams[0];
      emitEvent(upstream, { header: { event: 'task-started' }, payload: {} });

      let settled = false;
      const pending = handle.finish().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(settled).toBe(true);
      expect(upstream.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('连接已断时 finish 立刻收尾，不等一帧永远不会来的 task-finished', async () => {
    const handle = await connectGummyRealtime({
      apiKey: 'test-key',
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const upstream = upstreams[0];
    emitEvent(upstream, { header: { event: 'task-started' }, payload: {} });
    upstream.readyState = 3; // 上游没发 close 事件就没了（网络掉线）

    await expect(handle.finish()).resolves.toBeUndefined();
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
