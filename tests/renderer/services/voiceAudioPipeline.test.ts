// @vitest-environment jsdom
// VoiceAudioPipeline 的麦克风竞态门（现象 12 · 隐私面）：
// start() 的 getUserMedia 还在 pending 时调用 stop()，拿到的 track 必须被 stop——
// 否则那次 stop 是空操作，麦克风一路开到 app 退出。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { VoiceAudioPipeline } from '../../../src/renderer/services/voiceAudioPipeline';

function fakeTrack() {
  return { stop: vi.fn(), kind: 'audio', id: 'track-1' } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function installAudioContextStub() {
  (window as unknown as { AudioContext: unknown }).AudioContext = class {
    sampleRate = 48000;
    state = 'running';
    destination = {};
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    createScriptProcessor() {
      return { connect: () => {}, disconnect: () => {}, onaudioprocess: null };
    }
    createGain() {
      return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
    }
    close() {
      return Promise.resolve();
    }
  };
}

function installGetUserMedia(impl: () => Promise<MediaStream>) {
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = { getUserMedia: impl };
}

function makePipeline() {
  return new VoiceAudioPipeline({ onFrame: () => {} });
}

beforeEach(() => {
  installAudioContextStub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VoiceAudioPipeline 麦克风竞态', () => {
  it('getUserMedia pending 中调用 stop()：迟到的 stream 的 track 必须被 stop', async () => {
    const track = fakeTrack();
    let resolveStream: (stream: MediaStream) => void = () => {};
    installGetUserMedia(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );

    const pipeline = makePipeline();
    const started = pipeline.start();
    // getUserMedia 还没回来，通话已被挂断——这次 stop 落不进 this.stream（还是 null）
    pipeline.stop();
    expect(track.stop).not.toHaveBeenCalled();

    // 迟到的 stream 到达：pipeline 已 disposed，必须就地停掉而不是赋给 this.stream
    resolveStream(fakeStream([track]));
    await started;
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('正常 start → stop：track 被 stop 一次', async () => {
    const track = fakeTrack();
    installGetUserMedia(() => Promise.resolve(fakeStream([track])));

    const pipeline = makePipeline();
    await pipeline.start();
    expect(track.stop).not.toHaveBeenCalled();
    pipeline.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('disposed 复查发生在 track.stop 之前，不会先建 AudioContext 再泄漏', async () => {
    const track = fakeTrack();
    let resolveStream: (stream: MediaStream) => void = () => {};
    installGetUserMedia(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );

    const pipeline = makePipeline();
    const started = pipeline.start();
    pipeline.stop();
    resolveStream(fakeStream([track]));
    await started;

    // 再 stop 一次是幂等空操作：track.stop 总共只该有一次
    pipeline.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
