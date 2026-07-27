// ============================================================================
// VoiceChrome —— 通话中底栏（B2/B6）
//
// live 时 Composer 输入框上方扩展出的通话 chrome：小型 presence（波形柔光，
// 明确不做全屏 orb，§7.2）、ActiveExpertChip、Mute、End、双向电平条、
// PTT/点按按钮（interruptMode 快照决定形态）。打字与附件入口保留在下方原处。
// 七态与动效照 §7.3 表；prefers-reduced-motion 下只靠颜色/文案（motion-safe 前缀）。
// ============================================================================

import React from 'react';
import { Mic, MicOff, Phone } from 'lucide-react';
import { selectVoiceVisualState, useVoiceCallStore, type VoiceVisualState } from '../../../stores/voiceCallStore';
import type { VoiceWorkItemStatus } from '@shared/contract/voice';
import { voiceCallBridge } from '../../../services/voiceCallBridge';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentRegistryStore } from '../../../stores/agentRegistryStore';
import { useSessionMembers } from '../expert/SessionMemberBar';

const STATE_COLOR: Record<VoiceVisualState, string> = {
  idle: 'text-zinc-500',
  connecting: 'text-zinc-400',
  reconnecting: 'text-amber-400',
  listening: 'text-emerald-400',
  speaking: 'text-primary-400',
  working: 'text-amber-400',
  muted: 'text-zinc-500',
  error: 'text-red-400',
};

const BAR_COUNT = 5;

/** 小型 presence：五根波形条，电平驱动高度；reduced-motion 下退成纯色呼吸点。 */
const PresenceWave: React.FC<{ state: VoiceVisualState; level: number }> = ({ state, level }) => {
  if (state === 'error') {
    return <span data-testid="voice-presence" className="h-2 w-2 rounded-full bg-red-500" aria-hidden />;
  }
  if (state === 'connecting' || state === 'reconnecting') {
    return (
      <span
        data-testid="voice-presence"
        className={`h-2 w-2 rounded-full motion-safe:animate-ping ${state === 'reconnecting' ? 'bg-amber-400' : 'bg-zinc-400'}`}
        aria-hidden
      />
    );
  }
  const base = state === 'muted' || state === 'idle' ? 0 : level;
  return (
    <span data-testid="voice-presence" className="flex h-4 items-end gap-0.5" aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => {
        const factor = [0.5, 0.85, 1, 0.85, 0.5][i];
        const height = 3 + Math.min(1, base * 3) * 13 * factor;
        return (
          <span
            key={i}
            className={`w-0.5 rounded-full transition-[height] duration-150 motion-reduce:transition-none ${
              state === 'muted' ? 'bg-zinc-600' : state === 'speaking' ? 'bg-primary-400' : 'bg-emerald-400'
            }`}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </span>
  );
};

const LevelMeter: React.FC<{ value: number; tone: 'mic' | 'playback'; label: string }> = ({ value, tone, label }) => (
  <span className="flex w-14 items-center gap-1" title={label}>
    <span className="h-1 w-full overflow-hidden rounded bg-zinc-700/70">
      <span
        className={`block h-1 rounded transition-[width] duration-100 motion-reduce:transition-none ${
          tone === 'mic' ? 'bg-emerald-500' : 'bg-primary-400'
        }`}
        style={{ width: `${Math.min(100, Math.round(value * 400))}%` }}
      />
    </span>
  </span>
);

/** 「与 {花名} 通话」/ 团会话「指挥 · Lead {花名} · N 成员」（§6.7.7）。 */
const ActiveExpertChip: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const activeAgentId = useVoiceCallStore((state) => state.activeAgentId);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const members = useSessionMembers(sessionId);

  let label: string;
  if (members.length > 1) {
    const lead = members.find((pill) => pill.isLead) ?? members[0];
    label = t.voice.team.command_mode.replace('{name}', lead.name).replace('{n}', String(members.length));
  } else if (activeAgentId) {
    const name = agentEntries.find((entry) => entry.id === activeAgentId)?.name ?? activeAgentId;
    label = t.voice.expert.with_name.replace('{name}', name);
  } else {
    label = t.voice.expert.default_assistant;
  }

  return (
    <span data-testid="voice-active-expert" className="truncate text-xs font-medium text-zinc-200">
      {label}
    </span>
  );
};

/** 五态各自的底色。终态与在途态必须一眼可分——否则「做完了」和「还在排队」长一个样。 */
const WORK_ITEM_TONE: Record<VoiceWorkItemStatus, string> = {
  queued: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const WorkStrip: React.FC = () => {
  const { t } = useI18n();
  const workItems = useVoiceCallStore((state) => state.workItems);
  if (workItems.length === 0) return null;
  const label: Record<VoiceWorkItemStatus, string> = {
    queued: t.voice.work.queued,
    running: t.voice.work.running,
    done: t.voice.work.done,
    cancelled: t.voice.work.cancelled,
    failed: t.voice.work.failed,
  };
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {workItems.map((item) => (
        <span
          key={item.id}
          data-testid={`voice-work-item-${item.status}`}
          title={item.detail ?? item.title}
          className={`max-w-40 truncate rounded-full border px-2 py-0.5 text-[11px] ${WORK_ITEM_TONE[item.status]}`}
        >
          {label[item.status]} · {item.title}
        </span>
      ))}
    </span>
  );
};

export const VoiceChrome: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const store = useVoiceCallStore();
  const visual = selectVoiceVisualState(store);
  if (visual === 'idle') return null;

  const statusText =
    visual === 'error'
      ? (store.error?.message ?? t.voice.status.error)
      // 点按模式没点开时麦克风门是关的——说「正在听」是骗人的，它在等你点。
      : visual === 'listening' && store.interruptMode === 'manual' && !store.pttCaptureOn
        ? t.voice.live.tapToTalk
        : t.voice.status[visual as Exclude<VoiceVisualState, 'idle' | 'error'>];

  const level = visual === 'speaking' ? store.playbackLevel : store.micLevel;

  return (
    <div
      data-testid="voice-chrome"
      data-state={visual}
      className="mb-2 flex items-center gap-3 rounded-xl border border-zinc-700/70 bg-zinc-900/80 px-3 py-2"
    >
      <PresenceWave state={visual} level={level} />
      <span data-testid="voice-status" className={`shrink-0 text-xs ${STATE_COLOR[visual]}`}>
        {statusText}
      </span>
      {/* 错误态整行只留错误信息与结束按钮，别让「与 X 通话」和报错文案打架 */}
      {visual !== 'error' && <ActiveExpertChip sessionId={sessionId} />}
      {visual !== 'error' && <WorkStrip />}

      <span className="flex-1" />

      {/* 双向电平：上 = 麦克风，下 = 助手 */}
      <span className="hidden sm:flex flex-col gap-1" aria-hidden>
        <LevelMeter value={store.micLevel} tone="mic" label={t.voice.status.listening} />
        <LevelMeter value={store.playbackLevel} tone="playback" label={t.voice.status.speaking} />
      </span>

      {store.interruptMode === 'manual' && (
        <button /* ds-allow:button: 点按说话按钮，双态样式与 PTT 同构，Button primitive 的居中按钮形态不适配 */
          type="button"
          data-testid="voice-manual-commit"
          onClick={() => voiceCallBridge.manualTap()}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
            store.pttCaptureOn
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-zinc-600 bg-zinc-800 text-zinc-300 hover:border-zinc-500'
          }`}
        >
          <Mic className="h-3.5 w-3.5" />
          {store.pttCaptureOn ? t.voice.live.tapToSend : t.voice.live.tapToTalk}
        </button>
      )}

      <button /* ds-allow:button: 静音 icon-only 按钮，与 composer 既有 icon 按钮同语言 */
        type="button"
        data-testid="voice-mute"
        onClick={() => voiceCallBridge.toggleMute()}
        title={store.muted ? t.voice.live.unmute : t.voice.live.mute}
        aria-label={store.muted ? t.voice.live.unmute : t.voice.live.mute}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
          store.muted ? 'bg-amber-500/15 text-amber-300' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
        }`}
      >
        {store.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>

      <button /* ds-allow:button: 挂断按钮，通话 chrome 特有的红色小型形态，Button primitive 无此变体 */
        type="button"
        data-testid="voice-end"
        onClick={() => voiceCallBridge.hangUp()}
        title={t.voice.live.endTitle}
        aria-label={t.voice.live.endTitle}
        className="flex h-8 items-center gap-1.5 rounded-lg bg-red-500/90 px-2.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
      >
        <Phone className="h-3.5 w-3.5" />
        {t.voice.live.end}
      </button>
    </div>
  );
};

export default VoiceChrome;
