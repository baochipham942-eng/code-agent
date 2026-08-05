// ============================================================================
// macOS 原生 AEC 管线
//
// Rust/Tauri 持有 TCC 权限并 spawn Swift sidecar。Renderer 只消费归一化事件、
// 把上行继续送现有 voice WS，并把下行 PCM / clear / mute 控制送回原生播放链。
// ============================================================================

import {
  VOICE_AEC_BASE64_CHUNK_BYTES,
  VOICE_AEC_OUTPUT_EVENT,
} from '@shared/constants/voice';
import type { VoiceInputDeviceSettings } from '@shared/contract/settings';
import {
  controlNativeVoiceAec,
  startNativeVoiceAec,
  stopNativeVoiceAec,
  writeNativeVoiceAecPlayback,
} from './nativeDesktop';
import { listenTauriEvent, type TauriUnlisten } from './tauriPluginFacade';
import { createLogger } from '../utils/logger';
import type { VoiceAudioPipelineCallbacks, VoiceAudioPipelineLike } from './voiceAudioPipeline';

const logger = createLogger('NativeVoiceAec');

interface NativeVoiceAecEvent {
  kind: 'audio' | 'levels' | 'error' | 'diagnostic';
  data?: string;
  mic?: number;
  playback?: number;
  message?: string;
}

function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += VOICE_AEC_BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + VOICE_AEC_BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function base64ToPcm(value: string): Int16Array {
  const binary = atob(value);
  if (binary.length % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('Native AEC emitted an odd-length PCM frame');
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(buffer);
}

export class NativeVoiceAudioPipeline implements VoiceAudioPipelineLike {
  private unlisten: TauriUnlisten | null = null;
  private started = false;
  private stopped = false;
  private failed = false;
  private muted = false;
  private captureOpen = true;
  private effectiveMuted = false;
  private micLevel = 0;
  private playbackGeneration = 0;
  private playbackWrites: Promise<void> = Promise.resolve();
  private controlWrites: Promise<void> = Promise.resolve();
  private pendingDiagnostics: string[] = [];

  constructor(
    private readonly callbacks: VoiceAudioPipelineCallbacks,
    private readonly inputDevice?: VoiceInputDeviceSettings,
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.syncCaptureGate();
  }

  setCaptureOpen(open: boolean): void {
    this.captureOpen = open;
    this.syncCaptureGate();
  }

  getMicLevel(): number {
    return this.micLevel;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.failed = false;
    this.unlisten = await listenTauriEvent<NativeVoiceAecEvent>(
      VOICE_AEC_OUTPUT_EVENT,
      ({ payload }) => this.handleEvent(payload),
    );
    try {
      const result = await startNativeVoiceAec(this.inputDevice?.label);
      if (result.outputEvent !== VOICE_AEC_OUTPUT_EVENT) {
        throw new Error(`Unexpected native AEC event: ${result.outputEvent}`);
      }
      this.started = true;
      for (const code of this.pendingDiagnostics.splice(0)) {
        this.callbacks.onDiagnostic?.(code);
      }
      this.syncCaptureGate(true);
    } catch (error) {
      this.unlisten?.();
      this.unlisten = null;
      void stopNativeVoiceAec().catch(() => undefined);
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.playbackGeneration += 1;
    this.playbackWrites = Promise.resolve();
    this.controlWrites = Promise.resolve();
    this.unlisten?.();
    this.unlisten = null;
    this.micLevel = 0;
    this.pendingDiagnostics = [];
    void stopNativeVoiceAec().catch(() => undefined);
  }

  enqueuePlayback(pcm24k: Int16Array): void {
    if (!this.started || this.stopped || pcm24k.length === 0) return;
    const generation = this.playbackGeneration;
    const data = pcmToBase64(pcm24k);
    this.playbackWrites = this.playbackWrites
      .then(async () => {
        if (this.stopped || generation !== this.playbackGeneration) return;
        await writeNativeVoiceAecPlayback(data);
        this.callbacks.onPlaybackStarted?.();
      })
      .catch(() => this.fail('NATIVE_AEC_PLAYBACK_FAILED'));
  }

  clearPlayback(): void {
    if (!this.started || this.stopped) return;
    this.playbackGeneration += 1;
    this.playbackWrites = Promise.resolve();
    void controlNativeVoiceAec('clear').catch(() => this.fail('NATIVE_AEC_CONTROL_FAILED'));
  }

  private syncCaptureGate(force = false): void {
    const nextMuted = this.muted || !this.captureOpen;
    if (!force && nextMuted === this.effectiveMuted) return;
    this.effectiveMuted = nextMuted;
    if (!this.started || this.stopped) return;
    const command = nextMuted ? 'mute' : 'unmute';
    this.controlWrites = this.controlWrites
      .then(async () => {
        if (!this.stopped) await controlNativeVoiceAec(command);
      })
      .catch(() => this.fail('NATIVE_AEC_CONTROL_FAILED'));
  }

  private audioEvents = 0;

  private handleEvent(event: NativeVoiceAecEvent): void {
    if (this.stopped) return;
    if (event.kind === 'audio' && event.data) {
      try {
        const pcm = base64ToPcm(event.data);
        // 采集链探针：首帧 + 每 200 帧记幅值峰值——事件腿断/静音/正常在日志里必须可分辨。
        this.audioEvents += 1;
        if (this.audioEvents === 1 || this.audioEvents % 200 === 0) {
          let peak = 0;
          for (let i = 0; i < pcm.length; i += 1) {
            const v = Math.abs(pcm[i]);
            if (v > peak) peak = v;
          }
          logger.info('native aec capture frame', { frames: this.audioEvents, samples: pcm.length, peak });
        }
        this.callbacks.onFrame(pcm);
      } catch {
        this.fail('NATIVE_AEC_CAPTURE_FAILED');
      }
      return;
    }
    if (event.kind === 'levels') {
      const mic = typeof event.mic === 'number' ? event.mic : 0;
      const playback = typeof event.playback === 'number' ? event.playback : 0;
      this.micLevel = mic;
      this.callbacks.onLevels?.(mic, playback);
      return;
    }
    if (event.kind === 'diagnostic' && event.message) {
      if (this.started) this.callbacks.onDiagnostic?.(event.message);
      else this.pendingDiagnostics.push(event.message);
      return;
    }
    if (event.kind === 'error' && this.started) {
      this.fail('NATIVE_AEC_RUNTIME_FAILED');
    }
  }

  /**
   * 原生 AEC 的四种挂法（播放/控制/采集/运行时）对用户是同一件事——「原生回声消除没起来」。
   * 所以只发一个用户可见 code，具体哪一步走 detail 供排查：给用户看四种说法没有意义，
   * 而每种都进 i18n 表则是把内部实现细节抬成了产品文案。
   */
  private fail(stage: string): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.callbacks.onError?.('NATIVE_AEC_FAILED', stage);
  }
}
