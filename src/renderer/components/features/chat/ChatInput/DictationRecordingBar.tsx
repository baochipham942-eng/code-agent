// ============================================================================
// DictationRecordingBar —— Dictation 录音态输入行（G4 拍板形态，2026-07-27）
//
// 录音进行时替换 composer 的 InputArea：波形铺满输入行 + 录音计时（0:15）+
// 停止按钮 + 发送按钮；停止后转写文本落回输入框可编辑（发送按钮 = 停止并发送，
// 由 ChatInput 的 send-after-transcript 接线完成）。
//
// 波形用真实麦克风电平驱动：useVoiceInput 的 RMS inputLevel（120ms 一档）逐档
// 采样进环形缓冲，不造假动画。prefers-reduced-motion 下退化为静态电平条
// （不滚动、不跳变，只留一根随电平伸缩的静条）。
// ============================================================================

import React from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import type { VoiceInputStatus } from '../../../../hooks/useVoiceInput';
import { useI18n } from '../../../../hooks/useI18n';

/** 录音计时：m:ss（拍板要求的 0:15 格式） */
export function formatRecordingClock(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const WAVEFORM_BAR_COUNT = 48;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * 真实电平驱动的波形：每次 inputLevel 更新（采集链路 120ms 一档）把电平推入
 * 环形缓冲，最新在右。reduced-motion → 静态电平条。
 */
const DictationWaveform: React.FC<{ level: number; silenceWarning: boolean }> = ({
  level,
  silenceWarning,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [history, setHistory] = React.useState<number[]>(() => []);

  React.useEffect(() => {
    setHistory((prev) => {
      const next = prev.length >= WAVEFORM_BAR_COUNT ? prev.slice(1) : prev.slice();
      next.push(level);
      return next;
    });
  }, [level]);

  const barColor = silenceWarning ? 'bg-amber-400' : 'bg-red-400';

  if (reducedMotion) {
    // 静态电平条：不滚动不跳动，宽度随当前电平伸缩（无 transition，避免闪烁动画）
    return (
      <div
        className="flex h-9 flex-1 items-center"
        role="img"
        aria-label={`recording level ${Math.round(level * 100)}%`}
        data-testid="dictation-waveform-static"
      >
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${Math.max(3, Math.round(level * 100))}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-9 flex-1 items-center justify-end gap-[3px] overflow-hidden"
      role="img"
      aria-label={`recording level ${Math.round(level * 100)}%`}
      data-testid="dictation-waveform"
    >
      {history.map((value, index) => (
        <span
          key={index}
          className={`w-[3px] shrink-0 rounded-full ${barColor}`}
          style={{ height: `${Math.max(12, Math.round(value * 100))}%` }}
        />
      ))}
    </div>
  );
};

export interface DictationRecordingBarProps {
  status: VoiceInputStatus;
  /** 录音时长（秒） */
  duration: number;
  /** 当前输入音量 0-1（真实 RMS 电平） */
  inputLevel: number;
  silenceWarning: boolean;
  /** 停止录音并转写（文本落回输入框可编辑） */
  onStop: () => void;
  /** 停止录音并发送（转写完成后自动提交） */
  onSend: () => void;
}

export const DictationRecordingBar: React.FC<DictationRecordingBarProps> = ({
  status,
  duration,
  inputLevel,
  silenceWarning,
  onStop,
  onSend,
}) => {
  const { t } = useI18n();
  const v = t.voiceInputButton;
  const isTranscribing = status === 'transcribing';

  return (
    <div
      data-testid="dictation-recording-bar"
      className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 ${
        silenceWarning ? 'border-amber-500/40 bg-amber-500/5' : 'border-red-500/30 bg-red-500/5'
      }`}
    >
      {isTranscribing ? (
        <div className="flex h-9 flex-1 items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{v.transcribingTitle}</span>
        </div>
      ) : (
        <>
          <DictationWaveform level={inputLevel} silenceWarning={silenceWarning} />
          <span
            className="shrink-0 font-mono text-sm tabular-nums text-red-300"
            data-testid="dictation-recording-clock"
          >
            {formatRecordingClock(duration)}
          </span>
        </>
      )}
      {/* 停止：转写后文本落回输入框可编辑 */}
      <button
        type="button"
        onClick={onStop}
        disabled={isTranscribing}
        title={v.stopRecordingAria}
        aria-label={v.stopRecordingAria}
        className="flex h-9 w-9 shrink-0 place-items-center items-center justify-center rounded-xl bg-zinc-700/90 text-zinc-200 transition-all duration-200 hover:bg-zinc-600 active:scale-95 disabled:opacity-50"
      >
        <Square className="h-3.5 w-3.5 fill-current stroke-[2.2]" />
      </button>
      {/* 发送：停止录音，转写完成后自动提交 */}
      <button
        type="button"
        onClick={onSend}
        disabled={isTranscribing}
        title={v.sendRecordingTitle}
        aria-label={v.sendRecordingTitle}
        className="flex h-9 w-9 shrink-0 place-items-center items-center justify-center rounded-xl bg-brand text-white shadow-[0_10px_24px_var(--brand-primary-glow)] transition-all duration-200 hover:bg-brand-hover active:scale-95 disabled:opacity-50"
      >
        <ArrowUp className="h-4 w-4 stroke-[2.4]" />
      </button>
    </div>
  );
};

export default DictationRecordingBar;
