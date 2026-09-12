import { useEffect, useRef, useState } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import { AppIcon } from '../../app/AppIcon';

/**
 * 失败必须带阶段和真实错误码：录音阶段（权限/插件/设备被占）与转写阶段（电脑没收到或没转出来）
 * 此前共用一句文案且丢掉 message，ALREADY_RECORDING / MICROPHONE_BEING_USED / 插件初始化失败
 * 在手机上长成同一句话，真机上无从定位（FB-140）。
 */
export type VoiceFailure = { stage: 'record' | 'transcribe'; reason: string };
export type VoicePhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'error';

type Audio = { audioData: string; mimeType: string; durationMs: number };

/** 录音状态机。UI 分两处落地（工具行的麦克风按钮、替换输入框的语音面板），所以状态不放在任一处。 */
export function useVoiceCapture({ recorder, pending, outcome, transcribe }: {
  recorder: PlatformPorts['recorder'];
  pending: boolean;
  outcome: 'done' | 'error' | null;
  transcribe(audio: Audio): Promise<void>;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const audio = useRef<Audio | null>(null);
  const active = useRef(false); const cancelled = useRef(false); const stopping = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedAt = useRef(0);
  const fail = (stage: VoiceFailure['stage'], error: unknown) => {
    setFailure({ stage, reason: error instanceof Error && error.message ? error.message : String(error) });
    setPhase('error');
  };
  const stop = async (discard = false) => {
    cancelled.current = discard;
    if (!active.current || stopping.current) return;
    stopping.current = true; clearTimeout(timer.current); setPhase('stopping');
    let stage: VoiceFailure['stage'] = 'record';
    try {
      const value = await recorder!.stop(); active.current = false;
      if (discard || cancelled.current) { audio.current = null; setPhase('idle'); return; }
      if (value.audioData.length > L.voiceBase64Limit) throw new Error('AUDIO_TOO_LARGE');
      audio.current = value; setPhase('ready'); stage = 'transcribe'; await transcribe(value);
    } catch (error) {
      // 丢弃路径上的失败不该报给用户：录音本来就不要了（切后台时原生侧可能已经自己收了摊，
      // 这时 stop 抛的是 RECORDING_HAS_NOT_STARTED，显示成「录音失败」是假警报）。
      if (discard || cancelled.current) { audio.current = null; setPhase('idle'); } else fail(stage, error);
    }
    finally { active.current = false; stopping.current = false; }
  };
  useEffect(() => {
    const hide = () => { if (document.hidden) void stop(true); };
    document.addEventListener('visibilitychange', hide);
    return () => { cancelled.current = true; clearTimeout(timer.current); document.removeEventListener('visibilitychange', hide); void stop(true); };
  }, [recorder]);
  useEffect(() => { if (outcome === 'done' && !pending) { audio.current = null; setFailure(null); setPhase('idle'); } }, [outcome, pending]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 500);
    return () => clearInterval(tick);
  }, [phase]);
  const start = async () => {
    if (!recorder) return;
    cancelled.current = false; audio.current = null; setFailure(null); setPhase('starting');
    startedAt.current = Date.now(); setElapsedMs(0);
    try {
      await recorder.start(); active.current = true;
      if (cancelled.current) { await stop(true); return; }
      setPhase('recording'); timer.current = setTimeout(() => { void stop(); }, L.voiceDurationMs);
    } catch (error) { fail('record', error); }
  };
  // 重试走的是同一个 transcribe，失败也必须留痕——否则这条路径又把错误吞回去。
  const retry = () => {
    if (!audio.current) { void start(); return; }
    setFailure(null);
    void transcribe(audio.current).catch(error => fail('transcribe', error));
  };
  const cancel = () => {
    if (active.current) void stop(true);
    else { cancelled.current = true; audio.current = null; setFailure(null); setPhase('idle'); }
  };
  return {
    phase, failure, elapsedMs,
    // 面板只在「正在录 / 正在转写」时替换输入框；失败按设计稿落在输入区上方，输入框要留给用户改字。
    panelOpen: phase !== 'idle' && phase !== 'error',
    start, stop: () => { void stop(); }, cancel, retry,
    dismissFailure: () => setFailure(null),
  };
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
// 设计稿 design.html 的 .waveform 就是 38 根 CSS 动画条。
// ponytail: 波形是「正在录」的动态示意，不是真实电平——录音插件不给 metering；
// 要接真实电平得先给 NeoVoiceRecorder.swift 加 averagePower 上报。
const BARS = Array.from({ length: 38 }, (_, i) => ({ height: 8 + (i * 17 % 27), delay: (i % 7) * 0.12 }));

/** 录音中的输入区：来源 → 状态与计时 → 识别文字 → 波形 → 控制行（停止键严格居中）。 */
export function VoicePanel({ text, phase, pending, elapsedMs, transcript, stop, cancel }: {
  text: ReturnType<typeof messages>;
  phase: VoicePhase; pending: boolean; elapsedMs: number; transcript: string;
  stop(): void; cancel(): void;
}) {
  const listening = phase === 'recording';
  return <>
    <div className="voice-source">{text.voiceSource}</div>
    <div className="voice-label" role="status">
      <span className="dot" aria-hidden="true" />
      {listening ? text.voiceListening : pending ? text.transcribing : text.loading}
      <span className="flex" /><span className="small">{clock(elapsedMs)}</span>
    </div>
    <div className="transcription">{transcript}{listening && <span className="caret" aria-hidden="true" />}</div>
    <div className="waveform" aria-hidden="true">
      {BARS.map((bar, i) => <i key={i} style={{ height: `${bar.height}px`, animationDelay: `${bar.delay}s` }} />)}
    </div>
    <div className="voice-controls">
      <button className="text-btn" aria-label={text.cancelRecording} disabled={phase === 'stopping' || pending} onClick={cancel}>{text.cancel}</button>
      {listening
        ? <button className="record-stop" onClick={stop} aria-label={text.stopRecording}><AppIcon name="stop" /></button>
        : <span className="record-stop-placeholder" aria-hidden="true" />}
      <span className="voice-control-spacer" aria-hidden="true" />
    </div>
  </>;
}
