// ============================================================================
// VoiceChrome —— 输入框上方的实时通话条（C 方案）
//
// 球的颜色与呼吸速度表达通话状态；上行只说此刻正在发生什么，下行收纳通话对象、
// 时长与剩余工作数。右侧操作位在任一状态下都不超过两个。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
import { selectVoiceVisualState, useVoiceCallStore, type VoiceVisualState } from '../../../stores/voiceCallStore';
import { voiceCallBridge } from '../../../services/voiceCallBridge';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentRegistryStore } from '../../../stores/agentRegistryStore';
import {
  selectIsCurrentComposerInProgress,
  useComposerNoticeStore,
  useRegisterComposerInProgress,
} from '../../../stores/composerNoticeStore';
import { useSessionMembers } from '../expert/SessionMemberBar';

type OrbState = Exclude<VoiceVisualState, 'idle'> | 'manual-ready';

const STATUS_COLOR: Record<Exclude<VoiceVisualState, 'idle'>, string> = {
  connecting: 'text-zinc-500',
  reconnecting: 'text-amber-400',
  listening: 'text-emerald-400',
  speaking: 'text-primary-400',
  working: 'text-amber-400',
  muted: 'text-zinc-500',
  error: 'text-red-400',
};

const VoicePresenceOrb: React.FC<{ state: OrbState }> = ({ state }) => {
  return (
    <span
      data-testid="voice-presence"
      data-orb-state={state}
      className="voice-presence-orb relative grid h-[34px] w-[34px] shrink-0 place-items-center"
      aria-hidden
    >
      <span className="voice-presence-orb-glow absolute -inset-[18%] rounded-full" />
      <span className="voice-presence-orb-core h-full w-full rounded-full" />
    </span>
  );
};

function useActiveExpertName(sessionId: string | null): string {
  const { t } = useI18n();
  const activeAgentId = useVoiceCallStore((state) => state.activeAgentId);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const members = useSessionMembers(sessionId);

  if (members.length > 1) {
    return (members.find((member) => member.isLead) ?? members[0]).name;
  }
  if (activeAgentId) {
    return agentEntries.find((entry) => entry.id === activeAgentId)?.name ?? activeAgentId;
  }
  return t.voice.expert.default_name;
}

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

export const VoiceChrome: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const store = useVoiceCallStore();
  const visual = selectVoiceVisualState(store);
  const expertName = useActiveExpertName(sessionId);
  const duration = useCallDuration(store.startedAt);
  useRegisterComposerInProgress('voice', visual !== 'idle');
  const isCurrentInProgress = useComposerNoticeStore((state) => (
    selectIsCurrentComposerInProgress(state, 'voice')
  ));

  const activeWorkItems = useMemo(
    () => store.workItems.filter((item) => item.status === 'queued' || item.status === 'running'),
    [store.workItems],
  );
  const currentWorkItem = activeWorkItems.find((item) => item.status === 'running') ?? activeWorkItems[0];
  const remainingWorkCount = Math.max(0, activeWorkItems.length - (currentWorkItem ? 1 : 0));

  if (visual === 'idle' || !isCurrentInProgress) return null;

  const isConnecting = visual === 'connecting' || visual === 'reconnecting';
  const isManualListening = visual === 'listening' && store.interruptMode === 'manual';
  const statusText = visual === 'error'
    ? (store.error?.message ?? t.voice.status.error)
    : visual === 'working' && currentWorkItem
      ? currentWorkItem.title
      : visual === 'muted'
        ? t.voice.status.mutedDetail
        : isManualListening
          ? (store.pttCaptureOn ? t.voice.status.manualListening : t.voice.status.manualReady)
          : t.voice.status[visual];

  const orbState: OrbState = isManualListening && !store.pttCaptureOn ? 'manual-ready' : visual;
  const metaParts = visual === 'error'
    ? []
    : [
        expertName,
        ...(visual === 'connecting' ? [] : [duration]),
        ...(remainingWorkCount > 0
          ? [t.voice.work.remaining.replace('{n}', String(remainingWorkCount))]
          : []),
      ];

  const showManualControl = store.interruptMode === 'manual' && !isConnecting;

  return (
    <div
      data-testid="voice-chrome"
      data-state={visual}
      className="mb-2 rounded-xl border border-zinc-700/70 bg-zinc-900/80 px-3 py-[9px]"
    >
      {/* 外层是竖向容器：一行通话条 + （可能有的）一次性提示。
          C 方案把行内换成球 + 两行字，但 notice 必须挂在行**下面**——
          它和行是上下关系，不能塞进那一行里（工单③ 的 fail-loud 提示靠这条活着）。 */}
      <div className="flex items-center gap-3">
      <VoicePresenceOrb state={orbState} />

      <span className="flex min-w-0 flex-col gap-px">
        <span
          data-testid="voice-status"
          title={statusText}
          className={`truncate text-[11.5px] tracking-[0.02em] ${STATUS_COLOR[visual]}`}
        >
          {statusText}
        </span>
        {metaParts.length > 0 && (
          <span data-testid="voice-meta" className="truncate whitespace-nowrap text-[11px] text-zinc-500">
            {metaParts.map((part, index) => (
              <React.Fragment key={`${part}-${index}`}>
                {index > 0 && ' · '}
                {index === 0 ? <span className="font-medium text-zinc-400">{part}</span> : part}
              </React.Fragment>
            ))}
          </span>
        )}
      </span>

      <span className="flex-1" />

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
        <p data-testid="voice-call-notice" className="mt-1.5 text-xs leading-5 text-amber-300">
          {store.notice}
        </p>
      )}
    </div>
  );
};

export default VoiceChrome;
