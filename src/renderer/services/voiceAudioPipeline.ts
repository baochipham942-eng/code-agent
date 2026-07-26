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

export interface VoiceAudioPipelineCallbacks {
  /** 一帧上行音频（PCM16@16k 单声道）；静音/门关闭时是零帧。 */
  onFrame: (pcm16k: Int16Array) => void;
  /** 双向电平（RMS，0..1 量级），100ms 节流。 */
  onLevels?: (mic: number, playback: number) => void;
  /** 采集失败（麦克风权限等），code 与 spike 口径一致。 */
  onError?: (code: string) => void;
}

export class VoiceAudioPipeline {
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

  constructor(private readonly callbacks: VoiceAudioPipelineCallbacks) {}

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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
      this.callbacks.onError?.(name === 'NotAllowedError' ? 'MICROPHONE_PERMISSION_DENIED' : name);
    }
  }

  stop(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processor = null;
    this.source = null;
    this.gain = null;
    this.stream?.getTracks().forEach((track) => track.stop());
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
