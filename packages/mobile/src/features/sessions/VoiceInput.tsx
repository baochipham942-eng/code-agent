import { useEffect, useRef, useState } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import { AppIcon } from '../../app/AppIcon';

export function VoiceInput({ recorder, text, disabled, pending, outcome, transcribe }: {
  recorder: NonNullable<PlatformPorts['recorder']>; text: ReturnType<typeof messages>; disabled: boolean; pending: boolean;
  outcome: 'done' | 'error' | null;
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }): Promise<void>;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'error'>('idle');
  const [denied, setDenied] = useState(false);
  const audio = useRef<Awaited<ReturnType<typeof recorder.stop>> | null>(null);
  const active = useRef(false); const cancelled = useRef(false); const stopping = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = async (discard = false) => {
    cancelled.current = discard;
    if (!active.current || stopping.current) return;
    stopping.current = true; clearTimeout(timer.current); setPhase('stopping');
    try {
      const value = await recorder.stop(); active.current = false;
      if (discard || cancelled.current) { audio.current = null; setPhase('idle'); return; }
      if (value.audioData.length > L.voiceBase64Limit) throw new Error('AUDIO_TOO_LARGE');
      audio.current = value; setPhase('ready'); await transcribe(value);
    } catch { setPhase('error'); }
    finally { active.current = false; stopping.current = false; }
  };
  useEffect(() => {
    const hide = () => { if (document.hidden) void stop(true); };
    document.addEventListener('visibilitychange', hide);
    return () => { cancelled.current = true; clearTimeout(timer.current); document.removeEventListener('visibilitychange', hide); void stop(true); };
  }, [recorder]);
  useEffect(() => { if (outcome === 'done' && !pending) { audio.current = null; setPhase('idle'); } }, [outcome, pending]);
  const start = async () => {
    cancelled.current = false; audio.current = null; setDenied(false); setPhase('starting');
    try {
      await recorder.start(); active.current = true;
      if (cancelled.current) { await stop(true); return; }
      setPhase('recording'); timer.current = setTimeout(() => { void stop(); }, L.voiceDurationMs);
    } catch (error) { setDenied(error instanceof Error && error.message === 'MICROPHONE_DENIED'); setPhase('error'); }
  };
  if (phase === 'idle') return <button aria-label={text.voice} disabled={disabled} onClick={() => void start()}><AppIcon name="mic" /></button>;
  return <div className="voice-card" role="status">
    <button aria-label={text.cancelRecording} disabled={phase === 'stopping' || pending} onClick={() => { if (active.current) void stop(true); else { cancelled.current = true; audio.current = null; setPhase('idle'); } }}><AppIcon name="close" /></button>
    {phase === 'recording' ? <button className="recording-stop" onClick={() => void stop()} aria-label={text.stopRecording}><AppIcon name="stop" /></button> : <span>{pending ? text.transcribing : phase === 'starting' || phase === 'stopping' ? text.loading : denied ? text.microphoneDenied : text.voiceFailed}</span>}
    {phase === 'error' || (phase === 'ready' && !pending) ? <button disabled={disabled} onClick={() => audio.current ? void transcribe(audio.current) : void start()}>{text.retry}</button> : <span />}
  </div>;
}
