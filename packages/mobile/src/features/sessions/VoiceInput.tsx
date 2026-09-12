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
type VoiceFailure = { stage: 'record' | 'transcribe'; reason: string };

export function VoiceInput({ recorder, text, disabled, pending, outcome, transcribe }: {
  recorder: NonNullable<PlatformPorts['recorder']>; text: ReturnType<typeof messages>; disabled: boolean; pending: boolean;
  outcome: 'done' | 'error' | null;
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }): Promise<void>;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'error'>('idle');
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const audio = useRef<Awaited<ReturnType<typeof recorder.stop>> | null>(null);
  const active = useRef(false); const cancelled = useRef(false); const stopping = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      const value = await recorder.stop(); active.current = false;
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
  const start = async () => {
    cancelled.current = false; audio.current = null; setFailure(null); setPhase('starting');
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
  const notice = failure?.reason === 'MICROPHONE_DENIED' ? text.microphoneDenied
    : failure ? `${failure.stage === 'record' ? text.voiceRecordFailed : text.voiceTranscribeFailed} · ${failure.reason}`
    : text.voiceTranscribeFailed;
  if (phase === 'idle') return <button aria-label={text.voice} disabled={disabled} onClick={() => void start()}><AppIcon name="mic" /></button>;
  return <div className="voice-card" role="status">
    <button aria-label={text.cancelRecording} disabled={phase === 'stopping' || pending} onClick={() => { if (active.current) void stop(true); else { cancelled.current = true; audio.current = null; setPhase('idle'); } }}><AppIcon name="close" /></button>
    {phase === 'recording' ? <button className="recording-stop" onClick={() => void stop()} aria-label={text.stopRecording}><AppIcon name="stop" /></button> : <span>{pending ? text.transcribing : phase === 'starting' || phase === 'stopping' ? text.loading : notice}</span>}
    {phase === 'error' || (phase === 'ready' && !pending) ? <button disabled={disabled} onClick={retry}>{text.retry}</button> : <span />}
  </div>;
}
