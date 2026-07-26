// ============================================================================
// 实时语音的浏览器侧音频管线
// 采集：getUserMedia → 重采样到 16k → Int16 帧回调
// 播放：24k PCM16 无缝排队播放，支持 barge-in 清空
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_DOWNSTREAM_SAMPLE_RATE, VOICE_UPSTREAM_SAMPLE_RATE } from '@shared/constants';

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
    const next = i + 1 < input.length ? input[i + 1] : input[i];
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

export function useRealtimeVoiceAudio() {
  const streamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const resampleStateRef = useRef<ResampleState>({ pos: 0 });
  const framesRef = useRef(0);
  const lastLevelAtRef = useRef(0);

  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);

  const [micLevel, setMicLevel] = useState(0);
  const [framesSent, setFramesSent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    gainRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void captureCtxRef.current?.close().catch(() => undefined);
    captureCtxRef.current = null;
    void playbackCtxRef.current?.close().catch(() => undefined);
    playbackCtxRef.current = null;
    scheduledRef.current = [];
    nextStartRef.current = 0;
    resampleStateRef.current = { pos: 0 };
    framesRef.current = 0;
    setMicLevel(0);
    setFramesSent(0);
  }, []);

  const start = useCallback(
    async (onFrame: (pcm16k: Int16Array) => void): Promise<void> => {
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;

        // 不强制 sampleRate：macOS 上通常是 48000，由 resampleTo16k 按 ctx 实际速率降采样。
        const ctx = new AudioContext();
        captureCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;

        // ponytail: ScriptProcessorNode 已废弃但零构建开销；若主线程卡顿再换 AudioWorklet。
        const processor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
        processorRef.current = processor;
        // 零增益接到 destination：只为让节点持续被泵，不把麦克风回放到扬声器。
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gainRef.current = gain;

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          onFrame(resampleTo16k(input, ctx.sampleRate, resampleStateRef.current));
          framesRef.current += 1;

          const now = Date.now();
          if (now - lastLevelAtRef.current >= LEVEL_UPDATE_INTERVAL_MS) {
            lastLevelAtRef.current = now;
            let sum = 0;
            for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
            setMicLevel(Math.sqrt(sum / input.length));
            setFramesSent(framesRef.current);
          }
        };

        source.connect(processor);
        processor.connect(gain);
        gain.connect(ctx.destination);
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        setError(name === 'NotAllowedError' ? 'MICROPHONE_PERMISSION_DENIED' : name);
      }
    },
    [],
  );

  const enqueuePlayback = useCallback((pcm24k: Int16Array) => {
    if (pcm24k.length === 0) return;
    const ctx = playbackCtxRef.current ?? new AudioContext();
    playbackCtxRef.current = ctx;

    const buffer = ctx.createBuffer(1, pcm24k.length, VOICE_DOWNSTREAM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm24k.length; i += 1) channel[i] = pcm24k[i] / 32768;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    if (nextStartRef.current < ctx.currentTime) nextStartRef.current = ctx.currentTime;
    node.start(nextStartRef.current);
    nextStartRef.current += buffer.duration;
    scheduledRef.current.push(node);
    node.onended = () => {
      scheduledRef.current = scheduledRef.current.filter((n) => n !== node);
    };
  }, []);

  const clearPlayback = useCallback(() => {
    scheduledRef.current.forEach((node) => {
      try {
        node.stop();
      } catch {
        // 已经结束的 source 再 stop 会抛，忽略
      }
    });
    scheduledRef.current = [];
    nextStartRef.current = playbackCtxRef.current?.currentTime ?? 0;
  }, []);

  useEffect(() => stop, [stop]);

  return { start, stop, enqueuePlayback, clearPlayback, micLevel, framesSent, error };
}
