import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  connect: vi.fn(),
  sendAudio: vi.fn(),
  finish: vi.fn(async () => undefined),
  close: vi.fn(),
  onTranscript: null as null | ((event: { text: string; sentenceId: number; done: boolean }) => void),
  onError: null as null | ((code: string, message: string) => void),
}));

const key = vi.hoisted(() => ({ value: 'test-key' as string | null }));

vi.mock('../../../../src/host/services/media/imageGenerationService', () => ({
  getDashscopeApiKey: () => key.value,
}));
vi.mock('../../../../src/host/services/speech/gummyRealtimeTransport', () => ({
  connectGummyRealtime: transport.connect,
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { createCompanionDictationRelay, hasActiveCompanionDictation } = await import('../../../../src/host/services/speech/companionDictationRelay');
const { GUMMY_REALTIME_SAMPLE_RATE } = await import('../../../../src/shared/constants/voice');

describe('companionDictationRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    key.value = 'test-key';
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

  afterEach(() => {
    createCompanionDictationRelay().releaseAll();
  });

  it('open returns before the Gummy handshake so a 15s connect cannot blow the 10s LAN exchange', async () => {
    transport.connect.mockImplementationOnce(() => new Promise(() => {}));
    const port = createCompanionDictationRelay();
    await expect(port.open('device-1')).resolves.toMatchObject({ ok: true, sampleRate: GUMMY_REALTIME_SAMPLE_RATE });
    expect(hasActiveCompanionDictation()).toBe(true);
    port.release('device-1');
    expect(hasActiveCompanionDictation()).toBe(false);
  });

  it('refuses to open when Host has no DashScope key — phone must degrade, not hold a key', async () => {
    key.value = null;
    const port = createCompanionDictationRelay();
    await expect(port.open('device-1')).resolves.toEqual({ ok: false, code: 'SPEECH_NO_CHANNEL' });
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('forwards PCM and drains partial then final', async () => {
    const port = createCompanionDictationRelay();
    const opened = await port.open('device-1');
    expect(opened).toMatchObject({ ok: true, sampleRate: GUMMY_REALTIME_SAMPLE_RATE });
    if (!opened.ok) throw new Error('expected open');
    expect(hasActiveCompanionDictation()).toBe(true);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled());

    const pcm = Buffer.from([1, 0, 2, 0]);
    expect(port.audio('device-1', opened.streamId, pcm)).toEqual({ ok: true, events: [] });
    await vi.waitFor(() => expect(transport.sendAudio).toHaveBeenCalledWith(pcm));

    transport.onTranscript?.({ text: '你', sentenceId: 1, done: false });
    transport.onTranscript?.({ text: '你好', sentenceId: 1, done: true });
    expect(port.audio('device-1', opened.streamId, pcm)).toEqual({
      ok: true,
      events: [
        { type: 'partial', text: '你', sentenceId: 1 },
        { type: 'final', text: '你好', sentenceId: 1 },
      ],
    });

    await port.stop('device-1', opened.streamId);
    expect(transport.finish).toHaveBeenCalledTimes(1);
    expect(hasActiveCompanionDictation()).toBe(false);
  });

  it('queues an error event when the provider drops so the phone can degrade', async () => {
    const port = createCompanionDictationRelay();
    const opened = await port.open('device-1');
    if (!opened.ok) throw new Error('expected open');
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled());
    transport.onError?.('SPEECH_NO_CHANNEL', 'upstream closed');
    expect(port.audio('device-1', opened.streamId, Buffer.from([0, 0]))).toEqual({
      ok: true,
      events: [{ type: 'error', code: 'SPEECH_NO_CHANNEL', message: 'upstream closed' }],
    });
  });

  it('stop waits for a late handshake and flushes PCM buffered during connect', async () => {
    let releaseConnect: (() => void) | undefined;
    transport.connect.mockImplementationOnce(async (options: {
      onTranscript: typeof transport.onTranscript;
      onError: typeof transport.onError;
    }) => {
      await new Promise<void>(resolve => { releaseConnect = resolve; });
      transport.onTranscript = options.onTranscript;
      transport.onError = options.onError;
      return {
        sendAudio: transport.sendAudio,
        finish: transport.finish,
        close: transport.close,
      };
    });
    const port = createCompanionDictationRelay();
    const opened = await port.open('device-1');
    if (!opened.ok) throw new Error('expected open');
    const pcm = Buffer.from([1, 0, 2, 0]);
    expect(port.audio('device-1', opened.streamId, pcm)).toEqual({ ok: true, events: [] });
    expect(transport.sendAudio).not.toHaveBeenCalled();
    const stopping = port.stop('device-1', opened.streamId);
    releaseConnect?.();
    await stopping;
    expect(transport.sendAudio).toHaveBeenCalledWith(pcm);
    expect(transport.finish).toHaveBeenCalled();
  });

  it('release closes the upstream without waiting for finish', async () => {
    const port = createCompanionDictationRelay();
    await port.open('device-1');
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled());
    port.release('device-1');
    expect(transport.close).toHaveBeenCalled();
    expect(hasActiveCompanionDictation()).toBe(false);
  });
});
