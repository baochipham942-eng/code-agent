// ============================================================================
// VoiceSessionService —— Phase 0 最小实现
//
// 职责：全局单路互斥、生命周期、Renderer WS ↔ 上游 transport 的内存中继。
// 媒体面：Renderer 二进制帧 = PCM16@16k 单声道上行；Host 二进制帧 = PCM16@24k 下行。
//         控制/事件面走同一条 WS 的文本帧（JSON）。音频帧不落盘、不进日志。
// ============================================================================

import type { WebSocket as WsSocket } from 'ws';
import { resolveConversationModelOption, VOICE_DOWNSTREAM_SAMPLE_RATE, VOICE_END_CALL_GOODBYE_TIMEOUT_MS, VOICE_HANGUP_REACTION_WINDOW_MS, VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS, VOICE_RECONNECT_GRACE_MS, VOICE_SESSION_MAX_DURATION_MS, VOICE_TEARDOWN_DRAIN_MS, VOICE_TRANSCRIPT_MERGE_WINDOW_MS, VOICE_WS_CLOSE_TERMINAL } from '../../../shared/constants/voice';
import {
  REALTIME_VOICE_PROVIDER_PROFILES,
  resolveRealtimeVoiceSelection,
  type RealtimeVoiceProviderProfile,
} from '../../../shared/constants/realtimeVoiceProviders';
import type { VoiceClientCommand, VoiceEvent, VoiceFocusContext, VoiceInterruptClassification, VoiceTokenUsage, VoiceTransportHandle, VoiceUserTextInjectionResult } from '../../../shared/contract/voice';
import type { VoiceTransport } from '../../../shared/contract/voice';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { getConfigService } from '../core/configService';
import { getSessionManager } from '../infra/sessionManager';
import { getPermissionModeManager } from '../../permissions/modes';
import { qwenOmniTransport } from './qwenOmniTransport';
import { createRealtimeTransport } from './realtimeTransport';
import {
  getRealtimeVoiceProviderApiKey,
  resolveConfiguredRealtimeVoiceProfile,
} from './customRealtimeVoiceProviders';
import { resolveVoiceRouting } from './voiceRouting';
import { beginVoiceDispatch, endVoiceDispatch, pushVoiceTranscript, setVoiceDispatchFocus } from './voiceAgentCoordinator';
import { composeVoiceInstructions, focusChanged, type VoiceContinuityContext } from './voiceContextAssembler';
import { isVoiceScreenContextSupported } from './voiceScreenContext';
import { addTokenUsage, recordVoiceCall } from './voiceUsageLedger';
import { consumeVoiceCallFailure, observeVoiceEventFailure, persistVoiceCallFailure } from './voiceFailurePersistence';
import { VOICE_TOOL_DEFINITIONS, executeVoiceTool } from './voiceTools';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';
import { reportVoiceWorkFailure } from './voiceWorkFailureReporter';
import { detectHangupIntent } from './hangupIntent';
import { decideVoiceInterrupt, shouldDisarmHangup } from './voiceTurnTaking';
import {
  createNarrationState,
  markNarrationDispatch,
  dismissNarrationsByPrefix,
  enqueueOrInjectNarration,
  flushNarrationQueue,
  handleNarrationInjectionRejected,
  handleNarrationPlaybackInterrupted,
  handleNarrationPlaybackStarted,
  markNarrationUserTurn,
  settleNarrationsForTeardown,
  type NarrationState,
} from './voiceNarrationQueue';
import {
  beginVoiceQuestionSession,
  endVoiceQuestionSession,
  handleVoiceQuestionTranscript,
} from './voiceQuestionBridge';

const logger = createLogger('VoiceSession');

/** 读设置页「实时通话」组；读不到一律 undefined（= 全部走默认），绝不让设置读写炸掉通话。 */
function readVoiceLiveSettings(): VoiceLiveSettings | undefined {
  try {
    return getConfigService().getSettings().voice?.live;
  } catch {
    return undefined;
  }
}

/**
 * 新拨号才读取连续性；宽限窗重连直接复用 active，不会重复扫消息流。
 *
 * TaskManager.sessionStates 是进程内 Map，app 重启后会回到 idle。此时即使 DB 里还有未结算的
 * voiceDispatch，也宁可不注入 work item 半段，避免把陈旧记录伪报成仍在运行；transcript 半段
 * 仍由 DB 正常恢复。消息读取或状态读取失败同样整体降级为空，不阻断拨号。
 */
async function loadVoiceContinuity(neoSessionId: string): Promise<VoiceContinuityContext | null> {
  try {
    // 严格顺序：消息源不可用时不要提前拉起 TaskManager 依赖树，降级路径不能留下悬空 import。
    const messages = await getSessionManager().getMessages(neoSessionId);
    const { getTaskManager } = await import('../../task');
    return {
      neoSessionId,
      sourceSessionId: neoSessionId,
      messages,
      taskState: getTaskManager().getSessionState(neoSessionId),
      now: Date.now(),
    };
  } catch (err) {
    logger.warn('voice continuity unavailable', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * 语言偏好走 instructions 而不是上游参数：DashScope 的 input_audio_transcription
 * 语言参数本批未真机验证，不赌；在短人设后追加一句对话语言约束是验证过的路径。
 */
function withLanguageDirective(instructions: string, language: VoiceLiveSettings['language']): string {
  if (language === 'zh') return `${instructions}\n请始终用中文与用户对话。`;
  if (language === 'en') return `${instructions}\nAlways converse with the user in English.`;
  return instructions;
}

interface VoiceInterruptCandidate {
  itemId?: string;
  startedAt: number;
  durationMs?: number;
  assistantPlaying?: boolean;
  classification?: VoiceInterruptClassification;
  classificationSource?: 'empty-text-fallback' | 'transcript';
  emptyTextFallbackObserved?: boolean;
  decided: boolean;
  cancelledResponseId?: string;
  responseRequested: boolean;
  finalGraceTimer?: NodeJS.Timeout;
}

interface ActiveSession {
  id: string;
  neoSessionId: string;
  startedAt: number;
  /**
   * 当前这条 Renderer WS。重连会**换掉它**而不换通话——所以上游回调必须通过这个
   * 可变引用发，不能闭包捕获建连那一刻的 socket。
   */
  clientRef: { current: WsSocket };
  upstream: VoiceTransportHandle;
  /** 上游是否真实收下了通话工具；VOICE_TOOLS_DROPPED 后 fail-closed。 */
  voiceToolsAvailable: boolean;
  /** teardown 已开始时，新的打字注入必须回退，不能再抢这通电话。 */
  ending: boolean;
  maxDurationTimer: NodeJS.Timeout;
  /** 非 null = 客户端断了，正在宽限窗里等它回来 */
  graceTimer: NodeJS.Timeout | null;
  /** relay 媒体面首帧健康探针；重连沿用同一份计数，不重复报警。 */
  inboundAudioFrames: number;
  inboundAudioWatchdogTimer: NodeJS.Timeout | null;
  /** 本次通话派出去的任务数，进通话摘要 */
  workItemCount: number;
  /** 本次通话成功落库的字幕条数，进通话摘要（旧记录没有 = 旧版本通话的判据） */
  transcriptCounter: { count: number };
  /** 助手字幕按 response 隔离；旧轮晚到不能拼进下一轮。 */
  transcriptBuf: { assistantByResponse: Map<string, string> };
  /** 上一条落库的用户字幕，供 R5 连续字幕并入上一条 */
  transcriptMerge: TranscriptMergeState;
  /** 通话身份的短人设，焦点刷新时要和 Focus 段一起重拼 */
  personaInstructions: string;
  /** 当前已下发给上游的完整 instructions，用于语速/焦点刷新去重。 */
  instructions: string;
  /** 本次通话真用的上游模型（设置白名单解析后），挂断摘要如实记它 */
  conversationModel: string;
  /** 新拨号时从 DB + TaskManager 取到的上一通上下文；焦点刷新重拼 instructions 时必须保留。 */
  continuity: VoiceContinuityContext | null;
  /** 用户此刻在看什么（Renderer 节流上报） */
  focus: VoiceFocusContext | null;
  interruption: {
    currentCandidateId: string | null;
    candidates: Map<string, VoiceInterruptCandidate>;
  };
  /** 上游 cancel 后仍可能把旧 delta/final/done 发完；Host 与 Renderer 各自 fail-closed。 */
  cancelledResponseIds: Set<string>;
  /** assistant final 先暂存，到 response.done 且未取消时才落库。 */
  pendingAssistantFinals: Map<string, { text: string; itemId?: string }>;
  /** 一通电话可有多轮 response；排水窗结束前到达的 provider usage 都归入本通。 */
  tokenUsage: { value?: VoiceTokenUsage; accepting: boolean };
  /** 终态播报只属于这通电话：压住、去重与已播记录都随 active 一起销毁。 */
  narration: NarrationState;
}

// ponytail: 单进程内一个模块级变量就是「全局单路」的全部实现（方案 §2.6）。
// 多进程/多窗口场景真出现时再抬到共享状态。
let active: ActiveSession | null = null;
const openaiRealtimeTransport = createRealtimeTransport(
  REALTIME_VOICE_PROVIDER_PROFILES['openai-realtime'],
);

function resolveVoiceTransport(profile: RealtimeVoiceProviderProfile): VoiceTransport {
  if (profile.id === 'dashscope-qwen-omni') return qwenOmniTransport;
  if (profile.id === 'openai-realtime') return openaiRealtimeTransport;
  return createRealtimeTransport(profile);
}

function resolveVoiceApiKey(profile: RealtimeVoiceProviderProfile): string | undefined {
  if (profile.id === 'dashscope-qwen-omni') return getDashscopeApiKey();
  return getRealtimeVoiceProviderApiKey(profile);
}
// 建上游连接是 await，闸门必须在 await 之前就合上：只看 active 的话，两路并发拨号
// 会同时通过检查、各建一条上游连接（都在计费，其中一条永远无人释放）。
let connecting = false;
let sessionSeq = 0;

export function getActiveVoiceSessionId(): string | null {
  return active?.id ?? null;
}

/**
 * 忙态文本的唯一通话注入口。renderer 不猜 replace/steer，直接把原话交给通话 brain。
 * 任何 host 侧不能保证送达的情况都返回 fallback，由 renderer 复用已有 durable queue；
 * 这条函数本身不创建文本轮，避免挂断竞态下凭空启动一轮 agent。
 */
export async function injectVoiceUserText(
  neoSessionId: string,
  text: string,
): Promise<VoiceUserTextInjectionResult> {
  const trimmed = text.trim();
  if (!trimmed) return { outcome: 'fallback', reason: 'empty_text' };

  if (active?.neoSessionId !== neoSessionId || active.ending || active.graceTimer) {
    return { outcome: 'fallback', reason: 'no_active_call' };
  }
  const session = active;
  if (!session.voiceToolsAvailable) {
    logger.info('typed voice input falling back: tools unavailable', { voiceSessionId: session.id });
    return { outcome: 'fallback', reason: 'tools_unavailable' };
  }
  if (session.upstream.kind !== 'relay') {
    logger.info('typed voice input falling back: transport has no inject channel', {
      voiceSessionId: session.id,
      provider: session.upstream.provider,
    });
    return { outcome: 'fallback', reason: 'transport_unavailable' };
  }

  const injected = `[USER] ${trimmed}`;
  try {
    if (session.upstream.injectItemWithAck) {
      await session.upstream.injectItemWithAck(injected);
    } else {
      // Legacy/fake relay handles have no ack surface. The production realtime
      // transport implements injectItemWithAck; keep the old contract usable for
      // adapters that only expose fire-and-forget injection.
      session.upstream.injectItem(injected);
    }
    logger.info('typed voice input injected', { voiceSessionId: session.id });
    return { outcome: 'injected' };
  } catch (error) {
    logger.warn('typed voice input injection rejected; renderer must queue it', {
      voiceSessionId: session.id,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return { outcome: 'fallback', reason: 'injection_rejected' };
  }
}

function send(client: WsSocket, event: VoiceEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

function rememberCancelledResponse(session: ActiveSession, responseId: string): void {
  session.cancelledResponseIds.add(responseId);
  session.pendingAssistantFinals.delete(responseId);
  session.transcriptBuf.assistantByResponse.delete(responseId);
  while (session.cancelledResponseIds.size > 32) {
    const oldest = session.cancelledResponseIds.values().next().value as string | undefined;
    if (!oldest) break;
    session.cancelledResponseIds.delete(oldest);
  }
}

function requestResponse(session: ActiveSession, userFinal: string): void {
  if (session.upstream.kind !== 'relay') return;
  const latest = userFinal.trim();
  session.upstream.respond(latest
    ? [
        '只回应并严格执行用户最新一句话，不要继续被取消回复的目标或内容。',
        `用户最新一句话：${latest}`,
      ].join('\n')
    : undefined);
}

function findInterruptCandidateByItemId(
  session: ActiveSession,
  itemId?: string,
): { candidateId: string; candidate: VoiceInterruptCandidate } | undefined {
  if (!itemId) return undefined;
  for (const [candidateId, candidate] of session.interruption.candidates) {
    if (candidate.itemId === itemId) return { candidateId, candidate };
  }
  return undefined;
}

function resolveInterruptCandidate(
  session: ActiveSession,
  identity: { candidateId?: string; itemId?: string } = {},
): { candidateId: string; candidate: VoiceInterruptCandidate } | undefined {
  const byItemId = findInterruptCandidateByItemId(session, identity.itemId);
  if (byItemId) return byItemId;
  const candidateId = identity.candidateId ?? session.interruption.currentCandidateId;
  if (!candidateId) return undefined;
  const candidate = session.interruption.candidates.get(candidateId);
  return candidate ? { candidateId, candidate } : undefined;
}

function evaluateInterrupt(
  session: ActiveSession,
  text: string,
  stage: 'partial' | 'final',
  identity: { candidateId?: string; itemId?: string; classificationSource?: 'empty-text-fallback' | 'transcript' } = {},
): void {
  const resolved = resolveInterruptCandidate(session, identity);
  const candidateId = resolved?.candidateId;
  if (!candidateId) {
    if (stage === 'final' && text.trim()) requestResponse(session, text);
    return;
  }
  const candidate = resolved.candidate;
  if (stage === 'final' && candidate.finalGraceTimer) {
    clearTimeout(candidate.finalGraceTimer);
    candidate.finalGraceTimer = undefined;
  }
  const decision = decideVoiceInterrupt({
    assistantPlaying: candidate.assistantPlaying
      ?? (session.upstream.kind === 'relay' && session.upstream.isResponding()),
    durationMs: candidate.durationMs,
    text,
    stage,
  });

  if (decision.terminal && !candidate.decided) {
    candidate.decided = true;
    candidate.classification = decision.classification;
    candidate.classificationSource = identity.classificationSource ?? 'transcript';
    let cancelledResponseId: string | null = null;
    if (decision.cancel) {
      cancelledResponseId = session.upstream.interrupt();
      if (cancelledResponseId) {
        candidate.cancelledResponseId = cancelledResponseId;
        rememberCancelledResponse(session, cancelledResponseId);
        send(session.clientRef.current, {
          type: 'response.cancelled',
          responseId: cancelledResponseId,
          reason: 'interrupt',
        });
      }
    }
    send(session.clientRef.current, {
      type: 'interrupt.decision',
      candidateId,
      classification: decision.classification,
      action: decision.cancel ? 'cancel_discard' : 'resume',
      ...(cancelledResponseId ? { responseId: cancelledResponseId } : {}),
    });
    logger.info('voice interrupt decision', {
      voiceSessionId: session.id,
      candidateId,
      transcriptStage: stage,
      classification: decision.classification,
      action: decision.cancel ? 'cancel_discard' : 'resume',
      responseId: cancelledResponseId ?? undefined,
    });
  }

  if (stage === 'final' && decision.shouldRespond && !candidate.responseRequested) {
    candidate.responseRequested = true;
    requestResponse(session, text);
  }
}

/**
 * Host 主动结束这一路的**唯一**关闭出口：一律带终止 close code。
 *
 * 所有 host 侧终态都必须走这里——teardown 的全部 reason（model-end-call /
 * model-end-call-timeout / user-hangup-intent / user-hangup-intent-timeout /
 * max-duration / upstream-error / upstream-closed / reconnect-timeout /
 * client-end）、互斥抢占、缺 provider key、上游建连失败。
 * 漏掉任何一条，renderer 都会把那次关闭当成网络抖动接回来，于是立刻拨出一通新电话。
 */
function closeClientTerminal(client: WsSocket): void {
  if (client.readyState === client.OPEN) client.close(VOICE_WS_CLOSE_TERMINAL);
}

/**
 * 整条字幕只有工具标签（R6，2026-07-30 真机：模型把 `<end_call>` 当话「说」了出来）。
 *
 * 标签是模型和我们之间的暗号，不是说给用户听的话——不该上屏，也不该落进消息流。
 * 流式 delta 会给到半截标签（`<`、`<end_c`），所以闭合的 `>` 是可选的。
 * **标签混在正文里的不管**：那时正文才是这句话的内容，删标签等于改用户看到的话。
 */
const PURE_TOOL_TAG_TEXT = /^\s*(<[a-z0-9_]*>?\s*)+$/i;

function isPureToolTagText(text: string): boolean {
  return PURE_TOOL_TAG_TEXT.test(text);
}

/**
 * 上一条落库的用户字幕（R5 合并用）。VAD 会把一句话切成几轮，消息流里就成了几条碎片。
 *
 * 合并是**落库后回头并入**，不是攒着晚点写：近窗（派活时执行侧重建意图的原文）、
 * 挂断闸、字幕 UI 全都吃这条 final 的到达时刻，晚 2 秒等于让紧跟的 spawn_task
 * 看不到用户最后那句话。所以照常立即写，下一条来得够快就把上一条改掉。
 */
interface TranscriptMergeState {
  messageId: string | null;
  text: string;
  at: number;
}

async function persistTranscript(
  neoSessionId: string,
  role: 'user' | 'assistant',
  text: string,
  counter?: { count: number },
  merge?: TranscriptMergeState,
  identity?: { responseId?: string; itemId?: string },
): Promise<void> {
  const trimmed = text.trim();
  // 落库的唯一入口 = 过滤的唯一落点：done 那条、排水窗冲刷那条走的都是这里。
  // 丢弃必须出声（E1 硬要求）：静默丢弃就是「用户说了话、系统什么都没留下、日志一个字都没有」，
  // 本仓已为此付过一次数据丢失。只记 role 和原因，不记内容。
  if (!trimmed || isPureToolTagText(trimmed)) {
    logger.warn('transcript dropped before persist', {
      role,
      reason: trimmed ? 'pure-tool-tag' : 'empty-text',
    });
    return;
  }
  // 落库的同时进近窗（P0-2）：派活时执行侧要拿原文自己重建意图，
  // 别只给它通话 brain 改写过的那一句。落库失败不影响近窗，反之亦然。
  // ponytail: 合并只改消息流不回收近窗——近窗是喂模型的，碎一点无害（产品拍板）。
  pushVoiceTranscript({ role, text: trimmed });
  const now = Date.now();
  // ponytail: 上一条还在写库时（messageId 尚未回填）就直接不合并，各落各的——
  // 真机上两条 final 至少隔一个 VAD 静音窗，插入早完成了；退化路径也只是多一条消息。
  const mergeable = role === 'user'
    && merge?.messageId
    && now - merge.at < VOICE_TRANSCRIPT_MERGE_WINDOW_MS;
  try {
    if (mergeable && merge?.messageId) {
      const merged = `${merge.text} ${trimmed}`;
      await getSessionManager().updateMessage(merge.messageId, { content: merged });
      merge.text = merged;
      merge.at = now;
      // 合并进上一条 = 消息没多一条，transcriptCount 也不该多一个。
      return;
    }
    const id = `voice-${role}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    await getSessionManager().addMessageToSession(neoSessionId, {
      id,
      role,
      content: trimmed,
      timestamp: now,
      metadata: {
        source: 'voice',
        ...(identity && (identity.responseId || identity.itemId) ? { voiceTranscript: identity } : {}),
      },
    });
    if (counter) counter.count += 1;
    // 助手说过话之后用户再开口，那是新的一轮，不能再往上一条里并。
    if (merge) {
      merge.messageId = role === 'user' ? id : null;
      merge.text = trimmed;
      merge.at = now;
    }
  } catch (err) {
    logger.warn('failed to persist transcript', { role, message: err instanceof Error ? err.message : 'unknown' });
  }
}

/**
 * 会话级标记：这条会话用过实时语音。侧栏据此在标题旁挂一个语音图标
 * （产品负责人 2026-07-27）——是**身份**不是状态，所以写在会话 metadata 上，
 * 不去每次列会话时翻消息。
 *
 * 用 patchSessionMetadata 而不是 updateSession({metadata})：后者是整份覆盖，
 * 会把别人写的 key 冲掉。失败只告警不影响通话。
 */
function markSessionHadLiveVoice(neoSessionId: string): void {
  void getSessionManager()
    .patchSessionMetadata(neoSessionId, { hadLiveVoice: true })
    .catch((err: unknown) => {
      logger.warn('failed to mark session as live-voice', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    });
}

/**
 * 通话生命周期事件（observer-only）：暂停/结束要让 agent 侧可编排，
 * 典型用例是会议形态的通话结束后问一句「要我整理一下吗」。
 *
 * 三条纪律：
 * 1. **fire-and-forget**：hook 是用户脚本，不能让它拖住建连或收尾，也不能把通话搞挂；
 * 2. **懒加载 task 依赖树**：建连是关键路径，不为一个可能没人订阅的事件把它拉进来
 *    （同 voiceAgentCoordinator 的 taskManager() 先例）；
 * 3. **重连不重复发 started**：宽限窗内接回来走 reattachVoiceClient，不经过这里。
 */
function emitVoiceCallHook(
  event: 'VoiceCallStarted' | 'VoiceCallPaused' | 'VoiceCallEnded',
  params: { voiceCallId: string; sessionId: string; durationSec: number; workItemCount?: number; reason?: string },
): void {
  void (async () => {
    try {
      const { getTaskManager } = await import('../../task');
      // 已存在的 manager 挂着 onTrigger / aiCompletion，优先复用；纯语音会话没有
      // orchestrator 时才临时创建，避免为了观察事件拉起整棵 agent 运行时。
      let hooks = getTaskManager()?.getOrchestrator(params.sessionId)?.getHookManager?.();
      if (!hooks) {
        try {
          const session = await getSessionManager().getSession(params.sessionId, 1);
          const { createHookManager } = await import('../../hooks');
          hooks = createHookManager({
            workingDirectory: session?.workingDirectory?.trim() || process.cwd(),
          });
          await hooks.initialize();
          if (!hooks.hasHooksFor(event)) return;
        } catch (err) {
          logger.info('voice call hook skipped: existing and temporary hook managers unavailable', {
            event,
            sessionId: params.sessionId,
            message: err instanceof Error ? err.message : 'unknown',
          });
          return;
        }
      }
      await hooks.triggerVoiceCall(event, params);
    } catch (err) {
      logger.warn('voice call hook failed', { event, message: err instanceof Error ? err.message : 'unknown' });
    }
  })();
}

/**
 * 客户端断了先进宽限窗，不立刻挂断上游（批 H · sticky）。
 * 窗口内重新 attach 就当作同一通电话继续；超时才真 teardown。
 */
function beginReconnectGrace(sessionId: string): void {
  const session = active;
  if (session?.id !== sessionId || session.graceTimer) return;
  logger.info('client gone, waiting for reconnect', { voiceSessionId: sessionId });
  emitVoiceCallHook('VoiceCallPaused', {
    voiceCallId: sessionId,
    sessionId: session.neoSessionId,
    durationSec: Math.max(0, Math.round((Date.now() - session.startedAt) / 1000)),
    reason: 'client-gone',
  });
  session.graceTimer = setTimeout(() => {
    if (active?.id === sessionId) void teardown('reconnect-timeout');
  }, VOICE_RECONNECT_GRACE_MS);
}

async function teardown(reason: string): Promise<void> {
  const session = active;
  if (!session) return;
  session.ending = true;
  endVoiceQuestionSession(session.neoSessionId);
  settleNarrationsForTeardown(session);
  active = null;
  clearTimeout(session.maxDurationTimer);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  if (session.inboundAudioWatchdogTimer) clearTimeout(session.inboundAudioWatchdogTimer);
  for (const candidate of session.interruption.candidates.values()) {
    if (candidate.finalGraceTimer) clearTimeout(candidate.finalGraceTimer);
  }
  logger.info('session ended', { voiceSessionId: session.id, reason });
  // D4：通话态标记必须先于任何后续动作解除，别让抬严挂在会话上不下来。
  // 只还「通话」这一张票。语音派出去、还在飞的 run 各自持票，抬严对它们继续有效——
  // 挂断不再等于解除（2026-07-26 真机：挂断后同一个 run 直接落盘，D4 承诺全失效）。
  getPermissionModeManager().clearLiveVoiceSession(session.neoSessionId, `call:${session.id}`);
  // 排水窗：用户 ASR completed / 助手 transcript done 常在挂断后 ~1s 才到，立刻关
  // 上游会把这通电话说过的话全部丢掉（2026-07-26 真机：12s 通话落库只剩摘要）。
  // 窗口内 onEvent 照常把 final 落库；窗口结束后 done 仍没到的助手增量缓冲冲成 final。
  await new Promise((resolve) => setTimeout(resolve, VOICE_TEARDOWN_DRAIN_MS));
  session.tokenUsage.accepting = false;
  for (const [responseId, pendingAssistant] of session.transcriptBuf.assistantByResponse) {
    if (!pendingAssistant.trim() || session.cancelledResponseIds.has(responseId)) continue;
    await persistTranscript(
      session.neoSessionId,
      'assistant',
      pendingAssistant,
      session.transcriptCounter,
      session.transcriptMerge,
      { responseId },
    );
  }
  session.transcriptBuf.assistantByResponse.clear();
  const endedAt = Date.now();
  const { startedAt } = session;
  const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationText = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  // 用量账本无条件记：空通话也真按秒付了钱，不落卡不等于没发生。
  if (!consumeVoiceCallFailure(session.id)) recordVoiceCall(endedAt, durationSec, session.tokenUsage.value);
  // A3：零字幕通话不落摘要卡。2026-07-30 真机那通 16 秒空通话（自动重连拨出来的）
  // 在消息流里留了一张「这通电话没有对话内容」——那不是记录，是噪音。
  // 派过活的通话即使一句没说也照落：工作项才是那通电话的产物。
  const hasCallContent = session.transcriptCounter.count > 0 || session.workItemCount > 0;
  if (!hasCallContent) {
    logger.info('empty call, summary card skipped', { voiceSessionId: session.id, durationSec });
  }
  try {
    if (hasCallContent) await getSessionManager().addMessageToSession(session.neoSessionId, {
      id: `voice-summary-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: `语音通话结束，时长 ${durationText}`,
      timestamp: endedAt,
      metadata: {
        source: 'voice',
        voiceCallSummary: {
          durationSec,
          provider: session.upstream.provider,
          conversationModel: session.conversationModel,
          workItemCount: session.workItemCount,
          startedAt,
          endedAt,
          transcriptCount: session.transcriptCounter.count,
        },
      },
    });
  } catch (err) {
    logger.warn('failed to persist call summary', { message: err instanceof Error ? err.message : 'unknown' });
  }
  // 断开 work item 的 UI 回流；账本与 run 的票继续活到最后一件活落地（同上）。
  endVoiceDispatch();
  emitVoiceCallHook('VoiceCallEnded', {
    voiceCallId: session.id,
    sessionId: session.neoSessionId,
    // 与摘要卡同一个 durationSec，别各算各的
    durationSec,
    workItemCount: session.workItemCount,
    reason,
  });
  await session.upstream.close().catch(() => undefined);
  closeClientTerminal(session.clientRef.current);
}

/**
 * 接管一条来自 Renderer 的媒体面 WS。webServer 的 upgrade 处理器调用。
 * 互斥：已有活跃通话时直接拒绝，不排队。
 */
export async function attachVoiceClient(client: WsSocket, neoSessionId: string, requestedAgentId?: string): Promise<void> {
  // 宽限窗里的同一条会话重新连上来 = 同一通电话续上，不建新上游、不落第二张摘要卡。
  if (active?.graceTimer && active.neoSessionId === neoSessionId) {
    reattachVoiceClient(active, client);
    return;
  }
  if (active || connecting) {
    send(client, { type: 'error', code: 'VOICE_SESSION_BUSY', message: '已有一路通话在进行中' });
    void persistVoiceCallFailure({ neoSessionId, code: 'VOICE_SESSION_BUSY', phase: 'admission' });
    closeClientTerminal(client);
    return;
  }

  const liveSettings = readVoiceLiveSettings();
  const profile = resolveConfiguredRealtimeVoiceProfile(liveSettings?.providerId, liveSettings);
  const apiKey = resolveVoiceApiKey(profile);
  if (!apiKey) {
    send(client, {
      type: 'error',
      code: 'VOICE_PROVIDER_UNCONFIGURED',
      message: `未配置 ${profile.displayName} API Key`,
    });
    void persistVoiceCallFailure({ neoSessionId, code: 'VOICE_PROVIDER_UNCONFIGURED', phase: 'configuration' });
    closeClientTerminal(client);
    return;
  }

  connecting = true;
  try {
    await connectAndBind(client, neoSessionId, apiKey, profile, requestedAgentId);
  } finally {
    connecting = false;
  }
}

async function connectAndBind(
  client: WsSocket,
  neoSessionId: string,
  apiKey: string,
  profile: RealtimeVoiceProviderProfile,
  requestedAgentId?: string,
): Promise<void> {
  const id = `voice-${Date.now()}-${++sessionSeq}`;
  send(client, { type: 'state', state: 'connecting' });

  // 用户没点名时的默认收件人 = 会话 metadata.teamLead（语音批 B）。取值留在建连处，
  // resolveVoiceRouting 保持纯函数；无 DB / 非团会话时拿到 undefined，行为同以往。
  const routing = resolveVoiceRouting(requestedAgentId, getSessionManager().getSessionMetadata(neoSessionId));
  const liveSettings = readVoiceLiveSettings();
  // 模型/音色按所选 profile 联合解析；存量 providerId 缺省已在 profile 读取口回 DashScope。
  const selection = resolveRealtimeVoiceSelection(
    profile,
    liveSettings?.conversationModel,
    liveSettings?.voiceId,
  );
  if (liveSettings?.conversationModel && liveSettings.conversationModel !== selection.model.id) {
    logger.warn('conversation model not in whitelist, falling back to default', {
      provider: profile.id,
      requested: liveSettings.conversationModel,
    });
  }
  if (liveSettings?.voiceId && liveSettings.voiceId !== selection.voice) {
    logger.warn('voice not in model whitelist, falling back to default', {
      provider: profile.id,
      model: selection.model.id,
      requested: liveSettings.voiceId,
    });
  }

  const transcriptBuf = { assistantByResponse: new Map<string, string>() };
  const transcriptMerge: TranscriptMergeState = { messageId: null, text: '', at: 0 };
  // transport 回调属于这通上游连接，不能用全局 active 判断归属：显式挂断会先清 active，
  // 但 response.done usage 仍可能在 1.5 秒排水窗内到达。
  const tokenUsage = { value: undefined as VoiceTokenUsage | undefined, accepting: true };
  /**
   * 告别音频的播放计量（E2）。host 转发多少字节就是要播多久（PCM16@24k 单声道），
   * 播放起点 = 第一帧转发的时刻。不新造 renderer 回报协议——这点端到端延迟由反应窗兜住。
   */
  const goodbyeAudio = { firstFrameAt: 0, bytes: 0 };
  const remainingGoodbyeMs = (): number => {
    if (!goodbyeAudio.firstFrameAt) return 0;
    const durationMs = (goodbyeAudio.bytes / (VOICE_DOWNSTREAM_SAMPLE_RATE * 2)) * 1000;
    return Math.max(0, durationMs - (Date.now() - goodbyeAudio.firstFrameAt));
  };
  // 字幕落库计数器：onEvent 闭包与挂断摘要共用同一个可变引用（同 transcriptBuf 先例），
  // 成功落库才 +1，挂断时原样写进 voiceCallSummary.transcriptCount。
  const transcriptCounter = { count: 0 };
  /**
   * 收线武装状态。置位后 onEvent 看到这一轮说完（response.done）就真挂。
   *
   * `timer` 要留着是因为**用户可以反悔**（R2，2026-07-30 真机：「先这样吧拜拜」
   * 之后紧跟一句「不要挂断」，电话照样挂了）。反悔要把兜底定时器一起撤掉，
   * 光复位标志的话 5 秒后照样挂。
   * `awaitingUserTurn`：告别窗里用户又开口了，先把扣扳机的手松开，等听清他说什么再定
   * ——barge-in 会让这一轮的 response.done 抢在用户字幕前面到，那时挂断已经来不及拦。
   */
  const endCallRequested: {
    value: boolean;
    reason: 'model-end-call' | 'user-hangup-intent';
    timer: NodeJS.Timeout | null;
    awaitingUserTurn: boolean;
  } = {
    value: false,
    reason: 'model-end-call',
    timer: null,
    awaitingUserTurn: false,
  };
  const baseInstructions = withLanguageDirective(routing.personaInstructions, liveSettings?.language);
  const continuity = await loadVoiceContinuity(neoSessionId);
  const initialInstructions = composeVoiceInstructions(baseInstructions, null, {
    // Phase 3：跟着这台机器真有没有这个能力走。能力与文案同一个判据，不虚构截屏能力。
    screenContextEnabled: isVoiceScreenContextSupported(),
    continuity,
    speechRate: liveSettings?.speechRate,
  });
  // 上游回调一律经这个可变引用发：重连换的是 socket，不是通话。
  const clientRef = { current: client };
  let voiceToolsAvailable = VOICE_TOOL_DEFINITIONS.length > 0;
  /**
   * 收线的**唯一**入口——模型调 end_call 与 host 从用户字幕判出的挂断意图共用。
   *
   * 不当场 teardown：立刻断会把这句告别掐掉，用户听到的是电话突然没了。等这一轮
   * response.done 再断；上游不回那一帧时由兜底定时器收尾（同 dictation finish 的先例）。
   */
  const requestEndCall = (reason: 'model-end-call' | 'user-hangup-intent'): void => {
    endCallRequested.awaitingUserTurn = false;
    if (endCallRequested.value) return;
    // 武装之后转发的下行音频就是这句告别，从这里开始记时长。
    goodbyeAudio.firstFrameAt = 0;
    goodbyeAudio.bytes = 0;
    endCallRequested.value = true;
    endCallRequested.reason = reason;
    // 字幕内容不进日志（音频/字幕内容不落日志是硬纪律），只记命中这件事。
    logger.info(
      reason === 'model-end-call'
        ? 'end call requested by model, waiting for goodbye'
        : 'hangup intent matched from user transcript',
      { voiceSessionId: id },
    );
    endCallRequested.timer = setTimeout(() => {
      if (active?.id === id && endCallRequested.value) void teardown(`${reason}-timeout`);
    }, VOICE_END_CALL_GOODBYE_TIMEOUT_MS);
  };
  /** 用户反悔（告别窗里说了句不是挂断的话）：解除武装，通话继续。 */
  const disarmEndCall = (): void => {
    endCallRequested.awaitingUserTurn = false;
    if (!endCallRequested.value) return;
    endCallRequested.value = false;
    if (endCallRequested.timer) clearTimeout(endCallRequested.timer);
    endCallRequested.timer = null;
    logger.info('end call disarmed by new user turn', { voiceSessionId: id });
  };
  // 绑定必须早于建连：上游一旦握手成功就可能立刻发 function_call，
  // 晚绑一步那次调用会落到「通话还没就绪」的兜底上。
  beginVoiceDispatch({
    neoSessionId,
    voiceSessionId: id,
    activeAgentId: routing.activeAgentId,
    onWorkItem: (item) => {
      if (active?.id === id && item.status === 'queued') {
        active.workItemCount += 1;
        // 首条进度的延迟基准（§2）：从这件活派出去那一刻起算。
        markNarrationDispatch(active.narration, item.id);
        // §4.3 的三元组绑定日志已挪进 coordinator 的 startRun：账本现在自己拿得到
        // voiceSessionId，在真正派活那一处记，比在这条 UI 回流上转记准确。
      }
      send(clientRef.current, { type: 'work.upsert', item });
    },
    // G1（2026-07-28 真机，验收报告自评最严重）：账本早就把死掉的活标成 failed，
    // 但没有任何人把这件事说出来——通话条只渲染 queued/running（VoiceChrome 的
    // activeWorkItems 过滤），failed 就这么无声消失；通话模型也没人告诉它，
    // 于是继续说「已经写好了」。第五例「建好不接电」。
    onWorkFailed: (item) => void reportVoiceWorkFailure({
      neoSessionId,
      voiceSessionId: id,
      item,
      stillOnThisCall: active?.id === id,
      emitNotice: (event) => send(clientRef.current, event),
    }),
    // 发言人协议（W6）：一件活落终态 → 把结论塞进实时会话，模型用第一人称念给用户听。
    // 注意 upstream 此刻还不存在（绑定必须早于建连），所以读 active 而不是闭包捕获。
    onWorkNarration: (narration) => {
      if (active?.id !== id) return;
      enqueueOrInjectNarration(active, narration);
    },
    // 模型自己收线，走统一的收线入口。
    onEndCall: () => requestEndCall('model-end-call'),
  });
  let upstream: VoiceTransportHandle;
  try {
    upstream = await resolveVoiceTransport(profile).connect({
      apiKey,
      config: {
        neoSessionId,
        model: selection.model.id,
        instructions: initialInstructions,
        tools: VOICE_TOOL_DEFINITIONS,
        voice: selection.voice,
      },
      onEvent: (event) => {
        if (event.type === 'notice' && event.code === 'VOICE_TOOLS_DROPPED') {
          voiceToolsAvailable = false;
          if (active?.id === id) active.voiceToolsAvailable = false;
        }
        if (active?.id === id && event.type === 'speech.started') {
          const candidateId = event.candidateId ?? `candidate-${Date.now()}`;
          active.interruption.currentCandidateId = candidateId;
          active.interruption.candidates.set(candidateId, {
            startedAt: Date.now(),
            decided: false,
            responseRequested: false,
          });
          while (active.interruption.candidates.size > 32) {
            const oldest = active.interruption.candidates.keys().next().value as string | undefined;
            if (!oldest || oldest === candidateId) break;
            const stale = active.interruption.candidates.get(oldest);
            if (stale?.finalGraceTimer) clearTimeout(stale.finalGraceTimer);
            active.interruption.candidates.delete(oldest);
          }
          markNarrationUserTurn(active);
        } else if (active?.id === id && event.type === 'speech.stopped') {
          const candidateId = event.candidateId ?? active.interruption.currentCandidateId;
          const candidate = candidateId ? active.interruption.candidates.get(candidateId) : undefined;
          if (candidate) {
            candidate.durationMs = event.durationMs;
            if (candidate.finalGraceTimer) clearTimeout(candidate.finalGraceTimer);
            candidate.finalGraceTimer = setTimeout(() => {
              candidate.finalGraceTimer = undefined;
              if (active?.id !== id || candidate.decided) return;
              candidate.emptyTextFallbackObserved = true;
              evaluateInterrupt(active, '', 'partial', {
                ...(candidateId ? { candidateId } : {}),
                classificationSource: 'empty-text-fallback',
              });
            }, 1_200);
          }
        }

        const responseId = event.type === 'assistant.transcript' || event.type === 'response.done'
          ? event.responseId
          : undefined;
        const cancelledResponse = Boolean(
          responseId && active?.id === id && active.cancelledResponseIds.has(responseId),
        );
        const assistantBuffer = event.type === 'assistant.transcript'
          ? transcriptBuf.assistantByResponse.get(event.responseId ?? 'legacy') ?? ''
          : '';
        // R6：整条只有工具标签的助手字幕不上屏。流式期间按「累计到此刻」判，
        // 半截标签（`<end_c`）也压住；后面真接上正文就恢复下发，正文一个字不动。
        const suppressedToolTag = event.type === 'assistant.transcript'
          && isPureToolTagText(event.done ? event.text : assistantBuffer + event.text);
        // injection.rejected 是 Host 内部的重试信号；Renderer 没有用户动作要做。
        let suppressUserFragment = false;
        let voiceQuestionConsumed = false;
        if (event.type === 'user.transcript') {
          if (active?.id === id) {
            voiceQuestionConsumed = event.done
              && handleVoiceQuestionTranscript(neoSessionId, event.text);
            const transcriptCandidate = resolveInterruptCandidate(active, {
              candidateId: event.candidateId,
              itemId: event.itemId,
            });
            if (event.itemId && transcriptCandidate) transcriptCandidate.candidate.itemId ??= event.itemId;
            if (!voiceQuestionConsumed) {
              evaluateInterrupt(active, event.text, event.done ? 'final' : 'partial', {
                candidateId: event.candidateId,
                itemId: event.itemId,
              });
            }
            if (event.done && event.itemId) {
              const candidate = findInterruptCandidateByItemId(active, event.itemId)?.candidate;
              const classification = candidate?.classification;
              suppressUserFragment = !candidate?.emptyTextFallbackObserved
                && candidate?.classificationSource !== 'empty-text-fallback'
                && (classification === 'background'
                  || classification === 'acknowledgement'
                  || classification === 'short_fragment');
            }
          }
        }
        if (
          event.type !== 'injection.rejected'
          && !suppressedToolTag
          && !cancelledResponse
          && !suppressUserFragment
        ) send(clientRef.current, event);
        if (active?.id === id) {
          if (event.type === 'speech.started') {
            // R2：告别窗里用户又开口——先别扣扳机。barge-in 会让这一轮的 response.done
            // 抢在用户字幕前面到，那时挂断已成事实，再听到「不要挂断」也拦不住了。
            if (endCallRequested.value) endCallRequested.awaitingUserTurn = true;
          }
          else if (event.type === 'response.done' && !cancelledResponse) flushNarrationQueue(active);
          else if (event.type === 'injection.rejected') handleNarrationInjectionRejected(active, event.message);
        }
        if (event.type === 'user.transcript' && event.done) {
          if (!suppressUserFragment) {
            void persistTranscript(
              neoSessionId,
              'user',
              event.text,
              transcriptCounter,
              transcriptMerge,
              event.itemId ? { itemId: event.itemId } : undefined,
            );
          }
          // 挂断确定性闸（A1）：只看用户说的话，绝不看 assistant 字幕——
          // 模型复述「好的，挂断」会把它自己的话当成用户的指令。
          // 反过来（R2）：告别窗里的新一句话若不是挂断，就是反悔，解除武装继续通话。
          if (active?.id === id && !voiceQuestionConsumed) {
            if (detectHangupIntent(event.text)) requestEndCall('user-hangup-intent');
            else if (shouldDisarmHangup(event.text)) disarmEndCall();
            else endCallRequested.awaitingUserTurn = false;
          }
        } else if (event.type === 'assistant.transcript') {
          const key = event.responseId ?? 'legacy';
          if (cancelledResponse) {
            transcriptBuf.assistantByResponse.delete(key);
          } else if (event.done) {
            transcriptBuf.assistantByResponse.set(key, event.text);
            if (event.responseId) {
              active?.pendingAssistantFinals.set(event.responseId, {
                text: event.text,
                ...(event.itemId ? { itemId: event.itemId } : {}),
              });
            }
          } else transcriptBuf.assistantByResponse.set(key, assistantBuffer + event.text);
        } else if (event.type === 'response.done') {
          if (event.usage && tokenUsage.accepting) {
            tokenUsage.value = addTokenUsage(tokenUsage.value, event.usage);
          }
          const key = event.responseId ?? 'legacy';
          if (cancelledResponse) {
            transcriptBuf.assistantByResponse.delete(key);
            active?.pendingAssistantFinals.delete(key);
          } else {
            const pending = event.responseId ? active?.pendingAssistantFinals.get(event.responseId) : undefined;
            const text = pending?.text ?? transcriptBuf.assistantByResponse.get(key) ?? '';
            transcriptBuf.assistantByResponse.delete(key);
            if (event.responseId) active?.pendingAssistantFinals.delete(event.responseId);
            if (text.trim()) {
              void persistTranscript(
                neoSessionId,
                'assistant',
                text,
                transcriptCounter,
                transcriptMerge,
                {
                  ...(event.responseId ? { responseId: event.responseId } : {}),
                  ...(pending?.itemId ? { itemId: pending.itemId } : {}),
                },
              );
            }
          }
        }
        // 告别**生成**完了 ≠ 用户**听**完了（E2）。response.done 到货时音频才刚开始播，
        // 此刻挂断，用户既没听到告别也没机会反悔。等音频真播完再加一个反应窗。
        if (event.type === 'response.done' && endCallRequested.value && active?.id === id) {
          if (endCallRequested.timer) clearTimeout(endCallRequested.timer);
          const waitMs = remainingGoodbyeMs() + VOICE_HANGUP_REACTION_WINDOW_MS;
          logger.info('goodbye generated, waiting for playback before teardown', { voiceSessionId: id, waitMs });
          endCallRequested.timer = setTimeout(() => {
            // 用户正在说话就不挂：等他那句字幕到了再判是挂断还是反悔。
            // 字幕万一never到，宁可让通话活着——他人就在那儿说话（max-duration 兜底）。
            if (active?.id !== id || !endCallRequested.value || endCallRequested.awaitingUserTurn) return;
            endCallRequested.value = false;
            endCallRequested.timer = null;
            void teardown(endCallRequested.reason);
          }, waitMs);
        }
        // 空闲结束 / 上游报错 / 上游连接关闭都必须就地释放 active。
        // 空闲结束是正常终态，单独保留 reason，不能落成 upstream-error。
        // 否则两侧对「通话是否结束」的判断会分叉：渲染侧收到 error 就把按钮切回「开始通话」，
        // 而 Host 仍占着 active，用户再拨被自己的互斥挡成 VOICE_SESSION_BUSY，
        // 且此时「挂断」已经点不到——整条语音链锁死到 10 分钟 max-duration 才自愈。
        // （2026-07-26 真机踩到：上游 COMMON_ERROR 后必须重启 app 才能再打。）
        if (
          event.type === 'session.ended'
          || event.type === 'error'
          || (event.type === 'state' && event.state === 'closed')
        ) {
          if (active?.id === id) {
            observeVoiceEventFailure(event, neoSessionId, id);
            const reason = event.type === 'session.ended'
              ? event.reason
              : event.type === 'error'
                ? 'upstream-error'
                : 'upstream-closed';
            void teardown(reason);
          }
        }
      },
      onAudio: (frame) => {
        if (endCallRequested.value) {
          if (!goodbyeAudio.firstFrameAt) goodbyeAudio.firstFrameAt = Date.now();
          goodbyeAudio.bytes += frame.length;
        }
        const socket = clientRef.current;
        if (socket.readyState === socket.OPEN) socket.send(frame, { binary: true });
      },
      onToolCall: (call) => executeVoiceTool(call.name, call.arguments),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connect failed';
    logger.warn('upstream connect failed', { voiceSessionId: id, message });
    endVoiceDispatch();
    send(client, {
      type: 'error',
      code: 'VOICE_UPSTREAM_UNAVAILABLE',
      message: 'upstream unavailable',
      detail: message,
    });
    void persistVoiceCallFailure({ neoSessionId, voiceSessionId: id, code: 'VOICE_UPSTREAM_UNAVAILABLE', phase: 'handshake' });
    closeClientTerminal(client);
    return;
  }

  // 客户端在 await 期间就断了：别留悬空的上游连接（会持续计费）。
  if (client.readyState !== client.OPEN) {
    endVoiceDispatch();
    await upstream.close().catch(() => undefined);
    return;
  }

  const session: ActiveSession = {
    id,
    neoSessionId,
    startedAt: Date.now(),
    clientRef,
    upstream,
    voiceToolsAvailable,
    ending: false,
    graceTimer: null,
    inboundAudioFrames: 0,
    inboundAudioWatchdogTimer: null,
    workItemCount: 0,
    transcriptCounter,
    transcriptBuf,
    transcriptMerge,
    personaInstructions: baseInstructions,
    instructions: initialInstructions,
    conversationModel: selection.model.id,
    continuity,
    focus: null,
    interruption: {
      currentCandidateId: null,
      candidates: new Map(),
    },
    cancelledResponseIds: new Set(),
    pendingAssistantFinals: new Map(),
    tokenUsage,
    narration: createNarrationState(),
    maxDurationTimer: setTimeout(() => {
      logger.warn('session hit max duration, force closing', { voiceSessionId: id });
      void teardown('max-duration');
    }, VOICE_SESSION_MAX_DURATION_MS),
  };
  active = session;
  beginVoiceQuestionSession({
    neoSessionId,
    dismiss: (narrationPrefix) => {
      if (active?.id === id) dismissNarrationsByPrefix(active, narrationPrefix);
    },
    speak: ({ narrationId, title, text }) => {
      if (active?.id !== id) return;
      enqueueOrInjectNarration(active, {
        workItemId: narrationId,
        status: 'announcement',
        title,
        summary: text,
      });
    },
  });
  if (upstream.kind === 'relay') {
    session.inboundAudioWatchdogTimer = setTimeout(() => {
      if (active?.id !== id || session.inboundAudioFrames > 0) return;
      logger.warn('client audio missing after session start', {
        voiceSessionId: id,
        waitedMs: VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS,
        reconnecting: session.graceTimer !== null,
      });
      session.inboundAudioWatchdogTimer = null;
    }, VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS);
  }
  // D4 抬严必须在有任何工具可派之前就位——建连成功即标记。
  getPermissionModeManager().markLiveVoiceSession(neoSessionId, `call:${id}`);
  logger.info('session started', { voiceSessionId: id, neoSessionId, activeAgentId: routing.activeAgentId });
  emitVoiceCallHook('VoiceCallStarted', { voiceCallId: id, sessionId: neoSessionId, durationSec: 0 });
  markSessionHadLiveVoice(neoSessionId);

  bindClientHandlers(session, client);
}

/**
 * 焦点上报（§6.5）。只有真变了才发 session.update——Renderer 已经节流过一层，
 * 这里再按内容去重，避免同一份焦点被反复推给上游。
 */
function applyFocus(session: ActiveSession, focus: VoiceFocusContext): void {
  const changed = focusChanged(session.focus, focus);
  // 取证文档 §4：applyFocus / updateInstructions 全程零日志，于是「焦点刷新有没有发生」
  // 与「上游不回显」两种情况在现场根本区分不了——判因前先补可观测性，别拿猜的当结论。
  // 不记 filePath 原文（本地路径），只记有没有。
  logger.info('focus reported', { voiceSessionId: session.id, changed, view: focus.view, hasFile: !!focus.filePath });
  if (!changed) return;
  session.focus = focus;
  setVoiceDispatchFocus(focus);
  updateSessionInstructions(session);
}

/**
 * 重拼并下发 instructions。焦点变化与设置改语速共用这一个出口。
 *
 * 语速**现读设置**而不是用建连快照：否则「改了语速但没切焦点」永远不生效。
 * 逐字节没变就不发——上游每次刷新都有代价。
 */
function updateSessionInstructions(session: ActiveSession): void {
  const instructions = composeVoiceInstructions(session.personaInstructions, session.focus, {
    continuity: session.continuity,
    screenContextEnabled: isVoiceScreenContextSupported(),
    speechRate: readVoiceLiveSettings()?.speechRate,
  });
  if (instructions === session.instructions) return;
  session.instructions = instructions;
  logger.info('instructions updated', { voiceSessionId: session.id, chars: instructions.length });
  session.upstream.updateInstructions(instructions);
}

/** 设置里改了通话语速时重发 instructions。无活跃通话 = no-op。 */
export function refreshVoiceInstructions(): void {
  if (!active) return;
  updateSessionInstructions(active);
}

/** 一条 Renderer WS 的事件绑定。重连换 socket 时原样再绑一次。 */
function bindClientHandlers(session: ActiveSession, client: WsSocket): void {
  const { id, upstream } = session;
  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (active?.id !== id) return;
    if (isBinary) {
      // direct 形态的媒体面不经 Host（Renderer 直连上游），这里收到二进制帧只能是
      // 客户端接错了传输形态——丢弃比静默 no-op 转发更接近真相。
      if (upstream.kind === 'relay') upstream.sendAudio(data);
      // 采集链探针：首帧 + 每 200 帧记一次，带幅值峰值——没有这行，原生采集
      // 静音/断流与「模型不响应」在日志里不可区分（AEC 判因第三例的教训）。
      session.inboundAudioFrames += 1;
      if (session.inboundAudioFrames === 1 && session.inboundAudioWatchdogTimer) {
        clearTimeout(session.inboundAudioWatchdogTimer);
        session.inboundAudioWatchdogTimer = null;
      }
      if (session.inboundAudioFrames === 1 || session.inboundAudioFrames % 200 === 0) {
        let peak = 0;
        for (let i = 0; i + 1 < data.length; i += 2) {
          const v = Math.abs(data.readInt16LE(i));
          if (v > peak) peak = v;
        }
        logger.info('client audio inbound', {
          voiceSessionId: id, frames: session.inboundAudioFrames, bytes: data.length, peak, relay: upstream.kind === 'relay',
        });
      }
      return;
    }
    let command: VoiceClientCommand;
    try {
      command = JSON.parse(data.toString()) as VoiceClientCommand;
    } catch {
      return;
    }
    // 用户显式挂断走真 teardown，不进宽限窗——他不是断线，是不想打了。
    if (command.type === 'end') void teardown('client-end');
    else if (command.type === 'interrupt') {
      const responseId = upstream.interrupt();
      if (responseId) {
        rememberCancelledResponse(session, responseId);
        send(session.clientRef.current, { type: 'response.cancelled', responseId, reason: 'interrupt' });
      }
    }
    else if (command.type === 'interrupt.playback') {
      const candidate = session.interruption.candidates.get(command.candidateId);
      if (candidate) candidate.assistantPlaying = command.playing;
      if (command.playing) handleNarrationPlaybackInterrupted(session);
      logger.info('voice interrupt playback observed', {
        voiceSessionId: id,
        candidateId: command.candidateId,
        playing: command.playing,
        playedMs: command.playedMs,
        queuedMs: command.queuedMs,
      });
    }
    else if (command.type === 'narration.playback_started') {
      handleNarrationPlaybackStarted(session, command.narrationId);
    }
    else if (command.type === 'focus') applyFocus(session, command.context);
    // PTT/点按手动模式：Renderer 松开（或再点按）后提交这一轮。
    // direct 形态的 commit 走它自己的 data channel，不经过 Host——这里没有它的分支是刻意的。
    else if (command.type === 'commit' && upstream.kind === 'relay') upstream.commit();
    // 音频管线诊断（批 X §5）：AEC 走没走原生、为什么降级，落进 host 日志才能事后判因。
    else if (command.type === 'audio_mode') {
      logger.info('client audio mode', { voiceSessionId: id, mode: command.mode, reason: command.reason });
    }
    else if (command.type === 'audio_diagnostic') {
      logger.info('client audio diagnostic', { voiceSessionId: id, code: command.code });
    }
  });

  // 断了先等重连，别急着落摘要卡：网络抖一下不该变成「一通电话结束 + 另一通开始」。
  client.on('close', () => {
    if (active?.id === id && session.clientRef.current === client) beginReconnectGrace(id);
  });
  client.on('error', () => {
    if (active?.id === id && session.clientRef.current === client) beginReconnectGrace(id);
  });
}

/** 宽限窗内客户端回来了：换 socket，通话继续。 */
function reattachVoiceClient(session: ActiveSession, client: WsSocket): void {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = null;
  session.clientRef.current = client;
  bindClientHandlers(session, client);
  logger.info('client reattached', { voiceSessionId: session.id });
  // 让 Renderer 知道自己接回的是同一通电话（它据此保留 work items / 通话计时）。
  send(client, { type: 'state', state: 'live' });
}

/** 测试用：强制释放当前通话。 */
export async function endActiveVoiceSession(): Promise<void> {
  await teardown('explicit-end');
}
