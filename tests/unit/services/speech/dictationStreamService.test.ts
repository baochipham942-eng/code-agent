import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  connect: vi.fn(),
  sendAudio: vi.fn(),
  finish: vi.fn(async () => undefined),
  close: vi.fn(),
  onTranscript: null as null | ((event: { text: string; sentenceId: number; done: boolean }) => void),
  onError: null as null | ((code: string, message: string) => void),
}));

vi.mock('../../../../src/host/services/media/imageGenerationService', () => ({
  getDashscopeApiKey: () => 'test-key',
}));
vi.mock('../../../../src/host/services/speech/gummyRealtimeTransport', () => ({
  connectGummyRealtime: transport.connect,
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { attachDictationClient } = await import('../../../../src/host/services/speech/dictationStreamService');

class FakeClient extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function events(client: FakeClient) {
  return client.sent.map((raw) => JSON.parse(raw) as {
    type: string;
    text?: string;
    sentenceId?: number;
  });
}

describe('dictationStreamService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.onTranscript = null;
    transport.onError = null;
    transport.connect.mockImplementation(async (options: {
      onTranscript: typeof transport.onTranscript;
      onError: typeof transport.onError;
    }) => {
      transport.onTranscript = options.onTranscript;
      transport.onError = options.onError;
      return {
        sendAudio: transport.sendAudio,
        finish: transport.finish,
        close: transport.close,
      };
    });
  });

  it('客户端二进制帧透传到上游', async () => {
    const client = new FakeClient();
    await attachDictationClient(client as never);

    client.emit('message', Buffer.from([1, 2, 3]), true);

    expect(transport.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it('上游 partial/final 结果按文本帧发回客户端', async () => {
    const client = new FakeClient();
    await attachDictationClient(client as never);

    transport.onTranscript?.({ text: '你', sentenceId: 1, done: false });
    transport.onTranscript?.({ text: '你好', sentenceId: 1, done: true });

    expect(events(client)).toEqual([
      { type: 'partial', text: '你', sentenceId: 1 },
      { type: 'final', text: '你好', sentenceId: 1 },
    ]);
  });

  it('客户端断开时关闭上游', async () => {
    const client = new FakeClient();
    await attachDictationClient(client as never);

    client.close();

    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('客户端在上游建连过程中断开时立即取消握手', async () => {
    transport.connect.mockImplementationOnce((options: { signal: AbortSignal }) => (
      new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('Gummy realtime connection cancelled')),
          { once: true },
        );
      })
    ));
    const client = new FakeClient();
    const attaching = attachDictationClient(client as never);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(1));
    const options = transport.connect.mock.calls[0][0] as { signal: AbortSignal; streamId: string };

    client.close();
    await attaching;

    expect(options.signal.aborted).toBe(true);
    expect(options.streamId).toBeTruthy();
  });
});
