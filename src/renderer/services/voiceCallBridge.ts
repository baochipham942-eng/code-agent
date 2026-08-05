// ============================================================================
// voiceCallBridge —— 实时通话的 WS 唯一消费者（Phase 1 批 B）
//
// VoiceSpikePanel 的组件内 WS 管理改写为模块级单例：入口按钮、VoiceChrome、
// 字幕行、成员条高亮分处不同组件树，通话寿命不能绑在任何一个组件上。
// 保留了 spike 真机踩出来的三条教训：
//   1) 拨号前必须显式关旧 WS（否则被 host 单路互斥挡成 VOICE_SESSION_BUSY）；
//   2) WebSocket error 事件不带原因，要自己记「有没有 open 过」区分握手失败；
//   3) server_vad 要持续推流（静音也发帧），门控在管线里做不在 WS 层做。
//
// 字幕落库只有 host 一个生产者（§7.5）：final 落库后这里只做「重新拉消息」，
// 绝不在 renderer 手搓 message 塞进 sessionStore。
// ============================================================================

import type { RendererVoiceFailureReport, VoiceMessageCode, VoiceTokenUsage } from '@shared/contract/voice';
import { VOICE_DOWNSTREAM_SAMPLE_RATE, VOICE_FOCUS_REPORT_MIN_INTERVAL_MS, VOICE_RECONNECT_BACKOFF_MS, VOICE_PARTIAL_HANDOFF_MAX_WAIT_MS, VOICE_STREAM_WS_PATH, VOICE_SUBTITLE_REVEAL_INTERVAL_MS, VOICE_SUBTITLE_STALL_FLUSH_MS, VOICE_TEARDOWN_DRAIN_MS, VOICE_WS_CLOSE_TERMINAL } from '@shared/constants/voice';
import type { AppSettings, Message, VoiceInputDeviceSettings } from '@shared/contract';
import type { VoiceClientCommand, VoiceEvent } from '@shared/contract/voice';
import { IPC_DOMAINS } from '@shared/ipc';
import { normalizeVoiceInputDevice } from '@shared/voiceInputDevice';
import { languages } from '../i18n';
import { readActiveAgentSessionMap } from '../stores/activeAgentSessionMap';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceCallStore, type VoiceCallError, type VoiceInterruptMode } from '../stores/voiceCallStore';
import { resolveVoiceMessage } from '../components/features/voice/resolveVoiceMessage';
import { VOICE_STARTUP_FAILURE_TIER } from './voiceStartupFailureTier';
import ipcService from './ipcService';
import { isNativeDesktopAvailable } from './nativeDesktop';
import { NativeVoiceAudioPipeline } from './nativeVoiceAudioPipeline';
import { maybeShowSpeakerEchoHint, showVoiceAecFallbackWarning } from './voiceEchoHint';
import {
  readPreferredVoiceInputAvailability,
  VoiceAudioPipeline,
  type VoiceAudioPipelineLike,
} from './voiceAudioPipeline';
import { computeRevealedSubtitle, resolvePartialRelease } from '../utils/voicePartialOverlay';
import { selectVoiceFocusContext } from './voiceFocusContext';
import { normalizeInterruptMode } from '../components/features/voice/voiceSettingsDerivation';
import { toast } from '../hooks/useToast';
import { QWEN_OMNI_REALTIME_MODEL } from '@shared/constants/voice';
import { estimateRealtimeVoiceCost } from '@shared/pricing/estimateRealtimeVoiceCost';

function getT() {
  return languages[useAppStore.getState().language] ?? languages.zh;
}

function buildStreamUrl(sessionId: string, agentId?: string): string {
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ sessionId });
  if (typeof token === 'string') params.set('token', token);
  if (agentId) params.set('agentId', agentId);
  return `${scheme}://${window.location.host}${VOICE_STREAM_WS_PATH}?${params.toString()}`;
}

function joinUserTranscriptParts(prefix: string, current: string): string {
  return [prefix.trim(), current.trim()].filter(Boolean).join(' ');
}

function removeUserTranscriptPrefix(text: string, prefix: string): string | undefined {
  const normalizedText = text.trim();
  const normalizedPrefix = prefix.trim();
  if (!normalizedText || !normalizedPrefix) return undefined;
  if (normalizedText === normalizedPrefix) return '';
  if (!normalizedText.startsWith(normalizedPrefix)) return undefined;
  const boundary = normalizedText[normalizedPrefix.length];
  if (!boundary || !/\s/.test(boundary)) return undefined;
  return normalizedText.slice(normalizedPrefix.length).trimStart();
}

async function readVoiceRuntimeSettings(): Promise<{
  interruptMode: VoiceInterruptMode;
  echoCancellation: 'auto' | 'off';
  inputDevice?: VoiceInputDeviceSettings;
  conversationModel: string;
  costLimit: number | null;
  costLimitAction: 'warn' | 'hangup';
}> {
  try {
    const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
    return {
      interruptMode: normalizeInterruptMode(settings.voice?.live?.interrupt),
      echoCancellation: settings.voice?.live?.echoCancellation ?? 'auto',
      inputDevice: normalizeVoiceInputDevice(settings.voice?.inputDevice),
      conversationModel: settings.voice?.live?.conversationModel ?? QWEN_OMNI_REALTIME_MODEL,
      costLimit: typeof settings.voice?.live?.callCostLimit === 'number'
        && Number.isFinite(settings.voice.live.callCostLimit)
        && settings.voice.live.callCostLimit > 0
        ? settings.voice.live.callCostLimit
        : null,
      costLimitAction: settings.voice?.live?.callCostLimitAction ?? 'warn',
    };
  } catch {
    return {
      interruptMode: 'server_vad',
      echoCancellation: 'auto',
      conversationModel: QWEN_OMNI_REALTIME_MODEL,
      costLimit: null,
      costLimitAction: 'warn',
    };
  }
}

function addVoiceTokenUsage(current: VoiceTokenUsage, next: VoiceTokenUsage): VoiceTokenUsage {
  return {
    totalTokens: current.totalTokens + next.totalTokens,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    inputAudioTokens: current.inputAudioTokens + next.inputAudioTokens,
    inputTextTokens: current.inputTextTokens + next.inputTextTokens,
    outputAudioTokens: current.outputAudioTokens + next.outputAudioTokens,
    outputTextTokens: current.outputTextTokens + next.outputTextTokens,
  };
}

/** final 落库是 host 的事；renderer 只重新拉一次消息让气泡/摘要卡自然进流。 */
async function reloadVoiceSessionMessages(sessionId: string): Promise<void> {
  if (useSessionStore.getState().currentSessionId !== sessionId) return;
  try {
    const response = await window.domainAPI?.invoke<{ messages?: Message[] }>(IPC_DOMAINS.SESSION, 'load', { sessionId });
    if (!response?.success || useSessionStore.getState().currentSessionId !== sessionId) return;
    const messages = response.data?.messages;
    if (Array.isArray(messages)) useSessionStore.getState().setMessages(messages);
  } catch {
    // 拉取失败不致命：下一次 final / 挂断还会再拉
  }
}

class VoiceCallBridge {
  private ws: WebSocket | null = null;
  private audio: VoiceAudioPipelineLike | null = null;
  private audioReady: Promise<'native_aec' | 'headphones'> | null = null;
  private pendingAudioDiagnostics: string[] = [];
  private fallbackWarningShown = false;
  private reloadTimers = new Map<'user' | 'assistant' | 'generic', ReturnType<typeof setTimeout>>();
  /** 用户显式挂断 vs 网络断开——只有后者才该重连。 */
  private intentionalClose = false;
  /**
   * 本次拨号是否到达过 live（T3 启动期判据）。不能拿相位当判据：重连会把相位打回
   * connecting，但那仍是同一通通话中——中途断线的失败呈现不归启动期分档管。
   */
  private hasGoneLive = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inputDevice: VoiceInputDeviceSettings | undefined;
  private interruptMode: VoiceInterruptMode = 'server_vad';
  private echoCancellation: 'auto' | 'off' = 'auto';
  private preferredInputAvailable: boolean | null = null;
  private inputDeviceChangeHandler: (() => void) | null = null;
  private inputDeviceSwitchQueue: Promise<void> = Promise.resolve();
  private pausedCandidateId: string | null = null;
  private playbackPausedAt = 0;
  /** Host 标记为播报响应后，等真实播放管线接收首帧再回执。 */
  private pendingNarrationPlaybackId: string | null = null;
  /** 有界取消墓碑：上游 cancel 后仍可能把旧 final/done 发完。 */
  private cancelledResponseIds = new Set<string>();
  /** 同一次拨号每种失效只上报一次，避免 WebSocket error + close 双事件重复入账。 */
  private reportedFailureCodes = new Set<RendererVoiceFailureReport['code']>();
  private conversationModel = QWEN_OMNI_REALTIME_MODEL;
  private accumulatedUsage: VoiceTokenUsage = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    inputTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
  };

  private store() {
    return useVoiceCallStore.getState();
  }

  private send(command: VoiceClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(command));
  }

  private acknowledgeNarrationPlayback(): void {
    const narrationId = this.pendingNarrationPlaybackId;
    if (!narrationId) return;
    this.pendingNarrationPlaybackId = null;
    this.send({ type: 'narration.playback_started', narrationId });
  }

  private reportConnectionFailure(
    neoSessionId: string,
    code: RendererVoiceFailureReport['code'],
    phase: RendererVoiceFailureReport['phase'],
  ): void {
    if (this.reportedFailureCodes.has(code)) return;
    this.reportedFailureCodes.add(code);
    // 字幕落库只有 host 一个生产者。这里只上报受限失败事实，绝不在 renderer
    // 手搓 message 塞进 sessionStore；持久化与失败分母都由 host 的统一出口完成。
    void ipcService.invokeDomain(IPC_DOMAINS.VOICE, 'reportFailure', {
      neoSessionId,
      code,
      phase,
    } satisfies RendererVoiceFailureReport).catch(() => undefined);
  }

  /**
   * 通话失败的统一呈现出口（T3 分档，方案 §4.2）。
   *
   * - 到过 live 之后的失败：一律保留既有 error 态（中途断线有重连退避，不归分档管）。
   * - 从未到过 live 的 silent 档（用户修不了：上游 5xx / 429 / 握手失败）：收回通话
   *   槽位（reset，不留 chrome）+ toast 告知——不留一条点不动的红色僵尸通话条。
   * - actionable 档（用户能修：权限 / Key / 设备 / 他窗占用）：保留 error 态通话条
   *   + 引导文案，由 End 按钮显式收尾（既有行为）。
   */
  private presentFailure(entry: VoiceCallError): void {
    if (!this.hasGoneLive && VOICE_STARTUP_FAILURE_TIER[entry.code] === 'silent') {
      // 槽位收回后这条 WS 留着也是僵尸；关掉它，onclose 看到 idle 相位会直接返回。
      this.ws?.close();
      this.ws = null;
      this.store().reset();
      toast.error(resolveVoiceMessage(getT(), entry));
      return;
    }
    this.store().phaseChanged('error');
    this.store().eventApplied({ error: entry });
  }

  /**
   * final 到了不立刻清 partial——清了就有一段「哪里都没有这句话」的空窗
   * （落库是异步的，这里还要等 500ms 才去拉消息）。partial 现在渲染成流尾的临时气泡，
   * 空窗会变成肉眼可见的闪断。所以：临时气泡先顶着 final 文本，等真消息上屏后再撤。
   */
  private settledPartials: { user?: string; assistant?: string } = {};
  private settledAssistantResponseId: string | null = null;
  /** 用户 ASR 的 stash 是每个 item 的累计值；renderer 需要把 item 间前缀保留下来。 */
  private userTranscriptItemId: string | null = null;
  private userTranscriptPrefix = '';
  private userTranscriptSegment = '';

  /** user/assistant 各自等待落库；一侧 final 不得取消另一侧交接。 */
  private handoffDeadlines: Partial<Record<'user' | 'assistant', number>> = {};
  /** response 切换时旧轮已 flush，新轮等旧真消息接手后再写入单槽位。 */
  private assistantRevealBlockedUntil = 0;

  private resetUserTranscriptAccumulator(): void {
    this.userTranscriptItemId = null;
    this.userTranscriptPrefix = '';
    this.userTranscriptSegment = '';
  }

  private applyUserTranscript(event: Extract<VoiceEvent, { type: 'user.transcript' }>): string {
    if (event.itemId && this.userTranscriptItemId && event.itemId !== this.userTranscriptItemId) {
      this.userTranscriptPrefix = joinUserTranscriptParts(
        this.userTranscriptPrefix,
        this.userTranscriptSegment,
      );
      this.userTranscriptSegment = '';
    }
    if (event.itemId) this.userTranscriptItemId = event.itemId;
    this.userTranscriptSegment = event.text;
    return joinUserTranscriptParts(this.userTranscriptPrefix, this.userTranscriptSegment);
  }

  private releaseUserTranscriptPrefix(settled: string | undefined): void {
    if (settled === undefined) return;
    const current = joinUserTranscriptParts(this.userTranscriptPrefix, this.userTranscriptSegment);
    const remainder = removeUserTranscriptPrefix(current, settled);
    if (remainder === undefined) return;
    this.userTranscriptPrefix = '';
    this.userTranscriptSegment = remainder;
  }

  private scheduleReload(
    sessionId: string,
    settled?: 'user' | 'assistant',
    delayMs = 500,
    responseId?: string | null,
  ): void {
    if (settled) {
      this.settledPartials[settled] = settled === 'user'
        ? this.store().partialUser
        : this.store().partialAssistant;
      this.handoffDeadlines[settled] = Date.now() + VOICE_PARTIAL_HANDOFF_MAX_WAIT_MS;
      if (settled === 'assistant') this.settledAssistantResponseId = responseId ?? null;
    }
    const key = settled ?? 'generic';
    const previous = this.reloadTimers.get(key);
    if (previous) clearTimeout(previous);
    const run = async () => {
      this.reloadTimers.delete(key);
      await reloadVoiceSessionMessages(sessionId);
      // 真消息还没进消息流就撤气泡 = 空帧（R1 闪断）。继续顶着，隔一会儿再拉一次。
      // 一次拉不到是常态：host 落库比这里的 500ms 慢，且此前没有任何人会再拉第二次，
      // 于是那句话一直缺到挂断才被补拉回来——真机看到的「清空 → 再出现」就是这么来的。
      this.releaseSettledPartials();
      const deadline = settled ? this.handoffDeadlines[settled] ?? 0 : 0;
      if (settled && this.settledPartials[settled] !== undefined && Date.now() < deadline) {
        this.reloadTimers.set(key, setTimeout(run, delayMs));
      }
    };
    this.reloadTimers.set(key, setTimeout(run, delayMs));
  }

  /** @returns 待交接的临时气泡是否已全部撤完（false = 还得再等真消息）。 */
  private releaseSettledPartials(): boolean {
    const state = this.store();
    const messages = useSessionStore.getState().messages;
    const landed = (role: 'user' | 'assistant', text: string | undefined): boolean => {
      const fragment = text?.trim().replace(/\s+/g, ' ') ?? '';
      if (!fragment) return false;
      return messages.some((m) => {
        if (m.role !== role) return false;
        const content = m.content.trim().replace(/\s+/g, ' ');
        if (content === fragment) return true;
        // 单字符包含会把「好」误认成「好好」等别的真消息；合并判定只接受有辨识度的片段。
        return fragment.length >= 2 && content.includes(fragment);
      });
    };
    const settledUser = this.settledPartials.user;
    const patch = resolvePartialRelease(
      this.settledPartials,
      { user: state.partialUser, assistant: state.partialAssistant },
      {
        user: landed('user', this.settledPartials.user),
        assistant: landed('assistant', this.settledPartials.assistant),
      },
    );
    if (patch.partialUser !== undefined) {
      delete this.settledPartials.user;
      this.releaseUserTranscriptPrefix(settledUser);
    }
    if (patch.partialAssistant !== undefined) {
      delete this.settledPartials.assistant;
      this.settledAssistantResponseId = null;
      this.assistantRevealBlockedUntil = 0;
    }
    if (Object.keys(patch).length > 0) state.eventApplied(patch);
    return Object.keys(this.settledPartials).length === 0;
  }

  // ==========================================================================
  // 助手字幕揭示器（批 X5.5-A4）
  //
  // 上游按生成速度吐转写（实测 124 字 544ms 到齐），音频却要按真实时间播（同段 24.6 秒）。
  // 照 delta 到达直接上屏，字幕就比语音早跑完 20 多秒——用户看到的就是「攒整句一次性铺满」。
  // 所以这里把**内容**和**揭示时机**拆开：delta/final 只喂内容，揭示进度绑音频播放进度。
  // ==========================================================================

  /** 字幕内容真源：delta 累积，final 到达后换成 final 全文（防漂移）。 */
  private revealTarget = '';
  /** final 已到 = 内容不会再变，揭示到尾即可交接真消息。 */
  private revealFinalized = false;
  /** 本轮已入队的下行音频秒数（揭示比例的分母）。 */
  private audioEnqueuedSec = 0;
  /**
   * 播放队列排到几时（ms epoch）。与 Web Audio 的 nextStart 同款排程：
   * 新帧接在上一帧末尾，队列空了就从此刻重新起算。
   * 不直接读管线的 nextStart，是因为默认档的原生 AEC 把音频甩给 sidecar、压根没有播放时钟。
   */
  private playbackEndsAt = 0;
  private revealTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 上次真正写进 store 的那串字。存文本而不是长度：final 校正常常**不改长度只改内容**
   * （delta 拼接与 final 逐字不同），只比长度会把这次静默替换整个漏掉。
   */
  private revealedText = '';
  /** 播放进度上次推进的时刻，用于停滞兜底。 */
  private revealStallAt = 0;
  /** 上次看到的已播秒数——停滞判据打在它身上，见 tickReveal。 */
  private lastPlayedSec = 0;
  /** 揭示完成后才交接真消息的那条会话（§7.5 落库仍只有 host 一个生产者）。 */
  private pendingHandoffSessionId: string | null = null;
  private revealResponseId: string | null = null;

  private startRevealCycle(responseId?: string): void {
    this.revealResponseId = responseId ?? null;
    if (this.settledPartials.assistant !== undefined && this.assistantRevealBlockedUntil === 0) {
      this.assistantRevealBlockedUntil = this.handoffDeadlines.assistant
        ?? Date.now() + VOICE_PARTIAL_HANDOFF_MAX_WAIT_MS;
    }
    this.revealFinalized = false;
    this.revealedText = '';
    this.lastPlayedSec = 0;
    this.audioEnqueuedSec = 0;
    this.playbackEndsAt = 0;
    this.revealStallAt = Date.now();
    this.store().eventApplied({ assistantSpeaking: true });
  }

  private ensureRevealTicker(): void {
    if (this.revealTimer !== null) return;
    this.revealStallAt = Date.now();
    this.revealTimer = setInterval(() => this.tickReveal(), VOICE_SUBTITLE_REVEAL_INTERVAL_MS);
  }

  private tickReveal(): void {
    if (this.assistantRevealBlockedUntil > 0) {
      if (Date.now() < this.assistantRevealBlockedUntil) return;
      this.assistantRevealBlockedUntil = 0;
    }
    const backlogSec = Math.max(0, this.playbackEndsAt - Date.now()) / 1000;
    const playedSec = this.audioEnqueuedSec - backlogSec;
    // 停滞判据打在**播放进度**上，不打在揭示长度上：音频还在下发的那几秒里，
    // 已播和已入队同步增长、比例短暂持平，揭示长度就不动——那不是停滞。
    // 打错地方的代价是「整段字幕在第 3 秒被兜底一次性抖出来」，正是本单要修的病。
    if (playedSec > this.lastPlayedSec + 0.05) {
      this.lastPlayedSec = playedSec;
      this.revealStallAt = Date.now();
    }
    const computed = computeRevealedSubtitle(this.revealTarget, this.audioEnqueuedSec, playedSec);
    // 同一 response 内揭示长度只增不减。final 仍可用全等字符串替换已显示内容，
    // 但 final 比累计 delta 短、或音频队列突跳令比例下降时，不得把屏幕往回拉。
    const revealed = computed.length < this.revealedText.length ? this.revealedText : computed;
    if (revealed !== this.revealedText) {
      // 长度没变但内容变了（final 校正）也要写：这一步就是「防漂移」。
      this.revealedText = revealed;
      this.store().eventApplied({ partialAssistant: revealed });
    } else if (Date.now() - this.revealStallAt >= VOICE_SUBTITLE_STALL_FLUSH_MS) {
      // 停滞兜底：播放进度不动了（音频断供 / 这一轮压根没有音频）——
      // 剩下的一次放完。字幕绝不许永久悬在半句上。
      this.flushReveal();
      return;
    }
    if (this.revealFinalized && revealed.length >= this.revealTarget.length) this.endRevealCycle();
  }

  /** 立刻放完全文并结算（挂断 / teardown / 停滞兜底）。 */
  private flushReveal(): void {
    const flushed = this.revealTarget.length >= this.revealedText.length
      ? this.revealTarget
      : this.revealedText;
    if (flushed) this.store().eventApplied({ partialAssistant: flushed });
    this.endRevealCycle();
  }

  /**
   * 停表并结算。正常放完、被 barge-in 打断、挂断都走这里——
   * 待交接的真消息一律在这里补上，否则打断一次就再没人去拉那条已落库的消息。
   */
  private endRevealCycle(): void {
    const responseId = this.revealResponseId;
    if (this.revealTimer !== null) {
      clearInterval(this.revealTimer);
      this.revealTimer = null;
    }
    this.revealTarget = '';
    this.revealFinalized = false;
    this.revealedText = '';
    this.lastPlayedSec = 0;
    this.audioEnqueuedSec = 0;
    this.playbackEndsAt = 0;
    this.revealResponseId = null;
    const sessionId = this.pendingHandoffSessionId;
    this.pendingHandoffSessionId = null;
    if (sessionId) this.scheduleReload(sessionId, 'assistant', 500, responseId);
  }

  /**
   * 挂断后的第二次拉消息（现象 3·摘要卡延迟的根因）：
   * host teardown 要等 VOICE_TEARDOWN_DRAIN_MS（1500ms）排水窗才把摘要卡落库，
   * 而挂断时那次 reload 固定在 800ms——拉回来的消息里还没有摘要，之后又没有任何人
   * 再拉，于是「第一通挂断不显示，第二通挂断才把第一通的顶出来」。
   * 800ms 那次照留（字幕尾巴尽早上屏），排水窗之后再补一次拿摘要卡。
   */
  private hangupReloadTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleHangupSummaryReload(sessionId: string): void {
    if (this.hangupReloadTimer) clearTimeout(this.hangupReloadTimer);
    this.hangupReloadTimer = setTimeout(() => {
      this.hangupReloadTimer = null;
      void reloadVoiceSessionMessages(sessionId);
    }, VOICE_TEARDOWN_DRAIN_MS + 500);
  }

  /**
   * 焦点上报（§6.5）：只在通话中订阅，节流 ≥1s，内容没变不发。
   * 不通话时零开销——这是 appStore 的高频订阅，常开会让每次面板切换都过一遍。
   */
  private focusUnsubscribe: (() => void) | null = null;
  private lastFocusSentAt = 0;
  private lastFocusKey = '';
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  private startFocusReporting(): void {
    if (this.focusUnsubscribe) return;
    const push = () => {
      const context = selectVoiceFocusContext(useAppStore.getState());
      const key = JSON.stringify(context);
      if (key === this.lastFocusKey) return;
      const elapsed = Date.now() - this.lastFocusSentAt;
      if (elapsed < VOICE_FOCUS_REPORT_MIN_INTERVAL_MS) {
        // 节流窗内的变化不能直接丢：丢了就永远停在旧焦点上（用户切走再没动过）。
        if (this.focusTimer) return;
        this.focusTimer = setTimeout(() => {
          this.focusTimer = null;
          push();
        }, VOICE_FOCUS_REPORT_MIN_INTERVAL_MS - elapsed);
        return;
      }
      this.lastFocusKey = key;
      this.lastFocusSentAt = Date.now();
      this.send({ type: 'focus', context });
    };
    this.focusUnsubscribe = useAppStore.subscribe(push);
    push(); // 建连即报一次当前焦点，别等用户去切面板
  }

  private stopFocusReporting(): void {
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = null;
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.lastFocusKey = '';
    this.lastFocusSentAt = 0;
  }

  async dial(sessionId: string): Promise<void> {
    const { phase } = this.store();
    if (phase === 'connecting' || phase === 'live') return;

    // 旧连接必须先关：error 态下上一条 WS 往往还开着，不关会被 host 单路互斥
    // 挡成 VOICE_SESSION_BUSY（spike 真机 2026-07-26）。
    this.ws?.close();
    this.ws = null;
    this.audio?.stop();
    this.audio = null;
    this.settledPartials = {};
    this.settledAssistantResponseId = null;
    this.resetUserTranscriptAccumulator();
    this.assistantRevealBlockedUntil = 0;
    for (const timer of this.reloadTimers.values()) clearTimeout(timer);
    this.reloadTimers.clear();
    this.handoffDeadlines = {};
    // 新一通电话不继承上一通的揭示残留，也不替上一通补交接。
    this.pendingHandoffSessionId = null;
    this.endRevealCycle();
    this.audioReady = null;
    this.pendingAudioDiagnostics = [];
    this.fallbackWarningShown = false;
    this.stopInputDeviceMonitoring();
    this.cancelledResponseIds.clear();
    this.reportedFailureCodes.clear();
    this.pausedCandidateId = null;
    this.playbackPausedAt = 0;
    this.pendingNarrationPlaybackId = null;

    const activeAgentId = readActiveAgentSessionMap()[sessionId];
    const {
      interruptMode,
      echoCancellation,
      inputDevice,
      conversationModel,
      costLimit,
      costLimitAction,
    } = await readVoiceRuntimeSettings();
    if (useVoiceCallStore.getState().phase !== 'idle') return; // await 期间状态被改，别抢
    this.inputDevice = inputDevice;
    this.interruptMode = interruptMode;
    this.echoCancellation = echoCancellation;
    this.conversationModel = conversationModel;
    this.accumulatedUsage = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputAudioTokens: 0,
      inputTextTokens: 0,
      outputAudioTokens: 0,
      outputTextTokens: 0,
    };
    this.store().dialStarted(sessionId, activeAgentId, interruptMode);
    this.store().costConfigured(costLimit, costLimitAction);
    this.intentionalClose = false;
    this.hasGoneLive = false;
    this.reconnectAttempt = 0;

    this.openSocket(sessionId, activeAgentId, interruptMode, echoCancellation);
  }

  /**
   * 建一条媒体面 WS 并接管它。首次拨号和断线重连共用——重连换的是 socket，
   * 不是通话：store 不 reset，host 侧在宽限窗里认得同一条会话（见 attachVoiceClient）。
   */
  private openSocket(
    sessionId: string,
    activeAgentId: string | undefined,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): void {
    const ws = new WebSocket(buildStreamUrl(sessionId, activeAgentId));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.audioReady = this.startAudio(ws, interruptMode, echoCancellation);
      void this.startInputDeviceMonitoring();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.audio?.enqueuePlayback(new Int16Array(event.data));
        // 字幕揭示进度绑的就是这条播放时间轴（批 X5.5-A4）。
        const frameSec = event.data.byteLength / 2 / VOICE_DOWNSTREAM_SAMPLE_RATE;
        this.audioEnqueuedSec += frameSec;
        this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + frameSec * 1000;
        this.store().eventApplied({ assistantSpeaking: true });
        return;
      }
      let voiceEvent: VoiceEvent;
      try {
        voiceEvent = JSON.parse(String(event.data)) as VoiceEvent;
      } catch {
        return;
      }
      this.handleEvent(voiceEvent, sessionId);
    };

    ws.onerror = () => {
      // 重连尝试失败不算「握手失败」——它由 onclose 走退避，别在这里先把 phase 打成 error
      // 把重连路径掐死（那样第一次抖动就直接变成不可恢复）。
      if (!opened && !this.store().reconnecting) {
        // 先上报（失败这件事必须落库，与怎么呈现无关），再按档位呈现。
        this.reportConnectionFailure(sessionId, 'HANDSHAKE_FAILED', 'handshake');
        this.presentFailure({ code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake });
      }
    };

    ws.onclose = (closeEvent) => {
      this.pendingNarrationPlaybackId = null;
      this.audio?.stop();
      this.audio = null;
      this.audioReady = null;
      this.stopInputDeviceMonitoring();
      // 音频没了，揭示进度再没有可绑的时间轴：就地放完剩余全文（host teardown / 断线重连同理）。
      this.flushReveal();
      if (this.ws === ws) this.ws = null;
      const { phase } = this.store();
      if (phase === 'idle') return;
      // 首次握手就没成：这不是断线，是压根没连上，重连也没意义。
      if (!opened && !this.store().reconnecting) {
        if (phase === 'connecting') {
          this.reportConnectionFailure(sessionId, 'HANDSHAKE_FAILED', 'handshake');
          this.presentFailure({ code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake });
        }
        return;
      }
      this.stopFocusReporting();
      // host 说「这通电话结束了」（模型挂断 / watchdog / 上游死 / 互斥抢占）带终止 close code。
      // 它不是抖动，重连等于当场拨出一通新电话——2026-07-30 真机就是这么在挂断 2 秒后
      // 冒出一通 16 秒空通话，通话条不落、计时继续走，用户以为压根没挂断。
      const hostTerminated = closeEvent.code === VOICE_WS_CLOSE_TERMINAL;
      // 用户没挂断却断了 = 网络抖动，试着接回同一通电话（host 侧有宽限窗）。
      if (!hostTerminated && !this.intentionalClose && phase !== 'error' && this.scheduleReconnect(sessionId, activeAgentId, interruptMode, echoCancellation)) return;
      // host 侧关闭（挂断/上游死/超时）：摘要落库有一点延迟，稍后再拉一次。
      this.scheduleReload(sessionId, undefined, 800);
      this.scheduleHangupSummaryReload(sessionId);
      // error 态不 reset：把错误留在 chrome 上给用户看，由 End 按钮显式收尾；
      // 否则上游报错一闪而过，用户只看到通话凭空消失。
      // （启动期 silent 档失败在 presentFailure 里已直接 reset + toast，到不了 error 态。）
      if (phase !== 'error') this.store().reset();
    };
  }

  /**
   * 排一次重连。返回 true = 已接管（调用方别再收尾）。
   * 退避用完还没回来就如实报断线——**不许静默假装还在通话**。
   */
  private scheduleReconnect(
    sessionId: string,
    activeAgentId: string | undefined,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): boolean {
    const delay = VOICE_RECONNECT_BACKOFF_MS[this.reconnectAttempt];
    if (delay === undefined) {
      this.reportConnectionFailure(sessionId, 'RECONNECT_FAILED', 'reconnect');
      this.presentFailure({ code: 'RECONNECT_FAILED', message: getT().voice.error.reconnectFailed });
      return true;
    }
    this.reconnectAttempt += 1;
    // 上限必须从退避表推导——UI 不许另写数字，否则改退避表的人不会记得回来改 UI。
    this.store().reconnectingChanged(true, {
      attempt: this.reconnectAttempt,
      maxAttempts: VOICE_RECONNECT_BACKOFF_MS.length,
    });
    this.store().phaseChanged('connecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 期间用户自己挂了 / 切走了就别再连
      if (this.store().phase === 'idle' || this.intentionalClose) return;
      this.openSocket(sessionId, activeAgentId, interruptMode, echoCancellation);
    }, delay);
    return true;
  }

  private webAudioCallbacks(ws: WebSocket) {
    return {
      onFrame: (pcm16k: Int16Array) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
      },
      onLevels: (mic: number, playback: number) => this.store().levelsChanged(mic, playback),
      onPlaybackStarted: () => this.acknowledgeNarrationPlayback(),
      onError: (code: VoiceMessageCode, detail?: string) => {
        // message 只作兜底/排查；给用户看的文案由 resolveVoiceMessage 按 code 查 i18n。
        this.presentFailure({ code, message: detail ?? code });
      },
    };
  }

  private warnAecFallback(): void {
    if (this.fallbackWarningShown) return;
    this.fallbackWarningShown = true;
    showVoiceAecFallbackWarning(getT().voice.echoHint.fallback);
  }

  /**
   * @param involuntary 非自愿降级（原生 AEC 本该可用却没用上）才报警告。
   *   用户在设置里显式选了「强制关」不是降级——那是他的选择，每通电话报一次
   *   「原生回声消除当前不可用」等于把用户的设置说成故障。
   */
  private async startWebAudio(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    involuntary: boolean,
  ): Promise<'headphones'> {
    const pipeline = new VoiceAudioPipeline(this.webAudioCallbacks(ws), this.inputDevice);
    pipeline.setCaptureOpen(interruptMode === 'server_vad');
    this.audio = pipeline;
    if (involuntary) this.warnAecFallback();
    await pipeline.start();
    // 与 native 分支同款的 post-await 竞态复查：getUserMedia 期间 WS 可能已关
    // （真机降级到耳机模式走的正是这条路），不复查的话管线会漏到通话外继续占麦。
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      pipeline.stop();
      return 'headphones';
    }
    return 'headphones';
  }

  /**
   * 本次通话音频管线的判定原因（批 X §5）。原生 AEC 的失败此前被 catch 静默吞掉，
   * 真机「AEC 没起来」在任何日志里都查不到。记下原因，live 后经 audio_mode 命令
   * 送 host 落日志——renderer 自己的 logger 只进 console，事后取不到证。
   */
  private audioModeReason = '';

  private reportAudioDiagnostic(code: string): void {
    if (this.store().phase === 'live') {
      this.send({ type: 'audio_diagnostic', code });
    } else {
      this.pendingAudioDiagnostics.push(code);
    }
  }

  private async startAudio(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): Promise<'native_aec' | 'headphones'> {
    // 用户显式关掉 = 自愿走耳机模式，不报降级；非 macOS/原生壳不可用 = 非自愿，要报。
    if (echoCancellation === 'off') {
      this.audioModeReason = 'user-off';
      return this.startWebAudio(ws, interruptMode, false);
    }
    if (!isNativeDesktopAvailable()) {
      this.audioModeReason = 'no-native-shell';
      return this.startWebAudio(ws, interruptMode, true);
    }

    const pipeline = new NativeVoiceAudioPipeline(
      {
        onFrame: (pcm16k) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
        },
        onLevels: (mic, playback) => this.store().levelsChanged(mic, playback),
        onPlaybackStarted: () => this.acknowledgeNarrationPlayback(),
        onError: () => {
          void this.fallbackFromNative(ws, interruptMode, pipeline);
        },
        onDiagnostic: (code) => this.reportAudioDiagnostic(code),
      },
      this.inputDevice,
    );
    pipeline.setCaptureOpen(interruptMode === 'server_vad');
    this.audio = pipeline;
    try {
      await pipeline.start();
      this.audioModeReason = 'native-aec-started';
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        pipeline.stop();
        return 'native_aec';
      }
      return 'native_aec';
    } catch (error) {
      // 失败原因是「环境还是代码」判因的唯一证据，绝不再静默吞。
      this.audioModeReason = `native-start-failed: ${error instanceof Error ? error.message : String(error)}`;
      if (this.audio === pipeline) {
        pipeline.stop();
        this.audio = null;
      }
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return 'headphones';
      return this.startWebAudio(ws, interruptMode, true);
    }
  }

  private async fallbackFromNative(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    failedPipeline: NativeVoiceAudioPipeline,
  ): Promise<void> {
    if (this.audio !== failedPipeline || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    failedPipeline.stop();
    this.audio = null;
    // 运行中降级同样要留痕（start 成功后原生管线半路死掉这一档）。
    this.audioModeReason = 'native-runtime-error';
    this.send({ type: 'audio_mode', mode: 'headphones', reason: this.audioModeReason });
    await this.startWebAudio(ws, interruptMode, true);
    if (this.ws !== ws || this.store().phase !== 'live') return;
    const text = getT().voice.echoHint;
    void maybeShowSpeakerEchoHint({ message: text.message, dontShowAgain: text.dontShowAgain });
  }

  /**
   * 通话中设备恢复/断开只重启采集管线，不重连 WS、也不重发任务。
   * 设备枚举失败保持现状；只有“可用性确实翻转”才切一次，避免 devicechange 风暴。
   */
  private async startInputDeviceMonitoring(): Promise<void> {
    this.stopInputDeviceMonitoring();
    if (!this.inputDevice) return;
    const monitoredWs = this.ws;
    const monitoredInputDevice = this.inputDevice;
    if (monitoredWs?.readyState !== WebSocket.OPEN) return;
    const mediaDevices = navigator.mediaDevices;
    if (typeof mediaDevices?.addEventListener !== 'function') return;
    const initialAvailability = await readPreferredVoiceInputAvailability(monitoredInputDevice, mediaDevices);
    // enumerateDevices may resolve after hangup/reconnect. Never attach an old
    // call's listener to the next call.
    if (
      this.ws !== monitoredWs
      || monitoredWs.readyState !== WebSocket.OPEN
      || this.inputDevice !== monitoredInputDevice
      || this.store().phase === 'idle'
    ) return;
    this.preferredInputAvailable = initialAvailability;
    const handler = () => {
      if (this.ws !== monitoredWs || this.inputDevice !== monitoredInputDevice || this.store().phase === 'idle') {
        return;
      }
      this.inputDeviceSwitchQueue = this.inputDeviceSwitchQueue
        .then(async () => {
          if (this.ws !== monitoredWs || this.inputDevice !== monitoredInputDevice || this.store().phase === 'idle') {
            return;
          }
          const next = await readPreferredVoiceInputAvailability(monitoredInputDevice, mediaDevices);
          if (this.ws !== monitoredWs || this.inputDevice !== monitoredInputDevice || this.store().phase === 'idle') {
            return;
          }
          if (next === null || next === this.preferredInputAvailable) return;
          this.preferredInputAvailable = next;
          await this.restartAudioForInputDeviceChange(monitoredWs);
        })
        .catch(() => undefined);
    };
    this.inputDeviceChangeHandler = handler;
    mediaDevices.addEventListener('devicechange', handler);
  }

  private stopInputDeviceMonitoring(): void {
    if (this.inputDeviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.inputDeviceChangeHandler);
    }
    this.inputDeviceChangeHandler = null;
    this.preferredInputAvailable = null;
  }

  private async restartAudioForInputDeviceChange(ws: WebSocket): Promise<void> {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || this.store().phase === 'idle') return;
    const previous = this.audio;
    previous?.stop();
    if (this.audio === previous) this.audio = null;
    const ready = this.startAudio(ws, this.interruptMode, this.echoCancellation);
    this.audioReady = ready;
    await ready;
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || !this.audio) return;
    const state = this.store();
    this.audio.setMuted(state.muted);
    this.audio.setCaptureOpen(
      this.interruptMode === 'server_vad' ? true : state.pttCaptureOn,
    );
  }

  private handleEvent(event: VoiceEvent, sessionId: string): void {
    switch (event.type) {
      case 'state':
        if (event.state === 'live') {
          this.hasGoneLive = true;
          this.store().phaseChanged('live');
          // 接回来了：退避计数归零，下次抖动重新拿满次数。
          this.reconnectAttempt = 0;
          this.store().reconnectingChanged(false);
          this.startFocusReporting();
          // 耳机提示只在真走了 WebView 管线（没有原生 AEC）时才有意义。
          const ready = this.audioReady;
          void (async () => {
            const mode = await ready;
            // 管线判定结果送 host 落日志（批 X §5）：ws 此刻已 live，正是能送的时点。
            if (mode) this.send({ type: 'audio_mode', mode, reason: this.audioModeReason || 'unknown' });
            for (const code of this.pendingAudioDiagnostics.splice(0)) {
              this.send({ type: 'audio_diagnostic', code });
            }
            if (mode !== 'headphones' || this.store().phase !== 'live') return;
            const text = getT().voice.echoHint;
            await maybeShowSpeakerEchoHint({ message: text.message, dontShowAgain: text.dontShowAgain });
          })();
        } else if (event.state === 'connecting') {
          this.store().phaseChanged('connecting');
        }
        // closed 由 ws.onclose 统一收尾（host 关上游后会关 client）
        break;
      case 'speech.started':
        {
          const candidateId = event.candidateId ?? `legacy-${Date.now()}`;
          const playback = this.audio?.getPlaybackState?.() ?? {
            playing: this.store().assistantSpeaking,
            playedMs: 0,
            queuedMs: 0,
          };
          if (playback.playing) {
            this.audio?.pausePlayback?.();
            this.pausedCandidateId = candidateId;
            this.playbackPausedAt = Date.now();
          }
          this.send({ type: 'interrupt.playback', candidateId, ...playback });
        }
        this.store().eventApplied({
          userSpeaking: true,
        });
        break;
      case 'speech.stopped':
        break;
      case 'response.created':
        this.pendingNarrationPlaybackId = event.narrationId ?? null;
        break;
      case 'response.cancelled':
        this.pendingNarrationPlaybackId = null;
        this.cancelledResponseIds.add(event.responseId);
        while (this.cancelledResponseIds.size > 32) {
          const oldest = this.cancelledResponseIds.values().next().value as string | undefined;
          if (!oldest) break;
          this.cancelledResponseIds.delete(oldest);
        }
        if (
          this.revealResponseId === event.responseId
          || this.settledAssistantResponseId === event.responseId
        ) {
          // 被取消的轮没有真消息可交接，先清 handoff 再停 reveal，避免 reload 把旧消息拉回来。
          this.pendingHandoffSessionId = null;
          this.assistantRevealBlockedUntil = 0;
          const assistantReload = this.reloadTimers.get('assistant');
          if (assistantReload) clearTimeout(assistantReload);
          this.reloadTimers.delete('assistant');
          delete this.settledPartials.assistant;
          this.settledAssistantResponseId = null;
          this.endRevealCycle();
          this.store().eventApplied({ partialAssistant: '', assistantSpeaking: false });
        }
        break;
      case 'interrupt.decision':
        if (
          event.classification === 'background'
          || event.classification === 'acknowledgement'
          || event.classification === 'short_fragment'
        ) {
          delete this.settledPartials.user;
          this.resetUserTranscriptAccumulator();
          this.store().eventApplied({ partialUser: '', userSpeaking: false });
        }
        if (event.action === 'resume') {
          if (this.pausedCandidateId === event.candidateId) {
            this.audio?.resumePlayback?.();
            if (this.playbackPausedAt) this.playbackEndsAt += Date.now() - this.playbackPausedAt;
            const playback = this.audio?.getPlaybackState?.();
            this.store().eventApplied({
              assistantSpeaking: playback?.playing ?? this.store().assistantSpeaking,
            });
          }
        } else {
          this.audio?.clearPlayback();
          if (!event.responseId || this.revealResponseId === event.responseId) {
            this.pendingHandoffSessionId = null;
            this.endRevealCycle();
            this.store().eventApplied({
              assistantSpeaking: false,
              ...(this.settledPartials.assistant === undefined ? { partialAssistant: '' } : {}),
            });
          }
        }
        if (this.pausedCandidateId === event.candidateId) {
          this.pausedCandidateId = null;
          this.playbackPausedAt = 0;
        }
        break;
      case 'user.transcript':
        {
          const partialUser = this.applyUserTranscript(event);
          if (event.done) {
            // 顶着 final 文本等真消息上屏（见 scheduleReload）；这里不清空
            this.store().eventApplied({ userSpeaking: false, partialUser });
            this.scheduleReload(sessionId, 'user');
          } else {
            this.store().eventApplied({ partialUser });
          }
        }
        break;
      case 'assistant.transcript':
        if (event.responseId && this.cancelledResponseIds.has(event.responseId)) break;
        if (event.done) {
          // final 是**内容真源，不是揭示时机**（批 X5.5-A4 设计修订）：已揭示的前缀若与 final
          // 不一致，以 final 为准静默替换；未揭示的部分继续按播放进度放出，不跳变到全文——
          // final 在语音播完前 20 秒就到了，全文覆盖等于当场把字幕拍到结尾。
          this.revealTarget = event.text;
          this.revealFinalized = true;
          // 真消息交接推迟到揭示完成，否则 15s 处一次性换脸，前面的节流全白做。
          this.pendingHandoffSessionId = sessionId;
          if (this.revealTimer === null) this.flushReveal();
          else this.tickReveal();
        } else {
          if (event.responseId && this.revealResponseId && event.responseId !== this.revealResponseId) {
            this.flushReveal();
            if (this.settledPartials.assistant !== undefined) {
              this.assistantRevealBlockedUntil = this.handoffDeadlines.assistant
                ?? Date.now() + VOICE_PARTIAL_HANDOFF_MAX_WAIT_MS;
            }
          }
          if (!this.revealTarget) this.startRevealCycle(event.responseId);
          this.revealTarget += event.text;
          this.ensureRevealTicker();
        }
        break;
      case 'response.done':
        if (event.responseId && this.cancelledResponseIds.has(event.responseId)) break;
        if (event.usage) {
          const alreadyExceeded = this.store().costLimitExceeded;
          this.accumulatedUsage = addVoiceTokenUsage(this.accumulatedUsage, event.usage);
          const estimate = estimateRealtimeVoiceCost(this.conversationModel, this.accumulatedUsage);
          this.store().usageApplied(this.accumulatedUsage, estimate);
          const costState = this.store();
          if (!alreadyExceeded && costState.costLimitExceeded) {
            const formatted = estimate
              ? `${estimate.currency === 'CNY' ? '¥' : '$'}${estimate.amount.toFixed(4)}`
              : '';
            toast.warning(getT().voice.live.costLimitReached.replace('{cost}', formatted));
            if (costState.costLimitAction === 'hangup') this.hangUp();
          }
        }
        this.store().eventApplied({
          assistantSpeaking: false,
          ttfa: { modelMs: event.ttfaModelMs, perceivedMs: event.ttfaPerceivedMs },
        });
        break;
      case 'work.upsert':
        this.store().eventApplied({ workItem: event.item });
        break;
      case 'notice':
        this.store().eventApplied({
          notice: { code: event.code, message: event.message, ...(event.detail ? { detail: event.detail } : {}) },
        });
        break;
      case 'session.ended':
        this.intentionalClose = true;
        this.pendingNarrationPlaybackId = null;
        this.flushReveal();
        this.stopFocusReporting();
        this.audio?.stop();
        this.audio = null;
        this.audioReady = null;
        this.stopInputDeviceMonitoring();
        this.scheduleReload(sessionId, undefined, 800);
        this.scheduleHangupSummaryReload(sessionId);
        this.store().reset();
        if (event.reason === 'idle-timeout') toast.info(getT().voice.status.idleTimeout);
        break;
      case 'error':
        this.presentFailure({
          code: event.code,
          message: event.message,
          ...(event.detail ? { detail: event.detail } : {}),
        });
        break;
      default:
        break;
    }
  }

  hangUp(): void {
    this.intentionalClose = true;
    this.pendingNarrationPlaybackId = null;
    // 挂断即定稿：把没揭示完的尾巴一次放完并停表，通话结束不留半句，
    // 也不留一个还在往已 reset 的 store 里写字的定时器。
    this.flushReveal();
    this.stopFocusReporting();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.send({ type: 'end' });
    this.ws?.close();
    this.ws = null;
    this.audio?.stop();
    this.audio = null;
    this.audioReady = null;
    this.stopInputDeviceMonitoring();
    const { sessionId } = this.store();
    if (sessionId) {
      this.scheduleReload(sessionId, undefined, 800);
      this.scheduleHangupSummaryReload(sessionId);
    }
    this.store().reset();
  }

  toggleMute(): void {
    const muted = !this.store().muted;
    this.audio?.setMuted(muted);
    this.store().muteChanged(muted);
  }

  /** PTT：按住开始推流。 */
  pttDown(): void {
    if (this.store().phase !== 'live') return;
    this.audio?.setCaptureOpen(true);
    this.store().pttCaptureChanged(true);
  }

  /** PTT：松开即提交这一轮（turn_detection=null 路径，批 A 已可配置）。 */
  pttUp(): void {
    if (!this.store().pttCaptureOn) return;
    this.audio?.setCaptureOpen(false);
    this.store().pttCaptureChanged(false);
    this.send({ type: 'commit' });
  }

  /** manual 模式：点按开始、再点按提交。 */
  manualTap(): void {
    if (this.store().pttCaptureOn) this.pttUp();
    else this.pttDown();
  }
}

export const voiceCallBridge = new VoiceCallBridge();
