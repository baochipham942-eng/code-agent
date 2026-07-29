import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventHandler: null as null | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
  start: vi.fn(),
  writePlayback: vi.fn(),
  control: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventHandler = handler;
    return mocks.unlisten;
  }),
}));

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  startNativeVoiceAec: mocks.start,
  writeNativeVoiceAecPlayback: mocks.writePlayback,
  controlNativeVoiceAec: mocks.control,
  stopNativeVoiceAec: mocks.stop,
}));

import { NativeVoiceAudioPipeline } from '../../../src/renderer/services/nativeVoiceAudioPipeline';

describe('NativeVoiceAudioPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = null;
    mocks.start.mockResolvedValue({
      pid: 42,
      upstreamFifoPath: '/tmp/up',
      downstreamFifoPath: '/tmp/down',
      outputEvent: 'voice-aec:output',
    });
    mocks.writePlayback.mockResolvedValue(true);
    mocks.control.mockResolvedValue(true);
    mocks.stop.mockResolvedValue(true);
  });

  it('把原生上行 PCM 与双向电平投影回统一回调', async () => {
    const onFrame = vi.fn();
    const onLevels = vi.fn();
    const pipeline = new NativeVoiceAudioPipeline({ onFrame, onLevels });
    await pipeline.start();

    const pcm = new Int16Array([120, -240, 360]);
    const data = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
    mocks.eventHandler?.({ payload: { kind: 'audio', data } });
    mocks.eventHandler?.({ payload: { kind: 'levels', mic: 0.25, playback: 0.75 } });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(Array.from(onFrame.mock.calls[0][0] as Int16Array)).toEqual([120, -240, 360]);
    expect(onLevels).toHaveBeenCalledWith(0.25, 0.75);
    expect(pipeline.getMicLevel()).toBe(0.25);
  });

  it('把持久化 label 透传给原生 AEC 启动命令', async () => {
    const pipeline = new NativeVoiceAudioPipeline(
      { onFrame: vi.fn() },
      { label: 'Studio Mic', webDeviceId: 'web-only-id' },
    );

    await pipeline.start();

    expect(mocks.start).toHaveBeenCalledWith('Studio Mic');
  });

  it('下行、barge-in 与 PTT 门都走 Rust 控制通道', async () => {
    const pipeline = new NativeVoiceAudioPipeline({ onFrame: vi.fn() });
    await pipeline.start();

    pipeline.enqueuePlayback(new Int16Array([1, 2, 3]));
    await vi.waitFor(() => expect(mocks.writePlayback).toHaveBeenCalledTimes(1));

    pipeline.clearPlayback();
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledWith('clear'));

    pipeline.setCaptureOpen(false);
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledWith('mute'));
    pipeline.setCaptureOpen(true);
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledWith('unmute'));
  });

  it('sidecar 中途失败会 fail-loud 通知上层并在 stop 时解绑事件', async () => {
    const onError = vi.fn();
    const pipeline = new NativeVoiceAudioPipeline({ onFrame: vi.fn(), onError });
    await pipeline.start();

    mocks.eventHandler?.({ payload: { kind: 'error', message: 'killed' } });
    // 用户可见 code 归一成一条（四种挂法对用户是同一件事：原生回声消除没起来）；
    // 具体是哪一步走第二参数 detail，只供排查，不进 i18n 表。
    expect(onError).toHaveBeenCalledWith('NATIVE_AEC_FAILED', 'NATIVE_AEC_RUNTIME_FAILED');

    pipeline.stop();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalled();
  });
});
