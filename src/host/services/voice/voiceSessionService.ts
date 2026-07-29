// ============================================================================
// VoiceSessionService —— Phase 0 最小实现
//
// 职责：全局单路互斥、生命周期、Renderer WS ↔ 上游 transport 的内存中继。
// 媒体面：Renderer 二进制帧 = PCM16@16k 单声道上行；Host 二进制帧 = PCM16@24k 下行。
//         控制/事件面走同一条 WS 的文本帧（JSON）。音频帧不落盘、不进日志。
// ============================================================================

import type { WebSocket as WsSocket } from 'ws';
import { resolveConversationModelOption, VOICE_END_CALL_GOODBYE_TIMEOUT_MS, VOICE_RECONNECT_GRACE_MS, VOICE_SESSION_MAX_DURATION_MS, VOICE_TEARDOWN_DRAIN_MS } from '../../../shared/constants/voice';
import type { VoiceClientCommand, VoiceEvent, VoiceFocusContext, VoiceTransportHandle, VoiceWorkItem, VoiceWorkNarration } from '../../../shared/contract/voice';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { getConfigService } from '../core/configService';
import { getSessionManager } from '../infra/sessionManager';
import { getPermissionModeManager } from '../../permissions/modes';
import { qwenOmniTransport } from './qwenOmniTransport';
import { resolveVoiceRouting } from './voiceRouting';
import { beginVoiceDispatch, endVoiceDispatch, flushVoiceTail, pushVoiceTranscript, setVoiceDispatchFocus } from './voiceAgentCoordinator';
import { composeVoiceInstructions, focusChanged } from './voiceContextAssembler';
import { recordVoiceCall } from './voiceUsageLedger';
import { VOICE_TOOL_DEFINITIONS, executeVoiceTool } from './voiceTools';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';

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
 * 语言偏好走 instructions 而不是上游参数：DashScope 的 input_audio_transcription
 * 语言参数本批未真机验证，不赌；在短人设后追加一句对话语言约束是验证过的路径。
 */
function withLanguageDirective(instructions: string, language: VoiceLiveSettings['language']): string {
  if (language === 'zh') return `${instructions}\n请始终用中文与用户对话。`;
  if (language === 'en') return `${instructions}\nAlways converse with the user in English.`;
  return instructions;
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
  maxDurationTimer: NodeJS.Timeout;
  /** 非 null = 客户端断了，正在宽限窗里等它回来 */
  graceTimer: NodeJS.Timeout | null;
  /** 本次通话派出去的任务数，进通话摘要 */
  workItemCount: number;
  /** 本次通话成功落库的字幕条数，进通话摘要（旧记录没有 = 旧版本通话的判据） */
  transcriptCounter: { count: number };
  /** 助手字幕的增量缓冲：上游只给 delta，挂断时若 done 没到要拿它冲成 final。 */
  transcriptBuf: { assistant: string };
  /** 通话身份的短人设，焦点刷新时要和 Focus 段一起重拼 */
  personaInstructions: string;
  /** 本次通话真用的上游模型（设置白名单解析后），挂断摘要如实记它 */
  conversationModel: string;
  /** 用户此刻在看什么（Renderer 节流上报） */
  focus: VoiceFocusContext | null;
  /** 终态播报只属于这通电话：压住、去重与已播记录都随 active 一起销毁。 */
  narration: {
    userSpeaking: boolean;
    queue: Map<string, { narration: VoiceWorkNarration; suppressedTurns: number; rejectionCount: number }>;
    inFlight: { narration: VoiceWorkNarration; rejectionCount: number } | null;
    spokenWorkItemIds: Set<string>;
  };
}

// ponytail: 单进程内一个模块级变量就是「全局单路」的全部实现（方案 §2.6）。
// 多进程/多窗口场景真出现时再抬到共享状态。
let active: ActiveSession | null = null;
// 建上游连接是 await，闸门必须在 await 之前就合上：只看 active 的话，两路并发拨号
// 会同时通过检查、各建一条上游连接（都在计费，其中一条永远无人释放）。
let connecting = false;
let sessionSeq = 0;

export function getActiveVoiceSessionId(): string | null {
  return active?.id ?? null;
}

function send(client: WsSocket, event: VoiceEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

/**
 * final 字幕落到绑定会话的消息流。走 sessionManager 既有写入路径，不新造存储。
 * 只落文本，不落音频（方案 §8.1）。
 * 传入 counter 时，每次成功落库就 +1——挂断摘要的 transcriptCount 全靠它，
 * 漏一个调用点就会把有对话的电话报成没对话。
 */
/**
 * 派出去的活失败了，这里做两件事（G1，2026-07-28）：
 *
 * 1. **通话里的人当场知道** —— 走既有 notice 通道（同 VOICE_TOOLS_DROPPED 先例），
 *    不新建机制。
 * 2. **失败留痕，事后还找得到** —— notice 是通话态的一次性提示，挂断/切走就没了。
 *    失败必须像通话摘要那样落进消息流，否则「我明明看到它失败了」第二天无从复查。
 *
 * 曾经的第三件「告诉通话模型它派的活死了」（「报喜」的根因：brain 只在被问时才看账本）
 * 已归并到发言人协议的回流通道，见本函数末尾注释。
 *
 * 两件事互不依赖：任一失败都不许影响另一件，也不许把异常抛回 onWorkItem。
 * 通话可能已经挂断（活比通话活得久，见 endVoiceDispatch 顶注）——那时 1 无处可送，
 * 但 2 照样要做，而且那正是最需要它的场景。
 */
async function reportWorkFailure(
  neoSessionId: string,
  voiceSessionId: string,
  clientRef: { current: WsSocket },
  item: VoiceWorkItem,
): Promise<void> {
  const reason = item.detail?.trim() || '执行侧未给出原因';
  const stillOnThisCall = active?.id === voiceSessionId;
  logger.warn('voice work item failed', { voiceSessionId, title: item.title, reason, stillOnThisCall });

  // 1. 通话里当场可见（i18n 表用 {reason} 占位，message 只送原因本身）
  if (stillOnThisCall) {
    send(clientRef.current, { type: 'notice', code: 'VOICE_WORK_FAILED', message: reason });
  }

  // 2. 落进消息流，挂断后仍可复查
  try {
    await getSessionManager().addMessageToSession(neoSessionId, {
      id: `voice-work-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: `语音派出的任务「${item.title}」失败了，没有完成：${reason}`,
      timestamp: Date.now(),
      // workItemId 必须落进 metadata：渲染侧要把这条失败留痕对回它属于的那张任务卡，
      // 唯一能对得准的只有 id。靠正文文本反解标题看着也能跑，但那是拿人话当协议——
      // 文案一改、进一次 i18n，失败就静默不再显示（而这条链的全部意义就是别让失败静默）。
      metadata: { source: 'voice', voiceWorkFailure: { workItemId: item.id, title: item.title } },
    });
  } catch (err) {
    logger.warn('failed to persist work failure', { message: err instanceof Error ? err.message : 'unknown' });
  }

  // 「告诉通话模型它派的活死了」这第三件事，现在归发言人协议的回流通道
  // （onWorkNarration → injectItem）。此前是往 instructions 里塞一段
  // <work_failed_notice>——instructions 是「你是谁」，一次性事件塞进去会变成
  // 永久人设，下一轮、下下轮它还在那儿。同一件事只留一条路。
}

/**
 * 终态回流 → 一句塞进实时会话的话（发言人协议 §2.2）。
 *
 * `[BACKEND] ` 前缀是给模型看的来源标记（用户消息带 `[USER] `），prompt 里明令不许念出来。
 * 措辞写死不留自由发挥空间：模型会把这段话当事实原样转述，失败尤其不能让它自己润色。
 */
function formatNarration(narration: VoiceWorkNarration): string {
  const who = narration.speaker ? `${narration.speaker.displayName}：` : '';
  if (narration.status === 'failed') {
    const reason = narration.summary || '未给出原因';
    return `[BACKEND] ${who}「${narration.title}」失败了，没有完成，原因：${reason}。`
      + '如实告诉用户这件事失败了，绝不要说它已经完成、已经写入或已经生效。';
  }
  return `[BACKEND] ${who}「${narration.title}」做完了。${narration.summary}`.trim();
}

function injectNarration(session: ActiveSession, narration: VoiceWorkNarration, rejectionCount = 0): void {
  if (session.narration.spokenWorkItemIds.has(narration.workItemId)) return;
  const { upstream } = session;
  if (upstream.kind !== 'relay') {
    // WebRTC 形态媒体不经 Host，注入通道要走 Renderer 的 data channel，尚未实现。
    // 静默 no-op = 用户永远等不到那句话且查不出为什么，必须留痕。
    logger.warn('narration dropped: transport has no inject channel', { provider: upstream.provider });
    return;
  }
  upstream.injectItem(formatNarration(narration));
  session.narration.inFlight = { narration, rejectionCount };
  session.narration.spokenWorkItemIds.add(narration.workItemId);
}

function enqueueOrInjectNarration(session: ActiveSession, narration: VoiceWorkNarration): void {
  const state = session.narration;
  if (state.spokenWorkItemIds.has(narration.workItemId) || state.queue.has(narration.workItemId)) return;
  const upstreamResponding = session.upstream.kind === 'relay' && session.upstream.isResponding();
  if (!state.userSpeaking && !upstreamResponding) {
    injectNarration(session, narration);
    return;
  }
  // 只把真实用户轮算进压制次数；单纯撞上模型响应窗不消耗用户轮额度。
  state.queue.set(narration.workItemId, {
    narration,
    suppressedTurns: state.userSpeaking ? 1 : 0,
    rejectionCount: 0,
  });
}

function markNarrationUserTurn(session: ActiveSession): void {
  const state = session.narration;
  state.userSpeaking = true;
  for (const [workItemId, pending] of state.queue) {
    pending.suppressedTurns += 1;
    if (pending.suppressedTurns < 2) continue;
    state.queue.delete(workItemId);
    logger.info('narration dropped after two suppressed user turns', {
      voiceSessionId: session.id,
      workItemId,
    });
  }
}

function flushNarrationQueue(session: ActiveSession): void {
  const state = session.narration;
  state.userSpeaking = false;
  state.inFlight = null;
  // 每次 response.done 只放一条。injectItem 会立即请求下一次 response，
  // 一次清空多条会让这些 response.create 互相碰撞。
  const next = state.queue.entries().next().value as
    | [string, { narration: VoiceWorkNarration; suppressedTurns: number; rejectionCount: number }]
    | undefined;
  if (!next) return;
  state.queue.delete(next[0]);
  injectNarration(session, next[1].narration, next[1].rejectionCount);
}

function handleNarrationInjectionRejected(session: ActiveSession, message: string): void {
  const state = session.narration;
  const failed = state.inFlight;
  state.inFlight = null;
  if (!failed) {
    logger.warn('unmatched narration injection rejection', { voiceSessionId: session.id, message });
    return;
  }
  const { narration, rejectionCount } = failed;
  if (rejectionCount >= 1) {
    logger.warn('narration injection dropped after retry', {
      voiceSessionId: session.id,
      workItemId: narration.workItemId,
      message,
    });
    return;
  }
  state.spokenWorkItemIds.delete(narration.workItemId);
  state.queue.set(narration.workItemId, {
    narration,
    suppressedTurns: 0,
    rejectionCount: rejectionCount + 1,
  });
  logger.info('narration injection rejected; queued one retry', {
    voiceSessionId: session.id,
    workItemId: narration.workItemId,
    message,
  });
}

async function persistTranscript(
  neoSessionId: string,
  role: 'user' | 'assistant',
  text: string,
  counter?: { count: number },
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  // 落库的同时进近窗（P0-2）：派活时执行侧要拿原文自己重建意图，
  // 别只给它通话 brain 改写过的那一句。落库失败不影响近窗，反之亦然。
  pushVoiceTranscript({ role, text: trimmed });
  try {
    await getSessionManager().addMessageToSession(neoSessionId, {
      id: `voice-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content: trimmed,
      timestamp: Date.now(),
      metadata: { source: 'voice' },
    });
    if (counter) counter.count += 1;
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
  session.narration.queue.clear();
  active = null;
  clearTimeout(session.maxDurationTimer);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  logger.info('session ended', { voiceSessionId: session.id, reason });
  // D4：通话态标记必须先于任何后续动作解除，别让抬严挂在会话上不下来。
  // 只还「通话」这一张票。语音派出去、还在飞的 run 各自持票，抬严对它们继续有效——
  // 挂断不再等于解除（2026-07-26 真机：挂断后同一个 run 直接落盘，D4 承诺全失效）。
  getPermissionModeManager().clearLiveVoiceSession(session.neoSessionId, `call:${session.id}`);
  // 排水窗：用户 ASR completed / 助手 transcript done 常在挂断后 ~1s 才到，立刻关
  // 上游会把这通电话说过的话全部丢掉（2026-07-26 真机：12s 通话落库只剩摘要）。
  // 窗口内 onEvent 照常把 final 落库；窗口结束后 done 仍没到的助手增量缓冲冲成 final。
  await new Promise((resolve) => setTimeout(resolve, VOICE_TEARDOWN_DRAIN_MS));
  const pendingAssistant = session.transcriptBuf.assistant;
  if (pendingAssistant.trim()) {
    session.transcriptBuf.assistant = '';
    await persistTranscript(session.neoSessionId, 'assistant', pendingAssistant, session.transcriptCounter);
  }
  const endedAt = Date.now();
  const { startedAt } = session;
  const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationText = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  recordVoiceCall(endedAt, durationSec);
  try {
    await getSessionManager().addMessageToSession(session.neoSessionId, {
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
  // tail flush（P0-3）排在摘要**之后**、账本断开**之前**：
  // 早了不行——账本被 endVoiceDispatch 摘掉就没得派；
  // 但也不能排在摘要前面：渲染侧挂断后的补拉窗口钉在「排水窗 + 500ms」上
  // （voiceCallBridge.scheduleHangupSummaryReload），而补派要走 buildRoleContextBlock
  // 这类可能上百毫秒的准备工作，插在摘要前面会把摘要卡挤出那个窗口，
  // 让刚修好的「摘要卡延迟」原样复发。补派本身是通话之外的活，晚几百毫秒无所谓。
  // 同理它不计进 workItemCount：那个数说的是「这通电话里派出去的活」。
  try {
    await flushVoiceTail();
  } catch (err) {
    logger.warn('tail flush failed', { message: err instanceof Error ? err.message : 'unknown' });
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
  const client = session.clientRef.current;
  if (client.readyState === client.OPEN) client.close();
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
    client.close();
    return;
  }

  const apiKey = getDashscopeApiKey();
  if (!apiKey) {
    send(client, { type: 'error', code: 'VOICE_PROVIDER_UNCONFIGURED', message: '未配置 DashScope API Key' });
    client.close();
    return;
  }

  connecting = true;
  try {
    await connectAndBind(client, neoSessionId, apiKey, requestedAgentId);
  } finally {
    connecting = false;
  }
}

async function connectAndBind(
  client: WsSocket,
  neoSessionId: string,
  apiKey: string,
  requestedAgentId?: string,
): Promise<void> {
  const id = `voice-${Date.now()}-${++sessionSeq}`;
  send(client, { type: 'state', state: 'connecting' });

  const routing = resolveVoiceRouting(requestedAgentId);
  const liveSettings = readVoiceLiveSettings();
  // 通话模型白名单解析：未配置 / 表外 id（手改 JSON）一律回落默认，表外 id 绝不上线。
  const conversationModel = resolveConversationModelOption(liveSettings?.conversationModel);
  if (liveSettings?.conversationModel && liveSettings.conversationModel !== conversationModel.id) {
    logger.warn('conversation model not in whitelist, falling back to default', {
      requested: liveSettings.conversationModel,
    });
  }

  const transcriptBuf = { assistant: '' };
  // 字幕落库计数器：onEvent 闭包与挂断摘要共用同一个可变引用（同 transcriptBuf 先例），
  // 成功落库才 +1，挂断时原样写进 voiceCallSummary.transcriptCount。
  const transcriptCounter = { count: 0 };
  // 模型请求挂断后置位；onEvent 看到这一轮说完（response.done）就真挂。
  const endCallRequested = { value: false };
  const baseInstructions = withLanguageDirective(routing.personaInstructions, liveSettings?.language);
  // 上游回调一律经这个可变引用发：重连换的是 socket，不是通话。
  const clientRef = { current: client };
  // 绑定必须早于建连：上游一旦握手成功就可能立刻发 function_call，
  // 晚绑一步那次调用会落到「通话还没就绪」的兜底上。
  beginVoiceDispatch({
    neoSessionId,
    activeAgentId: routing.activeAgentId,
    onWorkItem: (item) => {
      if (active?.id === id && item.status === 'queued') active.workItemCount += 1;
      send(clientRef.current, { type: 'work.upsert', item });
    },
    // G1（2026-07-28 真机，验收报告自评最严重）：账本早就把死掉的活标成 failed，
    // 但没有任何人把这件事说出来——通话条只渲染 queued/running（VoiceChrome 的
    // activeWorkItems 过滤），failed 就这么无声消失；通话模型也没人告诉它，
    // 于是继续说「已经写好了」。第五例「建好不接电」。
    onWorkFailed: (item) => void reportWorkFailure(neoSessionId, id, clientRef, item),
    // 发言人协议（W6）：一件活落终态 → 把结论塞进实时会话，模型用第一人称念给用户听。
    // 注意 upstream 此刻还不存在（绑定必须早于建连），所以读 active 而不是闭包捕获。
    onWorkNarration: (narration) => {
      if (active?.id !== id) return;
      enqueueOrInjectNarration(active, narration);
    },
    // 模型自己收线：不当场 teardown，先记一笔，等它把告别说完（response.done）再断。
    // 立刻断会把这句告别掐掉，用户听到的是电话突然没了；但也不能无限等——
    // 上游不回 response.done 时用兜底定时器收尾（同 dictation finish 的先例）。
    onEndCall: () => {
      if (endCallRequested.value) return;
      endCallRequested.value = true;
      logger.info('end call requested by model, waiting for goodbye', { voiceSessionId: id });
      setTimeout(() => {
        if (active?.id === id && endCallRequested.value) void teardown('model-end-call-timeout');
      }, VOICE_END_CALL_GOODBYE_TIMEOUT_MS);
    },
  });
  let upstream: VoiceTransportHandle;
  try {
    upstream = await qwenOmniTransport.connect({
      apiKey,
      config: {
        neoSessionId,
        model: conversationModel.id,
        instructions: baseInstructions,
        tools: VOICE_TOOL_DEFINITIONS,
        ...(liveSettings?.voiceId ? { voice: liveSettings.voiceId } : {}),
      },
      onEvent: (event) => {
        // injection.rejected 是 Host 内部的重试信号；Renderer 没有用户动作要做。
        if (event.type !== 'injection.rejected') send(clientRef.current, event);
        if (active?.id === id) {
          if (event.type === 'speech.started') markNarrationUserTurn(active);
          else if (event.type === 'response.done') flushNarrationQueue(active);
          else if (event.type === 'injection.rejected') handleNarrationInjectionRejected(active, event.message);
        }
        if (event.type === 'user.transcript' && event.done) void persistTranscript(neoSessionId, 'user', event.text, transcriptCounter);
        else if (event.type === 'assistant.transcript') {
          if (event.done) {
            transcriptBuf.assistant = '';
            void persistTranscript(neoSessionId, 'assistant', event.text, transcriptCounter);
          } else {
            transcriptBuf.assistant += event.text;
          }
        }
        // 模型说完告别这一轮 = 可以真挂了（end_call 的落点，别让它只是嘴上说）。
        else if (event.type === 'response.done' && endCallRequested.value && active?.id === id) {
          endCallRequested.value = false;
          void teardown('model-end-call');
        }
        // 上游报错 / 上游连接关闭 = 这一路通话已经死了，必须就地释放 active。
        // 否则两侧对「通话是否结束」的判断会分叉：渲染侧收到 error 就把按钮切回「开始通话」，
        // 而 Host 仍占着 active，用户再拨被自己的互斥挡成 VOICE_SESSION_BUSY，
        // 且此时「挂断」已经点不到——整条语音链锁死到 10 分钟 max-duration 才自愈。
        // （2026-07-26 真机踩到：上游 COMMON_ERROR 后必须重启 app 才能再打。）
        else if (event.type === 'error' || (event.type === 'state' && event.state === 'closed')) {
          if (active?.id === id) void teardown(event.type === 'error' ? 'upstream-error' : 'upstream-closed');
        }
      },
      onAudio: (frame) => {
        const socket = clientRef.current;
        if (socket.readyState === socket.OPEN) socket.send(frame, { binary: true });
      },
      onToolCall: (call) => executeVoiceTool(call.name, call.arguments),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connect failed';
    logger.warn('upstream connect failed', { voiceSessionId: id, message });
    endVoiceDispatch();
    send(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE', message });
    client.close();
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
    graceTimer: null,
    workItemCount: 0,
    transcriptCounter,
    transcriptBuf,
    personaInstructions: baseInstructions,
    conversationModel: conversationModel.id,
    focus: null,
    narration: {
      userSpeaking: false,
      queue: new Map(),
      inFlight: null,
      spokenWorkItemIds: new Set(),
    },
    maxDurationTimer: setTimeout(() => {
      logger.warn('session hit max duration, force closing', { voiceSessionId: id });
      void teardown('max-duration');
    }, VOICE_SESSION_MAX_DURATION_MS),
  };
  active = session;
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
  const instructions = composeVoiceInstructions(session.personaInstructions, focus);
  logger.info('instructions updated', { voiceSessionId: session.id, chars: instructions.length });
  session.upstream.updateInstructions(instructions);
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
    else if (command.type === 'interrupt') upstream.interrupt();
    else if (command.type === 'focus') applyFocus(session, command.context);
    // PTT/点按手动模式：Renderer 松开（或再点按）后提交这一轮。
    // direct 形态的 commit 走它自己的 data channel，不经过 Host——这里没有它的分支是刻意的。
    else if (command.type === 'commit' && upstream.kind === 'relay') upstream.commit();
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
