// ============================================================================
// voiceCallStore —— 实时通话的 renderer 单一状态源（Phase 1 批 B）
//
// VoiceSpikePanel 把通话状态散在一个组件的 useState 里，批 B 的入口按钮、
// VoiceChrome、字幕行、成员条高亮分处不同组件树，必须共享同一份状态。
// 写入方只有 voiceCallBridge（WS 事件唯一消费者），组件只读。
// ============================================================================

import { create } from 'zustand';
import type { VoiceMessageCode, VoiceTokenUsage, VoiceWorkItem } from '@shared/contract/voice';
import type { RealtimeVoiceCostEstimate } from '@shared/pricing/estimateRealtimeVoiceCost';
import type { VoiceLiveSettings } from '@shared/contract/settings';

export type VoiceInterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;

/** 连接相位（WS 层）；七态视觉态由 selectVoiceVisualState 推导（方案 §7.3）。 */
export type VoiceCallPhase = 'idle' | 'connecting' | 'live' | 'error';

export type VoiceVisualState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'muted'
  | 'error';

export interface VoiceCallError {
  code: VoiceMessageCode;
  /** host 侧原文，仅作兜底与日志；给用户看的文案按 code 查 i18n（见 resolveVoiceMessage）。 */
  message: string;
  /** 上游/执行侧原始详情，不进入主文案；只在详情交互或 title 中展示。 */
  detail?: string;
}

interface VoiceCallStoreState {
  phase: VoiceCallPhase;
  /** 通话绑定的 Neo 会话；idle 时为 null */
  sessionId: string | null;
  /** 建连时的通话身份（renderer 侧 activeAgentId 快照），MemberBar 高亮用 */
  activeAgentId?: string;
  startedAt: number | null;
  muted: boolean;
  /** 用户正在说（speech.started 之后、该轮 final 之前） */
  userSpeaking: boolean;
  /** 助手正在说（收到助手音频/字幕增量之后、response.done 之前） */
  assistantSpeaking: boolean;
  /** PTT/手动模式：是否正按住（或点按开启）采集 */
  pttCaptureOn: boolean;
  /** 断线重连中：phase 回到 connecting，但这是同一通电话，work items / 计时都不重置 */
  reconnecting: boolean;
  /** 当前是第几次重连（1 起）；非重连态为 0。上限由 VOICE_RECONNECT_BACKOFF_MS 推导，bridge 写入 */
  reconnectAttempt: number;
  /** 重连总次数上限（= 退避表长度）；非重连态为 0 */
  reconnectMaxAttempts: number;
  /** 本次通话的打断方式（建连时从设置快照）：决定 VoiceChrome 是全双工还是 PTT/点按 */
  interruptMode: VoiceInterruptMode;
  workItems: VoiceWorkItem[];
  /** partial 字幕——只在通话态临时渲染，绝不进 projection（§7.5 单一生产者） */
  partialUser: string;
  partialAssistant: string;
  micLevel: number;
  playbackLevel: number;
  error: VoiceCallError | null;
  /** 通话中的一次性提示（如「当前模型不支持派活」）；不致命，不进 error 态。
   *  存 code 而不是成品文案——文案的家在 i18n，host 只说「出了哪件事」。 */
  notice: VoiceCallError | null;
  ttfa: { modelMs?: number; perceivedMs?: number } | null;
  tokenUsage: VoiceTokenUsage;
  costEstimate: RealtimeVoiceCostEstimate | null;
  costLimit: number | null;
  costLimitAction: 'warn' | 'hangup';
  costLimitExceeded: boolean;

  /** 以下动作只由 voiceCallBridge 调用 */
  dialStarted: (sessionId: string, activeAgentId: string | undefined, interruptMode: VoiceInterruptMode) => void;
  phaseChanged: (phase: VoiceCallPhase) => void;
  eventApplied: (event: {
    userSpeaking?: boolean;
    assistantSpeaking?: boolean;
    partialUser?: string;
    partialAssistant?: string;
    workItem?: VoiceWorkItem;
    error?: VoiceCallError | null;
    notice?: VoiceCallError | null;
    ttfa?: { modelMs?: number; perceivedMs?: number };
  }) => void;
  levelsChanged: (mic: number, playback: number) => void;
  muteChanged: (muted: boolean) => void;
  pttCaptureChanged: (on: boolean) => void;
  reconnectingChanged: (
    reconnecting: boolean,
    progress?: { attempt: number; maxAttempts: number },
  ) => void;
  costConfigured: (limit: number | null, action: 'warn' | 'hangup') => void;
  usageApplied: (usage: VoiceTokenUsage, estimate: RealtimeVoiceCostEstimate | null) => void;
  reset: () => void;
}

const INITIAL = {
  phase: 'idle' as VoiceCallPhase,
  sessionId: null,
  activeAgentId: undefined,
  startedAt: null,
  muted: false,
  userSpeaking: false,
  assistantSpeaking: false,
  pttCaptureOn: false,
  reconnecting: false,
  reconnectAttempt: 0,
  reconnectMaxAttempts: 0,
  interruptMode: 'server_vad' as const,
  workItems: [],
  partialUser: '',
  partialAssistant: '',
  micLevel: 0,
  playbackLevel: 0,
  error: null,
  notice: null,
  ttfa: null,
  tokenUsage: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    inputTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
  },
  costEstimate: null,
  costLimit: null,
  costLimitAction: 'warn' as const,
  costLimitExceeded: false,
};

export const useVoiceCallStore = create<VoiceCallStoreState>((set) => ({
  ...INITIAL,

  dialStarted: (sessionId, activeAgentId, interruptMode) =>
    set({
      ...INITIAL,
      phase: 'connecting',
      sessionId,
      activeAgentId,
      interruptMode,
      startedAt: Date.now(),
    }),

  phaseChanged: (phase) => set({ phase }),

  eventApplied: (event) =>
    set((state) => ({
      userSpeaking: event.userSpeaking ?? state.userSpeaking,
      assistantSpeaking: event.assistantSpeaking ?? state.assistantSpeaking,
      partialUser: event.partialUser ?? state.partialUser,
      partialAssistant: event.partialAssistant ?? state.partialAssistant,
      workItems: event.workItem
        ? [...state.workItems.filter((item) => item.id !== event.workItem!.id), event.workItem]
        : state.workItems,
      error: event.error === undefined ? state.error : event.error,
      notice: event.notice === undefined ? state.notice : event.notice,
      ttfa: event.ttfa ?? state.ttfa,
    })),

  levelsChanged: (mic, playback) => set({ micLevel: mic, playbackLevel: playback }),
  muteChanged: (muted) => set({ muted }),
  pttCaptureChanged: (on) => set({ pttCaptureOn: on }),
  // 重连开始必须带进度（attempt 从 1 起）；结束/归零时不带，进度清零。
  reconnectingChanged: (reconnecting, progress) =>
    set({
      reconnecting,
      reconnectAttempt: reconnecting ? progress?.attempt ?? 0 : 0,
      reconnectMaxAttempts: reconnecting ? progress?.maxAttempts ?? 0 : 0,
    }),
  costConfigured: (costLimit, costLimitAction) => set({ costLimit, costLimitAction }),
  usageApplied: (tokenUsage, costEstimate) => set((state) => ({
    tokenUsage,
    costEstimate,
    costLimitExceeded: costEstimate !== null
      && state.costLimit !== null
      && costEstimate.amount >= state.costLimit,
  })),

  reset: () => set({ ...INITIAL }),
}));

/**
 * §7.3 七态推导。优先级：error > muted > working > speaking > listening。
 * working 不冻结 listening——它只是「有活在排」的标记态，电平条照跑。
 */
export function selectVoiceVisualState(state: {
  phase: VoiceCallPhase;
  muted: boolean;
  assistantSpeaking: boolean;
  workItems: VoiceWorkItem[];
  reconnecting?: boolean;
}): VoiceVisualState {
  if (state.phase === 'idle') return 'idle';
  // 重连中要和首次拨号区分开：用户已经在打这通电话了，看到「连接中」会以为要重新开始。
  if (state.phase === 'connecting') return state.reconnecting ? 'reconnecting' : 'connecting';
  if (state.phase === 'error') return 'error';
  if (state.muted) return 'muted';
  // 在途 = 排队中或正在跑。只看 queued 的话，run 一开始跑 working 态就掉了（批 H 前的行为）。
  if (state.workItems.some((item) => item.status === 'queued' || item.status === 'running')) return 'working';
  if (state.assistantSpeaking) return 'speaking';
  return 'listening';
}
