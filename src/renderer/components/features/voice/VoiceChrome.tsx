// ============================================================================
// VoiceChrome —— composer 内固定通话状态槽位
//
// 紧凑单行：左侧 22px 自转星球（七态映射见 PLANET_BY_VISUAL，P0「星球七态」拍板）
// + 状态词 + “通话中 mm:ss”等既有文案 + 小字星球 hint + 控制按钮；
// connecting / reconnecting / error 继续显示各自本地化状态与错误详情。
// 不展示助手名、模型名、当前 work item 标题或剩余工作数。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
import { selectVoiceVisualState, useVoiceCallStore, type VoiceVisualState } from '../../../stores/voiceCallStore';
import { voiceCallBridge } from '../../../services/voiceCallBridge';
import { useI18n } from '../../../hooks/useI18n';
import {
  selectIsCurrentComposerInProgress,
  useComposerNoticeStore,
  useRegisterComposerInProgress,
} from '../../../stores/composerNoticeStore';
import { resolveVoiceErrorTitle, resolveVoiceMessage } from './resolveVoiceMessage';
import { PlanetSphere, type PlanetFx, type PlanetKind } from '../../brand/PlanetSphere';
import type { VoiceTranslations } from '../../../i18n/voice';

type PlanetHintKey = keyof VoiceTranslations['voice']['planet']['hint'];
type PlanetWordKey = keyof VoiceTranslations['voice']['planet']['word'];

interface PlanetSpec {
  kind: PlanetKind;
  /** 自转周期（秒/周） */
  spinSeconds: number;
  fx: PlanetFx;
  glowColor: string;
  withOrbit?: boolean;
  hintKey: PlanetHintKey;
}

/**
 * 七态 → 星球映射（P0 拍板）：连接/重连=水星（信号握手脉冲），聆听=地球
 * （轨道环+卫星，RMS 驱动辉光），表达=太阳（日冕脉动），思考=木星（低频起伏），
 * 静音=地球暗面，异常=当前星球停转染红。辉光色对齐 STATUS_COLOR 的状态色。
 */
const PLANET_BY_VISUAL: Record<Exclude<VoiceVisualState, 'idle' | 'error'>, PlanetSpec> = {
  connecting: { kind: 'mercury', spinSeconds: 3.2, fx: 'pulse', glowColor: 'rgba(113,113,122,.5)', hintKey: 'mercury' },
  reconnecting: { kind: 'mercury', spinSeconds: 3.2, fx: 'pulse', glowColor: 'rgba(251,191,36,.55)', hintKey: 'mercury' },
  listening: { kind: 'earth', spinSeconds: 16, fx: 'rms', glowColor: 'rgba(52,211,153,.55)', withOrbit: true, hintKey: 'earth' },
  speaking: { kind: 'sun', spinSeconds: 12, fx: 'corona', glowColor: 'rgba(45,212,191,.6)', hintKey: 'sol' },
  working: { kind: 'jupiter', spinSeconds: 7, fx: 'sway', glowColor: 'rgba(251,191,36,.5)', hintKey: 'jupiter' },
  muted: { kind: 'earth', spinSeconds: 40, fx: 'dark', glowColor: 'rgba(113,113,122,.4)', hintKey: 'earthDark' },
};

/**
 * 真实电平 → 开方曲线 RMS。复用 DictationRecordingBar 已验证的模式：原始电平
 * 进环形缓冲（120ms 一档的采集节拍会抖动），均值开方压低端后驱动视觉，不造假动画。
 */
const LEVEL_BUFFER_SIZE = 6;
function useRmsLevel(raw: number): number {
  const bufferRef = React.useRef<number[]>([]);
  const [rms, setRms] = React.useState(0);
  React.useEffect(() => {
    const buf = bufferRef.current;
    buf.push(raw);
    if (buf.length > LEVEL_BUFFER_SIZE) buf.shift();
    const avg = buf.reduce((sum, v) => sum + v, 0) / buf.length;
    setRms(Math.sqrt(Math.min(1, Math.max(0, avg))));
  }, [raw]);
  return rms;
}

/**
 * 状态栏星球槽位。listening 的辉光/微缩放由 store.micLevel（上行真实 RMS）驱动；
 * speaking 用 store.playbackLevel（下行真实电平——voiceAudioPipeline /
 * nativeVoiceAudioPipeline 都经 levelsChanged 上报），不是 CSS 假脉冲；
 * corona 的 CSS 正弦脉动只是叠在真实电平上的底色呼吸。
 * error 态保留出错前那颗星球（停转染红），所以记住最近一个非 error 的 spec。
 */
const VoicePlanet: React.FC<{ visual: Exclude<VoiceVisualState, 'idle'> }> = ({ visual }) => {
  const micLevel = useVoiceCallStore((state) => state.micLevel);
  const playbackLevel = useVoiceCallStore((state) => state.playbackLevel);
  const rawLevel = visual === 'listening' ? micLevel : visual === 'speaking' ? playbackLevel : 0;
  const rms = useRmsLevel(rawLevel);
  const [lastSpec, setLastSpec] = React.useState<PlanetSpec>(PLANET_BY_VISUAL.listening);
  React.useEffect(() => {
    if (visual !== 'error') setLastSpec(PLANET_BY_VISUAL[visual]);
  }, [visual]);
  const spec = visual === 'error' ? { ...lastSpec, fx: 'alert' as PlanetFx } : PLANET_BY_VISUAL[visual];
  return (
    <PlanetSphere
      kind={spec.kind}
      spinSeconds={spec.spinSeconds}
      fx={spec.fx}
      glowColor={spec.glowColor}
      withOrbit={spec.withOrbit}
      rms={rms}
      size={22}
    />
  );
};

const STATUS_COLOR: Record<Exclude<VoiceVisualState, 'idle'>, string> = {
  connecting: 'text-zinc-500',
  reconnecting: 'text-amber-400',
  listening: 'text-emerald-400',
  speaking: 'text-primary-400',
  working: 'text-amber-400',
  muted: 'text-zinc-500',
  error: 'text-red-400',
};

function formatCallDuration(startedAt: number | null, now: number): string {
  const elapsedSeconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function useCallDuration(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return formatCallDuration(startedAt, now);
}

export const VoiceChrome: React.FC<{ sessionId: string | null }> = ({ sessionId: _sessionId }) => {
  const { t } = useI18n();
  const store = useVoiceCallStore();
  const visual = selectVoiceVisualState(store);
  const duration = useCallDuration(store.startedAt);
  useRegisterComposerInProgress('voice', visual !== 'idle');
  const isCurrentInProgress = useComposerNoticeStore((state) => (
    selectIsCurrentComposerInProgress(state, 'voice')
  ));

  if (visual === 'idle' || !isCurrentInProgress) return null;

  const isConnecting = visual === 'connecting' || visual === 'reconnecting';

  const statusText = (() => {
    if (visual === 'error') {
      return store.error ? resolveVoiceMessage(t, store.error) : t.voice.status.error;
    }
    if (visual === 'reconnecting') {
      return store.reconnectMaxAttempts > 0
        ? t.voice.status.reconnectingProgress
            .replace('{n}', String(store.reconnectAttempt))
            .replace('{m}', String(store.reconnectMaxAttempts))
        : t.voice.status.reconnecting;
    }
    if (visual === 'connecting') {
      return t.voice.status.connecting;
    }
    return `${t.voice.status.onCall} ${duration}`;
  })();

  const showManualControl = store.interruptMode === 'manual' && !isConnecting;
  const statusWordKey: PlanetWordKey = visual;
  const hintKey: PlanetHintKey = visual === 'error' ? 'alert' : PLANET_BY_VISUAL[visual].hintKey;

  return (
    <div
      data-testid="voice-chrome"
      data-state={visual}
      className="mb-2 rounded-xl border border-zinc-700/70 bg-zinc-900/80 px-3 py-[7px]"
    >
      <div className="flex items-center gap-3">
        <VoicePlanet visual={visual} />
        <span
          data-testid="voice-status"
          title={visual === 'error' && store.error ? resolveVoiceErrorTitle(t, store.error) : statusText}
          className={`flex min-w-0 flex-1 items-baseline truncate text-[11.5px] tracking-[0.02em] ${STATUS_COLOR[visual]}`}
        >
          <span data-testid="voice-state-word" className="shrink-0">
            {t.voice.planet.word[statusWordKey]}
          </span>
          <span className="shrink-0 opacity-50">&nbsp;·&nbsp;</span>
          <span className="min-w-0 truncate">{statusText}</span>
          <span data-testid="voice-state-hint" className="ml-1.5 shrink-0 text-[9.5px] tracking-[0.05em] opacity-55">
            {t.voice.planet.hint[hintKey]}
          </span>
        </span>

        {visual !== 'error' && showManualControl && (
          <button /* ds-allow:button: 通话条文字操作键，Button primitive 没有这套紧凑双态形态 */
            type="button"
            data-testid="voice-manual-commit"
            onClick={() => voiceCallBridge.manualTap()}
            className={`flex h-[30px] items-center whitespace-nowrap rounded-[var(--radius-xl)] border px-3 text-[11.5px] transition-colors ${
              store.pttCaptureOn
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
            }`}
          >
            {store.pttCaptureOn ? t.voice.live.tapDone : t.voice.live.tapToTalk}
          </button>
        )}

        {visual !== 'error' && !showManualControl && (
          <button /* ds-allow:button: 通话条麦克风 icon-only 按钮，与样机状态色绑定 */
            type="button"
            data-testid="voice-mute"
            disabled={isConnecting}
            onClick={() => voiceCallBridge.toggleMute()}
            title={store.muted ? t.voice.live.unmute : t.voice.live.mute}
            aria-label={store.muted ? t.voice.live.unmute : t.voice.live.mute}
            className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-xl)] transition-colors ${
              isConnecting
                ? 'cursor-not-allowed text-zinc-600'
                : store.muted
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-primary-500/15 text-primary-400 hover:bg-primary-500/20'
            }`}
          >
            {store.muted ? <MicOff className="h-[15px] w-[15px]" /> : <Mic className="h-[15px] w-[15px]" />}
          </button>
        )}

        <button /* ds-allow:button: 通话条挂断 icon-only 按钮，Button primitive 没有红色 30px 变体 */
          type="button"
          data-testid="voice-end"
          onClick={() => voiceCallBridge.hangUp()}
          title={t.voice.live.endTitle}
          aria-label={t.voice.live.endTitle}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-red-500/15 text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
        >
          <X className="h-[15px] w-[15px]" />
        </button>
      </div>

      {/* 一次性提示（如 tools 被上游静默丢弃）：不抢 error 态，通话继续，但用户必须当场看见 */}
      {store.notice && (
        <div data-testid="voice-call-notice" className="mt-1.5 text-xs leading-5 text-amber-300">
          <p>{resolveVoiceMessage(t, store.notice)}</p>
          {store.notice.detail && (
            <details className="mt-1 text-[11px] text-amber-300/75">
              <summary className="cursor-pointer select-none">{t.systemError.viewDetails}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{store.notice.detail}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

export default VoiceChrome;
