// ============================================================================
// VoiceChrome —— composer 内固定通话状态槽位
//
// 紧凑单行：正常已建连状态统一显示“通话中 mm:ss”+ 控制按钮；
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

  return (
    <div
      data-testid="voice-chrome"
      data-state={visual}
      className="mb-2 rounded-xl border border-zinc-700/70 bg-zinc-900/80 px-3 py-[7px]"
    >
      <div className="flex items-center gap-3">
        <span
          data-testid="voice-status"
          title={visual === 'error' && store.error ? resolveVoiceErrorTitle(t, store.error) : statusText}
          className={`flex min-w-0 flex-1 truncate text-[11.5px] tracking-[0.02em] ${STATUS_COLOR[visual]}`}
        >
          {statusText}
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
