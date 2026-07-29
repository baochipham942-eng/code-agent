// ============================================================================
// 实时语音的浏览器侧音频管线（框架无关版，Phase 1 批 B）
//
// 由 Phase 0 的 useRealtimeVoiceAudio hook 改写：hook 形态把管线寿命绑在组件上，
// 通话要跨组件（入口按钮 / VoiceChrome / 字幕行）共享，所以改成模块级 class，
// 由 voiceCallBridge 持有。采集/重采样/播放的数学与 spike 完全一致。
//
// 采集：getUserMedia → 重采样到 16k → Int16 帧回调
// 播放：24k PCM16 无缝排队播放，支持 barge-in 清空
// 静音/PTT 门：不可听时改发静音帧而不是停发——server_vad 要持续推流才会发
// speech_stopped（§13.3 第 4 条），停发会把一轮对话吊死在中途。
// ============================================================================

import { VOICE_DOWNSTREAM_SAMPLE_RATE, VOICE_UPSTREAM_SAMPLE_RATE } from '@shared/constants/voice';
import type { VoiceInputDeviceSettings } from '@shared/contract/settings';
import type { VoiceMessageCode } from '@shared/contract/voice';
import { normalizeVoiceInputDevice } from '@shared/voiceInputDevice';
import { createLogger } from '../utils/logger';

const logger = createLogger('VoiceAudioPipeline');

/** 实例自增 id：getUserMedia 成功 / track.stop 的日志带它，事后配对检查谁漏了 stop。 */
let nextPipelineId = 1;

/** 跨回调保留的小数读取位置，避免缓冲区边界处的漂移与咔哒声。 */
export interface ResampleState {
  pos: number;
}

/**
 * 线性插值降采样到 16k 并转 Int16。
 * 导出供单测钉住重采样数学。
 */
export function resampleTo16k(input: Float32Array, inRate: number, state: ResampleState): Int16Array {
  const ratio = inRate / VOICE_UPSTREAM_SAMPLE_RATE;
  const out: number[] = [];
  let pos = state.pos;
  while (pos < input.length) {
    const i = Math.floor(pos);
    const frac = pos - i;
    // 末样本没有插值伙伴时退化为最近邻，保证 pos 不会停在 length 之前——
    // 否则结转的 state.pos 会是负数，下一块首次取样就落到 input[-1]。
    const next = i + 1 < input.length ? input[i + 1] : i;
    const sample = input[i] * (1 - frac) + next * frac;
    out.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
    pos += ratio;
  }
  // 余量跨到下一块继续，保持连续；恒为 [0, ratio)
  state.pos = pos - input.length;
  return Int16Array.from(out);
}

const CAPTURE_BUFFER_SIZE = 4096;
const LEVEL_UPDATE_INTERVAL_MS = 100;

const DEFAULT_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

type VoiceInputDeviceMatch = 'webDeviceId' | 'label' | 'default';

export interface VoiceInputDeviceResolution {
  match: VoiceInputDeviceMatch;
  deviceId?: string;
}

/**
 * 纯设备解析：缓存 id 优先，缓存失效再按跨采集链共用的 label 找，最后明确回默认。
 */
export function resolveVoiceInputDevice(
  preference: VoiceInputDeviceSettings,
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
): VoiceInputDeviceResolution {
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  if (preference.webDeviceId) {
    const cached = inputs.find((device) => device.deviceId === preference.webDeviceId);
    if (cached) return { match: 'webDeviceId', deviceId: cached.deviceId };
  }
  const named = inputs.find((device) => device.label === preference.label);
  if (named) return { match: 'label', deviceId: named.deviceId };
  return { match: 'default' };
}

/**
 * 三个 Web 开麦点共用的约束入口。枚举失败、设备被拔掉或配置损坏都 fail-open
 * 到系统默认；只有确认设备仍存在时才附加 ideal deviceId。
 */
export async function resolveVoiceAudioCaptureConstraints(
  configured: unknown,
  baseConstraints: MediaTrackConstraints = DEFAULT_CAPTURE_CONSTRAINTS,
  mediaDevices: MediaDevices = navigator.mediaDevices,
): Promise<MediaTrackConstraints> {
  const preference = normalizeVoiceInputDevice(configured);
  if (!preference) return { ...baseConstraints };

  let devices: MediaDeviceInfo[];
  try {
    if (typeof mediaDevices.enumerateDevices !== 'function') {
      throw new Error('enumerateDevices is unavailable');
    }
    devices = await mediaDevices.enumerateDevices();
  } catch (error) {
    logger.warn('input device enumeration failed; using system default', {
      label: preference.label,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...baseConstraints };
  }

  const resolution = resolveVoiceInputDevice(preference, devices);
  if (!resolution.deviceId) {
    logger.warn('configured input device unavailable; using system default', {
      label: preference.label,
    });
    return { ...baseConstraints };
  }
  logger.info('input device resolved', {
    label: preference.label,
    match: resolution.match,
  });
  return {
    ...baseConstraints,
    deviceId: { ideal: resolution.deviceId },
  };
}

export interface VoiceAudioPipelineCallbacks {
  /** 一帧上行音频（PCM16@16k 单声道）；静音/门关闭时是零帧。 */
  onFrame: (pcm16k: Int16Array) => void;
  /** 双向电平（RMS，0..1 量级），100ms 节流。 */
  onLevels?: (mic: number, playback: number) => void;
  /** 采集失败（麦克风权限等）。code 是可枚举的用户文案编号；detail 是原始异常名，只供排查。 */
  onError?: (code: VoiceMessageCode, detail?: string) => void;
}

/** WebView 与原生 AEC 管线共同向 voiceCallBridge 暴露的最小合同。 */
export interface VoiceAudioPipelineLike {
  setMuted(muted: boolean): void;
  setCaptureOpen(open: boolean): void;
  getMicLevel(): number;
  start(): Promise<void>;
  stop(): void;
  enqueuePlayback(pcm24k: Int16Array): void;
  clearPlayback(): void;
}

export class VoiceAudioPipeline implements VoiceAudioPipelineLike {
  private stream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private resampleState: ResampleState = { pos: 0 };

  private playbackCtx: AudioContext | null = null;
  private nextStart = 0;
  private scheduled: AudioBufferSourceNode[] = [];

  private muted = false;
  /** PTT/手动模式的采集门：关 = 发静音帧。 */
  private captureOpen = true;

  private micLevel = 0;
  private playbackLevel = 0;
  private lastLevelAt = 0;

  private readonly instanceId = nextPipelineId++;
  /**
   * stop() 置位。start() 的 getUserMedia 还在 pending 时被 stop 的话，那次 stop
   * 是空操作（this.stream 还是 null），随后拿到的 stream 再没人停 ⇒ 麦克风常开。
   * start() 在 await 之后复查本标志，已 disposed 就立刻停掉刚拿到的 stream。
   */
  private disposed = false;

  constructor(
    private readonly callbacks: VoiceAudioPipelineCallbacks,
    private readonly inputDevice?: VoiceInputDeviceSettings,
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setCaptureOpen(open: boolean): void {
    this.captureOpen = open;
  }

  getMicLevel(): number {
    return this.micLevel;
  }

  async start(): Promise<void> {
    this.disposed = false;
    try {
      // 无设备偏好时保持原来的同步 getUserMedia 起步时序；额外的 await 会让
      // start() 后立刻 stop() 的竞态窗口前移，破坏既有隐私回归测试。
      const audio = this.inputDevice
        ? await resolveVoiceAudioCaptureConstraints(this.inputDevice)
        : { ...DEFAULT_CAPTURE_CONSTRAINTS };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio,
      });
      logger.info('getUserMedia acquired', { pipelineId: this.instanceId, tracks: stream.getTracks().length });
      // await 期间被 stop() 了：刚拿到的 stream 无人持有，必须就地停掉并返回。
      if (this.disposed) {
        logger.warn('disposed during getUserMedia, stopping acquired stream', { pipelineId: this.instanceId });
        this.stopStreamTracks(stream);
        return;
      }
      this.stream = stream;

      // 不强制 sampleRate：macOS 上通常是 48000，由 resampleTo16k 按 ctx 实际速率降采样。
      const ctx = new AudioContext();
      this.captureCtx = ctx;
      const source = ctx.createMediaStreamSource(stream);
      this.source = source;

      // ponytail: ScriptProcessorNode 已废弃但零构建开销；若主线程卡顿再换 AudioWorklet。
      const processor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
      this.processor = processor;
      // 零增益接到 destination：只为让节点持续被泵，不把麦克风回放到扬声器。
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.gain = gain;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const audible = !this.muted && this.captureOpen;
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);

        if (audible) {
          this.callbacks.onFrame(resampleTo16k(input, ctx.sampleRate, this.resampleState));
        } else {
          // 门关闭也要维持推流节奏：发等长零帧（server_vad 靠持续流判断句）。
          this.callbacks.onFrame(new Int16Array(resampleTo16k(input, ctx.sampleRate, this.resampleState).length));
        }

        const now = Date.now();
        if (now - this.lastLevelAt >= LEVEL_UPDATE_INTERVAL_MS) {
          this.lastLevelAt = now;
          this.micLevel = audible ? rms : 0;
          this.callbacks.onLevels?.(this.micLevel, this.playbackLevel);
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      // 非权限类一律归一成 AUDIO_CAPTURE_FAILED：原来直接把 DOMException.name 当 code 抛出去，
      // 那是个无法枚举的集合，进不了 i18n 表，用户只会看到一个英文异常名（如 NotReadableError）。
      // 真名通过 detail 带走供排查，不进用户可见文案。
      this.callbacks.onError?.(
        name === 'NotAllowedError' ? 'MICROPHONE_PERMISSION_DENIED' : 'AUDIO_CAPTURE_FAILED',
        name,
      );
    }
  }

  stop(): void {
    this.disposed = true;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processor = null;
    this.source = null;
    this.gain = null;
    if (this.stream) this.stopStreamTracks(this.stream);
    this.stream = null;
    void this.captureCtx?.close().catch(() => undefined);
    this.captureCtx = null;
    void this.playbackCtx?.close().catch(() => undefined);
    this.playbackCtx = null;
    this.scheduled = [];
    this.nextStart = 0;
    this.resampleState = { pos: 0 };
    this.micLevel = 0;
    this.playbackLevel = 0;
  }

  /** 逐 track stop 并记日志（与 getUserMedia acquired 配对）。 */
  private stopStreamTracks(stream: MediaStream): void {
    stream.getTracks().forEach((track) => {
      track.stop();
      logger.info('track stopped', { pipelineId: this.instanceId, kind: track.kind, trackId: track.id });
    });
  }

  enqueuePlayback(pcm24k: Int16Array): void {
    if (pcm24k.length === 0) return;
    const ctx = this.playbackCtx ?? new AudioContext();
    this.playbackCtx = ctx;

    const buffer = ctx.createBuffer(1, pcm24k.length, VOICE_DOWNSTREAM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm24k.length; i += 1) {
      channel[i] = pcm24k[i] / 32768;
      sum += channel[i] * channel[i];
    }
    // 输出电平跟随最新帧（不用平均：助手停口时电平应立刻回落）。
    this.playbackLevel = Math.sqrt(sum / pcm24k.length);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    if (this.nextStart < ctx.currentTime) this.nextStart = ctx.currentTime;
    node.start(this.nextStart);
    this.nextStart += buffer.duration;
    this.scheduled.push(node);
    node.onended = () => {
      this.scheduled = this.scheduled.filter((n) => n !== node);
      if (this.scheduled.length === 0) this.playbackLevel = 0;
    };
  }

  /** barge-in：用户开口就掐掉正在播的回答。 */
  clearPlayback(): void {
    this.scheduled.forEach((node) => {
      try {
        node.stop();
      } catch {
        // 已经结束的 source 再 stop 会抛，忽略
      }
    });
    this.scheduled = [];
    this.nextStart = this.playbackCtx?.currentTime ?? 0;
    this.playbackLevel = 0;
  }
}
