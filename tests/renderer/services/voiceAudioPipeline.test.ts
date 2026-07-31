// @vitest-environment jsdom
// VoiceAudioPipeline 的麦克风竞态门（现象 12 · 隐私面）：
// start() 的 getUserMedia 还在 pending 时调用 stop()，拿到的 track 必须被 stop——
// 否则那次 stop 是空操作，麦克风一路开到 app 退出。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import type { VoiceInputDeviceSettings } from '../../../src/shared/contract/settings';
import {
  readPreferredVoiceInputAvailability,
  resolveVoiceInputDevice,
  VoiceAudioPipeline,
} from '../../../src/renderer/services/voiceAudioPipeline';

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

function installMediaDevices(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  enumerateDevices: () => Promise<MediaDeviceInfo[]>,
) {
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia,
    enumerateDevices,
  };
}

function audioInput(
  deviceId: string,
  label: string,
): Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'> {
  return { deviceId, kind: 'audioinput', label };
}

function makePipeline(inputDevice?: VoiceInputDeviceSettings) {
  return new VoiceAudioPipeline({ onFrame: () => {} }, inputDevice);
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

describe('VoiceAudioPipeline 输入设备解析', () => {
  const preference = { label: 'Studio Mic', webDeviceId: 'cached-id' };

  it('webDeviceId 仍存在时优先命中缓存', () => {
    expect(resolveVoiceInputDevice(preference, [
      audioInput('label-id', 'Studio Mic'),
      audioInput('cached-id', 'Other Mic'),
    ])).toEqual({ match: 'webDeviceId', deviceId: 'cached-id' });
  });

  it('webDeviceId 失效时按 label 重解析', () => {
    expect(resolveVoiceInputDevice(preference, [
      audioInput('fresh-id', 'Studio Mic'),
    ])).toEqual({ match: 'label', deviceId: 'fresh-id' });
  });

  it('缓存与 label 全失效时明确回落系统默认', () => {
    expect(resolveVoiceInputDevice(preference, [
      audioInput('built-in', 'MacBook Microphone'),
    ])).toEqual({ match: 'default' });
  });

  it('命中设备后把 ideal deviceId 写进 getUserMedia 约束', async () => {
    const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => fakeStream([]));
    installMediaDevices(
      getUserMedia,
      async () => [audioInput('fresh-id', 'Studio Mic') as MediaDeviceInfo],
    );

    await makePipeline(preference).start();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { ideal: 'fresh-id' },
      }),
    });
  });

  it('设备枚举失败仍调用系统默认麦克风，不让通话失效', async () => {
    const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => fakeStream([]));
    installMediaDevices(
      getUserMedia,
      async () => {
        throw new Error('device service unavailable');
      },
    );

    await makePipeline(preference).start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0];
    expect((constraints.audio as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it('枚举后指定设备在开流前失效时，再试一次系统默认', async () => {
    const preferredFailure = Object.assign(new Error('device disappeared'), { name: 'NotFoundError' });
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(preferredFailure)
      .mockResolvedValueOnce(fakeStream([]));
    installMediaDevices(
      getUserMedia,
      async () => [audioInput('fresh-id', 'Studio Mic') as MediaDeviceInfo],
    );

    await makePipeline(preference).start();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect((getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints).deviceId)
      .toEqual({ ideal: 'fresh-id' });
    expect((getUserMedia.mock.calls[1][0].audio as MediaTrackConstraints).deviceId)
      .toBeUndefined();
  });

  it('设备可用性读取失败返回 unknown，不把瞬时错误当成拔出', async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => {
        throw new Error('temporary failure');
      }),
    } as unknown as MediaDevices;

    await expect(readPreferredVoiceInputAvailability(preference, mediaDevices)).resolves.toBeNull();
  });

  it('设备恢复后按 label 识别为可用', async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        audioInput('new-id', 'Studio Mic') as MediaDeviceInfo,
      ]),
    } as unknown as MediaDevices;

    await expect(readPreferredVoiceInputAvailability(preference, mediaDevices)).resolves.toBe(true);
  });
});
