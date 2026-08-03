// ============================================================================
// VoiceAgentCoordinator（方案 §6.2 模式 B）
//
// 语音侧一切执行动作的唯一出口。通话 brain 只产出 Intent，权限判定、D4 抬严取还票、
// 派活/改方向/叫停、work item 生命周期回流全部收在这一个文件里。
//
// 为什么派活要走 TaskManager.startTask 而不是 orchestrator.sendMessage（批 H 的根因修）：
//   批 A 的 spawn_task 直接 getOrCreateCurrentOrchestrator().sendMessage()，**绕开了
//   TaskManager 的状态机**——sessionStates 里这条会话始终是 idle。后果是
//   TaskManager.cancelTask() 看到 idle 直接 warn 后返回（叫停无效），
//   interruptAndContinue() 看到非 running 会 fallthrough 成 startTask（「改方向」变成
//   又派一件新活，老的还在跑）。所以「接既有 steer/cancel API」的前提是派活先回到
//   同一条状态机上。回到 startTask 之后，并发闸、事件流、steer、cancel 全部免费拿到。
// ============================================================================

import type { TaskManagerEvent } from '../../task/TaskManager';
import type { AgentEvent } from '../../../shared/contract/agent';
import type { SessionTask, TodoItem } from '../../../shared/contract/planning';
import type { VoiceFocusContext, VoiceWorkFailureMarker, VoiceWorkItem, VoiceWorkItemStatus, VoiceWorkNarration } from '../../../shared/contract/voice';
import {
  VOICE_CONCLUSION_LOOKBACK_MESSAGES,
  VOICE_RECENT_FILE_LIMIT,
  VOICE_SPAWN_TASK_MAX_ITERATIONS,
  VOICE_STOP_CONFIRM_RETRIES,
  VOICE_STOP_CONFIRM_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import { getIncompleteTasks } from '../planning/taskStore';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { buildRoleContextBlock } from '../roleAssets/roleAssetService';
import { withWorkbenchTurnSystemContext } from '../../app/workbenchTurnContext';
import { getPermissionModeManager } from '../../permissions/modes';
import { getConfigService } from '../core/configService';
import { buildBlockedNarration, buildMilestoneNarration, buildStopNarration, buildWorkNarration, resolveNarrationSpeaker, type VoiceStopAnnouncementKind } from './voiceNarration';
import { describeWorkFailure } from './workFailureDescription';
import { buildVocabularyBlock } from './voiceVocabulary';
import { resolveVoiceWorkOutcome } from './voiceWorkEvidence';
import { recordVoiceWorkEvent } from './voiceTelemetry';

const logger = createLogger('VoiceCoordinator');

/** 方案 §6.3。share_context 归批 H 的焦点上报，appshot 是 Phase 3，都不在这里。 */
export type VoiceIntent =
  | { kind: 'status' }
  | { kind: 'recent_files' }
  /**
   * `replaceCurrent`：用户说的是「别等 X 了，改做 Y」——弃掉手上那件、换成这件。
   * 与 steer_task（改方向、不弃活）是两件事，路由判别写在 voiceRouting 的 prompt 里。
   */
  | { kind: 'spawn_task'; title: string; prompt: string; replaceCurrent?: boolean }
  /**
   * `target`：用户点名了要作用在哪一件活上（get_active_tasks 列出的编号）。
   * 不给 = 手上正在跑的那件（原语义，零行为变化）。给了但对不上就拒绝，见 rejectMismatchedTarget。
   */
  | { kind: 'steer_task'; instruction: string; target?: string }
  | { kind: 'cancel_task'; target?: string }
  | { kind: 'end_call' }
  | { kind: 'current_time' };

/** 通话字幕的一条 final。近窗原文用它组装，不进 UI、不落盘。 */
export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * 近窗字幕最多带几条 / 每条最多多少字。
 *
 * 挑 12 条：真机碎句案例里一件事被 VAD 切成 5 个用户片段 + 5 句助手追问 = 10 条，
 * 12 条能把一件事的来龙去脉整个装下，再多就开始把上一件事的尾巴也拖进来。
 */
const TRANSCRIPT_WINDOW_ENTRIES = 12;
const TRANSCRIPT_ENTRY_MAX_CHARS = 240;

export interface VoiceDispatchBinding {
  neoSessionId: string;
  /** 派活时带上的专家身份；undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** work item 变化推给 Renderer 的 Active Work 条 */
  onWorkItem: (item: VoiceWorkItem) => void;
  /**
   * 一件活落到 failed。与 onWorkItem **不同寿命**：`onWorkItem` 是通话态的 UI 回流，
   * 挂断即断（emit 置 null）；失败留痕必须活到最后一件活落地——语音派出的 run 常常
   * 比通话活得久，而「挂断之后才死」正是最需要留痕的场景（G1，2026-07-28）。
   */
  onWorkFailed: (item: VoiceWorkItem) => void;
  /**
   * 模型自己收线（end_call 工具）。真机 2026-07-28：用户说「挂断当前通话」，
   * 模型答「好，通话已挂断」——而日志里 `reason: client-end` 说明是用户自己点的 X，
   * 模型只是嘴上说。语音层此前压根没有挂断这个动作，这是第二例「说了没做」。
   */
  onEndCall: () => void;
  /**
   * 发言人协议（W6-1）：一件活落 done/failed 时「该念哪句、以谁的身份念」。
   *
   * 与 onWorkItem **同寿命**（挂断即断）而不是跟着 onWorkFailed：电话都挂了，
   * 念给谁听。挂断之后才死的那种失败仍走 onWorkFailed 落屏，不重复。
   */
  onWorkNarration: (narration: VoiceWorkNarration) => void;
}

const TERMINAL: readonly VoiceWorkItemStatus[] = ['done', 'unverified', 'failed', 'cancelled'];

/**
 * 一次「先把手上那件停下来」的在途请求（§1 打断原子性）。
 *
 * 存在的唯一理由是那道硬门：**确认旧的落终态之前，绝不 startRun**。所以「要停谁」
 * 和「停稳之后要派什么」必须一起记着，等终态事件来了在同一处兑现——把它拆成
 * 「先 cancel，然后在别处 setTimeout 里派新活」就等于把门开在两个地方。
 */
interface PendingStop {
  /** 正在等它落终态的那件活 */
  workItemId: string;
  /** 那件活的标题，超时回报时要说清是谁没停稳 */
  title: string;
  /** 停稳后要派的新活；undefined = 纯 cancel_task，不派新活 */
  next?: { title: string; prompt: string };
  timer: NodeJS.Timeout;
  /** 已重发 cancel 的次数，上限 VOICE_STOP_CONFIRM_RETRIES */
  attempts: number;
}

interface LedgerState {
  neoSessionId: string;
  activeAgentId?: string;
  /** 通话挂断后置 null：只记账、不再往已关闭的 WS 推。 */
  emit: ((item: VoiceWorkItem) => void) | null;
  /** 失败留痕；**挂断不清**（见 VoiceDispatchBinding.onWorkFailed）。 */
  onFailed: (item: VoiceWorkItem) => void;
  /** 终态回流；与 emit 同寿命，挂断置 null。 */
  narrate: ((narration: VoiceWorkNarration) => void) | null;
  endCall: () => void;
  items: Map<string, VoiceWorkItem>;
  /** 当前等着状态迁移的那件活。一会话一 orchestrator，同时只可能有一件。 */
  pendingId: string | null;
  /** pendingId 那件活派出去的时刻。证据门据此排掉上一轮遗留的 completion summary。 */
  pendingStartedAt: number;
  listener: (event: TaskManagerEvent) => void;
  listenerAttached: boolean;
  /** 用户此刻在看什么（§6.5 焦点上报）；决定 get_current_file_summary 答什么。 */
  focus: VoiceFocusContext | null;
  /** 近窗字幕原文（voiceSessionService 每落一条 final 就推一次），派活时随 run 一起交给执行侧。 */
  transcript: VoiceTranscriptEntry[];
  /** 在途的「停旧的」请求；同时只可能有一件（通话是单路，手上也只有一件活）。 */
  pendingStop: PendingStop | null;
  /**
   * 被顶掉的活：终态**不念给用户听**（他刚亲口说「别做那个了」，回头再播一遍它的结局
   * 是噪音）。只压播报——onWorkFailed 留痕与落库照旧，屏幕那一路仍然说实话。
   * 停不下来时会从这里移除：那件活还活着，它的结局就还该被念。
   */
  supersededIds: Set<string>;
  /**
   * 上一次看到的 plan entries 快照（按 content 索引 status）。milestone 靠它做差分。
   *
   * 用 content 当键是因为 `TodoItem` 没有 id（`{content, status, activeForm}`）。
   * 同一轮里两条同文案的 entry 会被折成一条——可接受:代价是少播一条进度,
   * 而不是播一条错的。
   */
  todoSnapshot: Map<string, string>;
  /**
   * 上一次看到的执行侧任务轨快照（按 task id 索引 status）。worth-hearing 靠它认
   * 「刚刚卡住」这个跃迁——task_update 每次带全量列表，不做差分就会把同一条卡点
   * 在后续每个事件里反复念一遍。
   */
  taskSnapshot: Map<string, string>;
  /** milestone 去重键的单调计数器。注入通道按 workItemId 去重，撞键就会静默丢播报。 */
  milestoneSeq: number;
  /** agent 事件流的退订函数；与 listener 同寿命，落终态时一起摘。 */
  unobserveAgentEvents: (() => void) | null;
}

// ponytail: 通话是全局单路（voiceSessionService 的互斥），一个模块级账本就够，
// 不为「将来可能多路」预建 Map。
let ledger: LedgerState | null = null;

async function taskManager() {
  const { getTaskManager } = await import('../../task');
  return getTaskManager();
}

/** 会被念出来 / 落屏 / 发通知的那三档终态。cancelled 不在其中（用户自己叫停的）。 */
type SettledOutcome = 'done' | 'unverified' | 'failed';

async function notifyVoiceWorkSettledAfterHangup(
  state: LedgerState,
  item: VoiceWorkItem,
  status: SettledOutcome,
): Promise<void> {
  try {
    // 通话中落终态不走这里，避免把通知基础设施拉进实时语音关键路径。
    const { notificationService } = await import('../infra/notificationService');
    // 通知 body 也是用户可见文案：失败原因必须过⑤的统一出口，不许把 throw 原文
    // （英文 + 内部概念）直接拼进侧栏通知——这是失败告知的第四条路径，同病同治。
    const failureDetail = status === 'failed'
      ? describeWorkFailure(item.detail, item.failure).screen
      : item.detail;
    notificationService.notifyVoiceWorkSettled({
      sessionId: state.neoSessionId,
      taskTitle: item.title,
      status,
      ...(failureDetail ? { detail: failureDetail } : {}),
    });
  } catch (err) {
    logger.warn('voice work settlement notification failed', {
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * 通话建连时绑定。同步、零 IO——**不要在这里 await 加载 TaskManager**：建连是通话的
 * 关键路径，把整棵 task 依赖树拉进来只为了挂一个可能永远用不上的 listener 不划算
 * （真派活时才挂，见 ensureListener）。
 */
export function beginVoiceDispatch(binding: VoiceDispatchBinding): void {
  if (ledger) detachIfSettled(true);
  ledger = {
    neoSessionId: binding.neoSessionId,
    activeAgentId: binding.activeAgentId,
    emit: binding.onWorkItem,
    onFailed: binding.onWorkFailed,
    narrate: binding.onWorkNarration,
    endCall: binding.onEndCall,
    items: new Map(),
    pendingId: null,
    pendingStartedAt: 0,
    listener: (event) => onTaskManagerEvent(event),
    listenerAttached: false,
    focus: null,
    transcript: [],
    pendingStop: null,
    supersededIds: new Set(),
    todoSnapshot: new Map(),
    taskSnapshot: new Map(),
    milestoneSeq: 0,
    unobserveAgentEvents: null,
  };
}

/** 焦点上报进账本，供 get_current_file_summary 用真焦点作答。 */
export function setVoiceDispatchFocus(focus: VoiceFocusContext | null): void {
  if (ledger) ledger.focus = focus;
}

/**
 * 一条 final 字幕进近窗（P0-2，2026-07-28）。
 *
 * 为什么执行侧要拿原文而不是只拿 brain 改写的 prompt：`spawn_task(prompt)` 是通话 brain
 * **改写**出来的，改写会丢信息，而且「改写正确」是这条链上唯一的一条路——它一失手，
 * 用户说的话就再也到不了执行侧。Codex Desktop 的做法是 handoff 载荷同时带
 * `<input>`（意图）和 `<transcript_delta>`（近窗带噪原文），把意图重建的责任从断句层
 * 挪到文本层。碎句、半句、同音错字都由执行侧的文本模型自己复原。
 */
export function pushVoiceTranscript(entry: VoiceTranscriptEntry): void {
  if (!ledger) return;
  const text = entry.text.trim();
  if (!text) return;
  ledger.transcript.push({ role: entry.role, text: text.slice(0, TRANSCRIPT_ENTRY_MAX_CHARS) });
  if (ledger.transcript.length > TRANSCRIPT_WINDOW_ENTRIES) ledger.transcript.shift();
}

/** 近窗字幕拼成一段 system 上下文。空窗返回 null——没东西可说时不要塞空块进 run。 */
function buildTranscriptBlock(entries: VoiceTranscriptEntry[]): string | null {
  if (!entries.length) return null;
  const vocabularyBlock = buildVocabularyBlock();
  return [
    '[Voice — 通话近窗字幕原文]',
    '这件活来自一通实时语音通话。任务描述是语音层改写出来的，可能丢信息，也可能被语音识别写错。',
    '下面是通话最近几轮的原始字幕（可能含半句、重复、同音错字）：',
    ...entries.map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`),
    '以字幕原文为准重建用户的真实意图。文件名/路径/专名明显是同音错写时（例：「a点text」= a.txt），',
    '按上下文纠正后执行，并在结果里说明你是按什么理解做的。',
    '**用户此刻在打电话，不在键盘前**：不要向他提问、不要弹选择框等他回答——他看不见也点不了。',
    '信息不全就按最合理的默认做法先做完，然后在结果里一句话说明你按什么假设做的。',
    ...(vocabularyBlock ? ['', vocabularyBlock] : []),
  ].join('\n');
}

/** 第一件活派出去时才把生命周期 listener 挂上。 */
async function ensureListener(state: LedgerState): Promise<void> {
  if (state.listenerAttached) return;
  state.listenerAttached = true;
  const tm = await taskManager();
  tm.on('event', state.listener);
  // 中途进度（§2）走 agent 事件流旁路：TaskManagerEvent 只有 started/completed/error/
  // cancelled 四个业务事件，**没有进度信号**；进度在 agent 流的 todo_update 里。
  // 旁路接不上只该让用户听不到进度，**不该把派活整条链带走**——进度是锦上添花，
  // 接在必经之路上等于用一个可选功能给主功能做了单点故障。
  try {
    state.unobserveAgentEvents = tm.observeAgentEvents((sessionId, event) => {
      onAgentStreamEvent(state, sessionId, event);
    });
  } catch (err) {
    logger.warn('milestone bypass unavailable; dispatch continues without progress', {
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * 通话挂断。**不还 run 的票、不丢账本**——语音派出去的 run 常常活得比通话久，
 * D4 抬严必须罩住它的整个生命周期（2026-07-26 真机：挂断即解严，后续步骤一次确认都不弹）。
 * 这里只断开 UI 回流；账本与 listener 活到最后一件活落地为止。
 */
export function endVoiceDispatch(): void {
  if (!ledger) return;
  ledger.emit = null;
  ledger.narrate = null;
  // 挂断 = 用户不要执行。在途的替换请求连同它待派的新活一起作废——「通话结束补派」
  // 那条链已被整条删掉（产品负责人 2026-07-30），这里不许自己长回来。
  abortPendingStop(ledger);
  detachIfSettled(false);
}

/** 撤掉在途的「停旧的」请求：停表 + 解除播报抑制。**不派任何新活。** */
function abortPendingStop(state: LedgerState): void {
  const stop = state.pendingStop;
  if (!stop) return;
  clearTimeout(stop.timer);
  state.pendingStop = null;
  state.supersededIds.delete(stop.workItemId);
  logger.info('pending stop aborted', { workItemId: stop.workItemId, hadNext: !!stop.next });
}

function detachIfSettled(force: boolean): void {
  const state = ledger;
  if (!state) return;
  const unsettled = [...state.items.values()].some((item) => !TERMINAL.includes(item.status));
  // pendingStop 在途 = 这条链还没走完（可能马上要 startRun），此刻丢账本会让新 run
  // 的生命周期事件全部落空。它和「有活没落终态」是同一类未结清。
  if (!force && (unsettled || state.emit || state.pendingStop)) return;
  if (state.pendingStop) clearTimeout(state.pendingStop.timer);
  state.unobserveAgentEvents?.();
  state.unobserveAgentEvents = null;
  if (state.listenerAttached) {
    void taskManager().then((tm) => tm.off('event', state.listener)).catch(() => undefined);
  }
  ledger = null;
}

function upsert(state: LedgerState, item: VoiceWorkItem): void {
  state.items.set(item.id, item);
  state.emit?.(item);
}

/** 终态：还票 + 清 pending + 视情况摘 listener。还票幂等，重复调用无害。 */
function settle(
  state: LedgerState,
  id: string,
  status: VoiceWorkItemStatus,
  detail?: string,
  failure?: VoiceWorkFailureMarker,
): void {
  const item = state.items.get(id);
  if (!item || TERMINAL.includes(item.status)) return;
  const settled = {
    ...item,
    status,
    ...(detail ? { detail } : {}),
    ...(failure ? { failure } : {}),
  };
  upsert(state, settled);
  // 失败必须被说出去，且不能挂在 emit 上——emit 挂断即 null，而「挂断之后才死」
  // 恰恰是最需要留痕的那种失败（G1）。这里不吞异常也不让它影响还票。
  if (status === 'failed') {
    try {
      state.onFailed(settled);
    } catch (err) {
      logger.warn('onWorkFailed threw', { message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  // 发言人协议与挂断后可见性互斥：电话还在就念结论；电话已断就发一条带任务名的
  // 会话通知，让侧栏复用既有未读圆点。cancelled 是用户自己叫停的，不重复打扰。
  // 被顶掉的活不回头念结局（§1）：用户刚说完「别做那个了」，再播一遍它的下场是噪音。
  // 只压耳朵这一路——onFailed 留痕和下面的落库照常，屏幕上仍然看得到真实结局。
  const superseded = state.supersededIds.has(id);
  if (!superseded && (status === 'done' || status === 'unverified' || status === 'failed')) {
    if (state.narrate === null) {
      void notifyVoiceWorkSettledAfterHangup(state, settled, status);
    } else {
      void narrateSettled(state, settled, status);
    }
  }
  // 屏幕这一路（X5.5-A2-a）：任务卡的结局必须来自 host 的判定，落库才活得过挂断和重启。
  // 失败留痕走 voiceSessionService 既有那条（notice + 消息流），这里只补 done/unverified。
  if (status === 'done' || status === 'unverified') {
    void persistWorkOutcome(state.neoSessionId, settled, status);
  }
  getPermissionModeManager().clearLiveVoiceSession(state.neoSessionId, runHoldId(id));
  if (state.pendingId === id) state.pendingId = null;
  state.supersededIds.delete(id);
  // 硬门的兑现处：等的那件活落终态了，这才轮到 startRun。必须排在 detachIfSettled 之前，
  // 且 resolvePendingStop 全程把 pendingStop 挂着不放，账本才不会在派新活之前被丢掉。
  resolvePendingStop(state, id);
  detachIfSettled(false);
}

// ============================================================================
// 打断原子性（§1）：异步确认 + 注入回报
// ============================================================================

/** 播一条「停旧的」回报。合成 id 带后缀，不能占用真实 work item 的去重键。 */
function announceStop(state: LedgerState, kind: VoiceStopAnnouncementKind, title: string, anchorId: string): void {
  const narrate = state.narrate;
  // 电话已挂：这句回报没人听，也不该落到挂断后通知里（那条通道是给「活的结局」的）。
  if (!narrate) return;
  narrate(buildStopNarration({
    workItemId: `${anchorId}:stop-${kind}`,
    kind,
    title,
    ...(state.activeAgentId ? { agentId: state.activeAgentId } : {}),
  }));
}

/**
 * 等的那件活落终态了。这是**唯一**允许把替换请求里的新活派出去的地方。
 *
 * pendingStop 直到新活真的 startRun 完（或确认没有新活）才置 null——中间这段 await
 * 里它就是「这条链还没走完」的凭据，detachIfSettled 据此不丢账本。
 */
function resolvePendingStop(state: LedgerState, settledId: string): void {
  const stop = state.pendingStop;
  if (!stop || stop.workItemId !== settledId) return;
  clearTimeout(stop.timer);
  const next = stop.next;
  if (!next) {
    state.pendingStop = null;
    logger.info('stop confirmed', { workItemId: stop.workItemId });
    announceStop(state, 'stopped', stop.title, stop.workItemId);
    return;
  }
  void (async () => {
    try {
      const workItemId = await startRun(state, next.title, next.prompt);
      logger.info('replacement dispatched after stop confirmed', {
        supersededId: stop.workItemId,
        workItemId,
      });
      announceStop(state, 'replaced', next.title, workItemId);
    } catch (err) {
      // 派发失败必须出声：静默吞掉就是「用户说了换成 Y，旧的停了，新的没跑，谁都不知道」。
      const message = err instanceof Error ? err.message : 'unknown';
      logger.warn('replacement failed to dispatch after stop confirmed', { message });
      announceStop(state, 'replace_timeout', next.title, stop.workItemId);
    } finally {
      state.pendingStop = null;
      detachIfSettled(false);
    }
  })();
}

/**
 * 等不到终态。重发 cancel 到上限，仍然等不到就**不派新活**并 fail-loud 回报。
 *
 * 「不派新活」是本条链的全部意义：防双跑的门只有一道，就是「没确认停稳绝不 startRun」。
 * 这里宁可丢掉用户的替换意图（让他再说一次），也不能两件活同时跑。
 */
function onStopTimeout(state: LedgerState): void {
  // 新通话已经换掉账本时，这张表属于上一通电话，不作数。
  if (ledger !== state) return;
  const stop = state.pendingStop;
  if (!stop) return;
  if (stop.attempts < VOICE_STOP_CONFIRM_RETRIES) {
    stop.attempts += 1;
    stop.timer = setTimeout(() => onStopTimeout(state), VOICE_STOP_CONFIRM_TIMEOUT_MS);
    logger.warn('stop not confirmed, retrying cancel', {
      workItemId: stop.workItemId,
      attempt: stop.attempts,
    });
    void taskManager()
      .then((tm) => tm.cancelTask(state.neoSessionId))
      .catch((err: unknown) => {
        logger.warn('retry cancel threw', { message: err instanceof Error ? err.message : 'unknown' });
      });
    return;
  }
  state.pendingStop = null;
  // 它没停成，还活着——它的结局仍然该念给用户听，解除抑制。
  state.supersededIds.delete(stop.workItemId);
  logger.warn('stop confirmation timed out, replacement NOT dispatched', {
    workItemId: stop.workItemId,
    hadNext: !!stop.next,
  });
  announceStop(state, stop.next ? 'replace_timeout' : 'stop_timeout', stop.next?.title ?? stop.title, stop.workItemId);
  detachIfSettled(false);
}

/** 武装一次「停旧的」：标记 superseded（仅替换场景）→ 发 cancel → 起表 → 立即返回台词。 */
async function requestStop(
  state: LedgerState,
  target: { workItemId: string; title: string },
  next?: { title: string; prompt: string },
): Promise<void> {
  const tm = await taskManager();
  if (next) state.supersededIds.add(target.workItemId);
  state.pendingStop = {
    workItemId: target.workItemId,
    title: target.title,
    ...(next ? { next } : {}),
    timer: setTimeout(() => onStopTimeout(state), VOICE_STOP_CONFIRM_TIMEOUT_MS),
    attempts: 0,
  };
  logger.info('stop requested', { workItemId: target.workItemId, hasNext: !!next });
  try {
    await tm.cancelTask(state.neoSessionId);
  } catch (err) {
    // 不在这里回报：超时那条路是「没停稳」的唯一出口，两处都说会让用户听到两遍。
    logger.warn('cancel threw, leaving it to the confirmation timer', {
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * 取结论文本 → 裁成能说的话 → 连署名一起交给语音层（W6-1）。
 *
 * 结论来源是**执行侧这一轮真写下来的最后一句 assistant 消息**，不是工具返回值的措辞——
 * 后者是我们自己编的模板（「已经排上队」），念出来等于系统在自言自语。
 * 取不到就退回状态本身：`buildWorkNarration` 允许 summary 为空，宁可只说「做完了」，
 * 也不编一句它没说过的话。
 */
async function narrateSettled(state: LedgerState, item: VoiceWorkItem, status: SettledOutcome): Promise<void> {
  try {
    const conclusion = status === 'failed'
      ? describeWorkFailure(item.detail, item.failure).spoken
      : await readRunConclusion(state.neoSessionId);
    // await 之后 narrate 可能已被挂断置 null——此刻再念没人听。
    // **但也不能就这么算了**：那正是「说完就挂、活刚好这时跑完」这个最常见的场景，
    // 静默丢掉等于这条代偿链在它最该生效的时刻失效。落回通知那条路。
    const narrate = state.narrate;
    if (!narrate) {
      await notifyVoiceWorkSettledAfterHangup(state, item, status);
      return;
    }
    narrate(buildWorkNarration({
      workItemId: item.id,
      status,
      title: item.title,
      conclusion,
      ...(state.activeAgentId ? { agentId: state.activeAgentId } : {}),
    }));
  } catch (err) {
    logger.warn('narrate settled failed', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

/**
 * 任务卡的结局落库（X5.5-A2-a）。
 *
 * 为什么非落库不可：`work.upsert` 是通话态事件，挂断就断；而任务卡活在会话记录里，
 * 关掉重开还要显示。不落库的话渲染侧只能自己从「这一轮完成了 + 有正文」反推「已完成」——
 * 那正是「模型说了句话就算做完」的那条反推，本批要拆掉的就是它。
 *
 * 消息本身不进对话（`role:'system'`，投影层只取 metadata 不成节点），它是给卡片看的
 * 结局印章，不是说给用户的话。落库失败只降级成「卡上不显示结局」，绝不影响还票和播报。
 */
async function persistWorkOutcome(
  neoSessionId: string,
  item: VoiceWorkItem,
  outcome: 'done' | 'unverified',
): Promise<void> {
  try {
    await getSessionManager().addMessageToSession(neoSessionId, {
      id: `voice-work-settled-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      // 正文只作日志/兜底可读性；渲染一律读 metadata（靠正文反解标题是拿人话当协议）。
      content: `语音派出的任务「${item.title}」${outcome === 'done' ? '已完成' : '已结束，产物待核验'}`,
      timestamp: Date.now(),
      metadata: {
        source: 'voice',
        voiceWorkSettled: { workItemId: item.id, title: item.title, outcome },
      },
    });
  } catch (err) {
    logger.warn('failed to persist work outcome', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

/** 会话里最后一条有正文的 assistant 消息。task_completed 发在 sendMessage await 之后，此时它已落库。 */
async function readRunConclusion(neoSessionId: string): Promise<string> {
  const session = await getSessionManager().getSession(neoSessionId, VOICE_CONCLUSION_LOOKBACK_MESSAGES);
  const messages = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.content?.trim()) return message.content;
  }
  return '';
}

function runHoldId(workItemId: string): string {
  return `run:${workItemId}`;
}

/**
 * TaskManager 事件的 data 是 unknown，标记要在这个边界上重新验形——生产者与消费者
 * 隔着一层无类型事件总线，只有这里能保证「进账本的标记确实是它自称的那个」。
 * 认不出的一律 undefined，让文案退回兜底，绝不半信半疑地当成已识别。
 */
function readFailureMarker(raw: unknown): VoiceWorkFailureMarker | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const marker = raw as { code?: unknown; kind?: unknown; provider?: unknown; model?: unknown };
  if (
    marker.code === 'PROJECT_SOURCE_TRUST'
    && (marker.kind === 'source_missing' || marker.kind === 'identity_changed' || marker.kind === 'not_trusted')
  ) {
    return { code: 'PROJECT_SOURCE_TRUST', kind: marker.kind };
  }
  if (marker.code === 'MODEL_AUTH') {
    return {
      code: 'MODEL_AUTH',
      ...(typeof marker.provider === 'string' && marker.provider ? { provider: marker.provider } : {}),
      ...(typeof marker.model === 'string' && marker.model ? { model: marker.model } : {}),
    };
  }
  return undefined;
}

/**
 * run 正常结束 → 查产物证据 → 落 done 或 unverified（X5.5-A2-a 的唯一判定点）。
 *
 * 判定收在 host 这一处：屏幕、耳朵、通知、通话 brain 四条出口全部消费 settle 的结果，
 * 谁都不许自己再推断一次「是不是完成了」。
 */
async function settleCompletedWithEvidence(
  state: LedgerState,
  workItemId: string,
  dispatchedAtMs: number,
): Promise<void> {
  const outcome = await resolveVoiceWorkOutcome(state.neoSessionId, dispatchedAtMs);
  // await 期间 ledger 可能已被换掉（新通话）——那时这件活的账本不再是当前这本，
  // 但 settle 只动传进来的这本 state，幂等且安全。
  settle(state, workItemId, outcome);
}

/**
 * agent 事件流旁路（§2 + R3）。认两种事件：
 *   - `todo_update`：plan entries 的差分源，产普通进度。
 *   - `task_update`：执行侧任务轨，从中捞「刚刚卡住」的那一下，产 worth-hearing 进度。
 *
 * 为什么不用 TaskManagerEvent：那条流只有 started/completed/error/cancelled 四个业务事件，
 * **没有任何进度信号**（已核实）。进度只在 agent 流里。
 *
 * 只在「本会话 + 有正在跑的语音派活」时才产 milestone：其它会话、以及用户自己在
 * 键盘上发起的轮次，都不该往通话里插播。
 */
function onAgentStreamEvent(state: LedgerState, sessionId: string, event: AgentEvent): void {
  if (ledger !== state) return;
  if (sessionId !== state.neoSessionId) return;
  if (event.type !== 'todo_update' && event.type !== 'task_update') return;
  const pendingId = state.pendingId;
  if (!pendingId) return;
  const item = state.items.get(pendingId);
  // 只给还在跑的活播进度；已落终态的活再播「这步做完了」就是在说过去的事。
  if (!item || TERMINAL.includes(item.status)) return;

  if (event.type === 'task_update') {
    announceNewlyBlocked(state, item, event.data.tasks);
    return;
  }

  const completed = diffCompletedTodos(state.todoSnapshot, event.data as TodoItem[]);
  if (!completed.length) return;
  const narrate = state.narrate;
  if (!narrate) return;
  // 一次事件里可能同时完成多条；只播最后一条——电话里连播三句进度就是碎碎念，
  // 而节制闸的每件活上限也会把后面的丢掉，不如在源头只取最新那条。
  const step = completed[completed.length - 1];
  if (!step) return;
  narrate(buildMilestoneNarration({
    workItemId: `${pendingId}:milestone-${(state.milestoneSeq += 1)}`,
    title: item.title,
    step,
    ...(liveWorkCount(state) > 1 ? { attributed: true } : {}),
    ...(state.activeAgentId ? { agentId: state.activeAgentId } : {}),
  }));
}

/**
 * 执行侧「这条值得听」的唯一取值口（R3 打标处）。
 *
 * **判据：只认任务轨上「刚刚变成 blocked」的那一下。** 这一档对应的正是
 * 「方案不可行 / 要花钱 / 被外部阻塞 / 需要用户决策」——执行侧的 prompt 规矩
 * （prompts/rules/taskManagement.ts）已经把 blocked 定义成「卡在外部障碍（缺权限/
 * 站点拒绝/缺信息）」并强制带人话原因，所以这里不需要给执行侧再发明一套「重要性」
 * 词汇：它早就有了一个用得很克制的表达方式，接上就行。
 *
 * 反过来说，**别的都不标**：一步做完了不标（那是普通进度），任务被创建、被改名、
 * 被完成、被取消都不标。标记一旦泛化成「进展重要的时候标一下」，节制闸就等于没有——
 * 每个生产者都觉得自己那条重要。
 *
 * 只认**跃迁**（上一次不是 blocked、这一次是），不认「当前是 blocked」：task_update
 * 每次带全量任务列表，认后者会让同一条卡点在后续每个事件里被反复播报。
 */
function announceNewlyBlocked(state: LedgerState, item: VoiceWorkItem, tasks: SessionTask[]): void {
  if (!Array.isArray(tasks)) return;
  const narrate = state.narrate;
  let latest: SessionTask | undefined;
  for (const task of tasks) {
    const id = typeof task?.id === 'string' ? task.id : '';
    if (!id) continue;
    const previous = state.taskSnapshot.get(id);
    // 快照无条件更新（哪怕已挂断、哪怕这条不播）：漏记一轮，下次就会把一条早就卡着的
    // 任务当成「刚刚卡住」念出来。
    state.taskSnapshot.set(id, task.status);
    if (task.status !== 'blocked' || previous === undefined || previous === 'blocked') continue;
    latest = task;
  }
  // 一次事件里可能同时卡住好几条，**只播最后一条**——与 todo_update 那条同一个理由：
  // 电话里连播三句就是碎碎念，而且注入一条就会立刻请求一次 response，
  // 同一拍连发多条会让这些 response.create 互相碰撞。少播一条，好过播乱一片。
  if (!narrate || !latest) return;
  narrate(buildBlockedNarration({
    workItemId: `${item.id}:blocked-${(state.milestoneSeq += 1)}`,
    title: item.title,
    subject: latest.subject,
    // blockedReason 存的已经是过了清洗层的人话（机器噪音会被置空），这里不再洗一遍。
    reason: latest.blockedReason ?? '',
    ...(state.activeAgentId ? { agentId: state.activeAgentId } : {}),
  }));
}

/**
 * 差分出「这一轮新变成 completed」的 entry 文案，并就地更新快照。
 *
 * 只认「上一次不是 completed、这一次是」这个**跃迁**，不认「当前是 completed」——
 * 后者会让同一条 entry 在每次 todo_update 里都被重新播报一遍。
 */
function diffCompletedTodos(snapshot: Map<string, string>, todos: TodoItem[]): string[] {
  if (!Array.isArray(todos)) return [];
  const freshlyCompleted: string[] = [];
  for (const todo of todos) {
    const content = typeof todo?.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const previous = snapshot.get(content);
    snapshot.set(content, todo.status);
    if (todo.status === 'completed' && previous !== undefined && previous !== 'completed') {
      freshlyCompleted.push(content);
    }
  }
  return freshlyCompleted;
}

function onTaskManagerEvent(event: TaskManagerEvent): void {
  const state = ledger;
  if (event.sessionId !== state?.neoSessionId) return;
  const pendingId = state.pendingId;
  if (!pendingId) return;
  const item = state.items.get(pendingId);
  if (!item) return;

  switch (event.type) {
    case 'task_started':
      if (item.status === 'queued') upsert(state, { ...item, status: 'running' });
      break;
    case 'task_completed':
      // 「跑完了」不等于「做成了」。证据查完再落终态——查证要读盘，事件回调是同步的，
      // 所以这中间的一小段时间卡片停在 running（诚实：此刻我们确实还不知道结局）。
      void settleCompletedWithEvidence(state, pendingId, state.pendingStartedAt);
      break;
    case 'task_error': {
      const data = event.data as { error?: unknown; failure?: unknown } | undefined;
      const detail = typeof data?.error === 'string' ? data.error : '执行失败';
      settle(state, pendingId, 'failed', detail, readFailureMarker(data?.failure));
      break;
    }
    case 'task_cancelled':
      settle(state, pendingId, 'cancelled');
      break;
    default:
      break;
  }
}

// ============================================================================
// Intent 派发
// ============================================================================

export async function dispatchVoiceIntent(intent: VoiceIntent): Promise<string> {
  const state = ledger;
  if (!state) {
    // 通话没绑定就来了工具调用 = 注册面与执行面不同步，必须留痕而不是静默吞。
    logger.warn('voice intent with no active dispatch binding', { kind: intent.kind });
    return '通话还没就绪，这件事没做。请重说一遍。';
  }
  switch (intent.kind) {
    case 'status':
      return describeStatus(state);
    case 'recent_files':
      return describeFocusedFiles(state);
    case 'spawn_task':
      return spawnTask(state, intent.title, intent.prompt, intent.replaceCurrent);
    case 'steer_task':
      return steerTask(state, intent.instruction, intent.target);
    case 'cancel_task':
      return cancelTask(state, intent.target);
    case 'end_call':
      return endCall(state);
    case 'current_time':
      return describeCurrentTime();
  }
}

/** 派活/改方向共用的一轮 run 选项：身份链与文本轮同源（#637 链，两件事缺一不可）。 */
async function buildRunOptions(state: LedgerState) {
  const roleContextBlock = state.activeAgentId
    ? await buildRoleContextBlock(state.activeAgentId).catch(() => null)
    : null;
  // 近窗字幕走 turnSystemContext 而不是拼进 prompt：prompt 那条消息会原样显示在会话里，
  // 把带噪原文塞进去等于把内部载荷泄漏到用户眼前（本仓刚修过一轮 `<...>` 标签外泄）。
  const transcriptBlock = buildTranscriptBlock(state.transcript);
  const systemBlocks = [roleContextBlock, transcriptBlock].filter((block): block is string => !!block);
  // 执行引擎与通话模型分离（§6.1）：没配就不传，行为与批 H 之前完全一致。
  const executionModel = readVoiceExecutionModel();
  // mode 在返回值里必须是确定的字面量：withWorkbenchTurnSystemContext 的返回类型把它
  // 放宽成可选，而 AgentRunOptions 要求必填。在这里一次收窄，两个调用点都不用各自补。
  return {
    ...(executionModel ? { modelSpec: executionModel } : {}),
    ...withWorkbenchTurnSystemContext({
      mode: 'normal' as const,
      ...(state.activeAgentId ? { agentOverrideId: state.activeAgentId } : {}),
      ...(systemBlocks.length ? { turnSystemContext: systemBlocks } : {}),
      maxIterations: VOICE_SPAWN_TASK_MAX_ITERATIONS,
    }),
    mode: 'normal' as const,
  };
}

/** 读设置里的语音执行引擎；读不到一律 undefined（= 跟随会话默认），绝不让设置读写炸掉派活。 */
function readVoiceExecutionModel(): { provider: string; model: string } | undefined {
  try {
    const configured = getConfigService().getSettings().voice?.live?.executionModel;
    return configured?.provider && configured.model ? configured : undefined;
  } catch {
    return undefined;
  }
}

function newWorkItemId(): string {
  return `voice-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function startRun(state: LedgerState, title: string, prompt: string): Promise<string> {
  const tm = await taskManager();
  await ensureListener(state);
  const options = await buildRunOptions(state);
  const workItemId = newWorkItemId();
  // 新的一件活从空快照起算：沿用上一件的快照会让新 run 首次 todo_update 里那些
  // 「本来就是 completed」的 entry 被误判成刚刚完成，一开跑就播一串假进度。
  // 任务轨同理：首次 task_update 只播种不播报（认跃迁要求上一次存在），
  // 所以开跑时那些「本来就卡着」的任务不会被当成刚刚卡住一起涌出来。
  state.todoSnapshot.clear();
  state.taskSnapshot.clear();
  const speaker = resolveNarrationSpeaker(state.activeAgentId);
  upsert(state, { id: workItemId, title, status: 'queued' });
  // §4.3 的三元组此前只进日志（#903）。派活是这条链的起点，遥测在这里落一条，
  // 后面口播/丢弃两类事件才有同一个 workItemId 可以对上。
  recordVoiceWorkEvent({ phase: 'dispatch', workItemId });
  state.pendingId = workItemId;
  state.pendingStartedAt = Date.now();
  // D4：这张票的寿命跟着 run 走，不跟着通话走。终态事件或启动失败才还。
  getPermissionModeManager().markLiveVoiceSession(state.neoSessionId, runHoldId(workItemId));
  void tm
    // 第 5 个参数落在 startTask 建的那条 role:'user' 消息上。必须标记 voiceDispatch——
    // prompt 是通话 brain 改写出来的，不是用户原话（用户原话是字幕那条），
    // 不标就会顶着用户身份显示在右边。
    .startTask(state.neoSessionId, prompt, undefined, options, {
      // 署名和语音层回流用同一个解析器（voiceNarration），两处不许各算各的：
      // 屏幕上写「牧之」而耳朵里听到别的名字，比不署名更糟。
      voiceDispatch: { title, workItemId, ...(speaker ? { speaker } : {}) },
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : 'unknown';
      logger.warn('voice run failed to start', { title, message: detail });
      // 派发失败必须回流：真机踩过「任务其实没跑起来，通话里却说已经做完了」。
      settle(state, workItemId, 'failed', detail);
    });
  return workItemId;
}

// 「通话结束补派」（P0-3 tail flush）已整条删除（产品负责人 2026-07-30 拍板）：
// 挂断 = 用户不要执行。零派活的通话原样结束，不再拿字幕尾巴替他派一件活
// （那条链还会把一段内部指令 prompt 显示给用户看）。
// 保留的是「已派出任务的挂断后通知」与近窗字幕注入普通派活——它们与本条无关。

async function spawnTask(
  state: LedgerState,
  title: string,
  prompt: string,
  replaceCurrent?: boolean,
): Promise<string> {
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  const busy = status === 'running' || status === 'queued' || status === 'paused' || status === 'cancelling';
  if (busy) {
    // 已经有一次「停旧的」在途：再来一次会把 pendingStop 覆盖掉，第一次的替换意图
    // 就此蒸发（且它的定时器还挂着）。如实说，不排队。
    if (state.pendingStop) {
      return '上一件正在停，还没停稳，这次没有派新的。等我说停好了再讲一次要做什么。';
    }
    if (!replaceCurrent) {
      // 没有替换意图：维持 fail-closed 拒新，并给出两条出路。
      return `现在还有一件活在跑，没有派新的。要改方向就说「改成……」，要停就说「别做了」。`;
    }
    const pendingId = state.pendingId;
    const pending = pendingId ? state.items.get(pendingId) : undefined;
    if (!pendingId || !pending) {
      // 会话在跑，但账本里没有对应的 work item（不是语音派出去的活）。此时无从等待
      // 「那件活」的终态事件，硬门无法成立——不猜、不派。
      logger.warn('replace requested but no voice work item is pending', { status });
      return '现在有一件不是我派的活在跑，我没法替你顶掉它。等它结束，或者你先手动停掉。';
    }
    await requestStop(state, { workItemId: pendingId, title: pending.title }, { title, prompt });
    // 立即返回,不阻塞对话（拍板 2026-08-01 异步确认式）。**这里绝不能说新活已经开始**——
    // 它确实还没开始，而且可能永远不会开始（停不稳就不派）。台词只描述"正在停"这一件
    // 已经真发生的事，结果由后续注入的回报兑现。
    return [
      `现在对用户说：「我正在把手上那件停下来，停稳了就开始做『${title}』。」就说这一个意思。`,
      `**『${title}』现在还没有开始做**，不要说它已经开始、已经在跑、已经派出去了。`,
      '停稳没停稳、新活开没开始，都会以 [BACKEND] 开头的消息告诉你；在那之前你什么都不知道。',
      '用户如果追问，先调 get_active_tasks 看真实状态再回答。',
    ].join('\n');
  }
  await startRun(state, title, prompt);
  // 谎报的根治（批 X ①，2026-07-30）：上一版返回「已经排上队，还在后台跑，没做完。
  // 别说已经完成」——「已排队」是个可润色的状态名词，离「已完成」只差一次善意润色，
  // 真机第三次撞到模型照说「已经建好了」。禁令加狠话是同一招的第三次，不再走。
  // 换成言语行为指令 + 认知协议：返回值不描述状态，只说「你下一句该说什么」，
  // 并把「完成」从可推断的状态收窄成协议事件（只认 [BACKEND] 回流）。
  return spawnSpeechDirective(title);
}

/**
 * 派活后回给通话 brain 的话（①）。三段缺一不可：
 * 1. 下一句台词（没有状态名词，无可润色空间）；
 * 2. 认知协议：结果只会以 [BACKEND] 消息送达，没收到就不存在「做完」；
 * 3. 进度问题强制落地 get_active_tasks，不许凭记忆答。
 */
function spawnSpeechDirective(title: string): string {
  return [
    // 台词写成**用户听得懂的第一人称**（E4，2026-07-30 真机）：上一版是
    // 「『X』这件事你开始做了，做完会立刻主动告诉他」——模型照着念出来，用户听到的是
    // 「你开始做了」，主语错乱、读不懂。「不要复述」类禁令本仓已三连败，所以不加禁令，
    // 改成即使被整句照读也通顺的话。
    `现在对用户说：「我已经开始做『${title}』了，做完马上告诉你。」就说这一个意思，不要再多说。`,
    '关于这件事你目前只知道「已经开始」。它的结果（做成或失败）只会以 [BACKEND] 开头的消息送达；',
    '在收到那条消息之前，它没有做完，你也不知道任何进展——不存在「应该差不多了」。',
    '用户如果问「好了吗」「怎么样了」，先调 get_active_tasks 看真实状态再回答，不要凭记忆或猜测回答。',
  ].join('\n');
}

// ============================================================================
// 定向（R2）：编号 → 那件活，对不上就拒绝
// ============================================================================

/**
 * 播给用户的编号 = 这件活在账本里的**登记次序**（items 只 set 不 delete，一通电话里恒定）。
 *
 * 刻意不用「当前存活项里的第几个」：活会陆续落终态，那种编号每落一件就整体前移——
 * 用户听到的「2 号」和他下一句说出口的「2 号」可能已经不是同一件事，而这条链上编错号
 * 的代价是停错活。代价是号码会有断档（3 件跑完后新的一件是「4」），听着略怪但不会指错。
 */
function ordinalOf(state: LedgerState, workItemId: string): number {
  return [...state.items.keys()].indexOf(workItemId) + 1;
}

/** 编号/id → 那件活。认不出一律 undefined，绝不猜。 */
function resolveTargetItem(state: LedgerState, target: string): VoiceWorkItem | undefined {
  const byId = state.items.get(target);
  if (byId) return byId;
  // 只认「整串里恰好一个数字」（"2"、"2号"、"第2个"）。「1 或 2」这种有两个数字的
  // 一律认不出——用户自己都没说定，我们更不该替他挑一个。
  const matched = /^\D*(\d+)\D*$/.exec(target);
  if (!matched?.[1]) return undefined;
  const id = [...state.items.keys()][Number(matched[1]) - 1];
  return id ? state.items.get(id) : undefined;
}

/**
 * 定向校验。**只在给了 target 时做事**——不给就返回 null 放行，走原来那条路，零行为变化。
 *
 * 返回字符串 = 拒绝的台词。查无此活、已经结束、或指到的不是手上那件，**一律拒绝，
 * 绝不退回当前活**：用户想停 2 号却把 1 号停了，比什么都不做糟得多。这道门是
 * fail-closed 的全部意义，把它改成「找不到就作用于当前活」就等于把门拆了。
 *
 * 为什么「不是手上那件」也要拒：通话这条线是单路的——TaskManager 的 cancel /
 * interruptAndContinue 都按会话粒度生效，根本没有「只停第 2 件」这种操作。能停的
 * 只有手上那件，所以这里只能如实说停不了，而不是假装停了别的。
 */
function rejectMismatchedTarget(
  state: LedgerState,
  target: string | undefined,
  action: '改方向' | '停',
): string | null {
  if (!target) return null;
  const wanted = resolveTargetItem(state, target);
  if (!wanted) {
    return `我这边没有编号是「${target}」的活，什么都没动。先调 get_active_tasks 看一下有哪几件，再报编号。`;
  }
  if (TERMINAL.includes(wanted.status)) {
    return `「${wanted.title}」已经${statusText(wanted.status)}了，不用再${action}它。`;
  }
  if (wanted.id !== state.pendingId) {
    const current = state.pendingId ? state.items.get(state.pendingId) : undefined;
    return [
      `「${wanted.title}」不是我手上正在跑的那件，我${action}不了它——这通电话一次只握得住一件活。`,
      current ? `现在跑的是「${current.title}」。` : '现在手上没有正在跑的活。',
      '如实告诉用户这件事，不要说你已经动了它。',
    ].join('');
  }
  return null;
}

async function steerTask(state: LedgerState, instruction: string, target?: string): Promise<string> {
  const mismatch = rejectMismatchedTarget(state, target, '改方向');
  if (mismatch) return mismatch;
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  const pending = state.pendingId ? state.items.get(state.pendingId) : undefined;

  if (status !== 'running' && status !== 'queued' && status !== 'paused') {
    // 没有在跑的活，「改成 X」就是「做 X」。开新的一件，别假装 steer 成功了。
    const title = instruction.slice(0, 30);
    await startRun(state, title, instruction);
    // 同 spawnSpeechDirective 的口径（①）：不给「还在后台跑」这类可润色状态。
    return `刚才没有在跑的活，「${title}」按新任务开始做了。\n${spawnSpeechDirective(title)}`;
  }

  await tm.interruptAndContinue(state.neoSessionId, instruction, undefined, await buildRunOptions(state));
  const title = pending?.title ?? '进行中的任务';
  return [
    `现在对用户说：「『${title}』我已经按你的新要求改了方向，做完马上告诉你。」`,
    '它的结果同样只以 [BACKEND] 消息为准；没收到就不是做完，被问进度先调 get_active_tasks。',
  ].join('\n');
}

/**
 * 收线。这里只「请求挂断」，真正的 teardown 由 voiceSessionService 在模型把这句
 * 告别说完之后执行——立刻挂会把告别掐掉，用户听到的是电话突然断了。
 * 返回值写死状态：通话 brain 会把它当事实转述。
 */
function endCall(state: LedgerState): string {
  logger.info('end call requested by model');
  state.endCall();
  return '挂断动作已经执行，通话马上结束。跟用户说一句简短的告别，不要再问别的。';
}

/**
 * 停掉手上那件（§1.2）。
 *
 * 改成与 replace 同一套「异步确认 + 注入回报」：上一版工具立即返回「已经让 X 停下来了」，
 * 而终态事件是之后才到的——说"停了"的那一刻并没有确认它停了，这就是一句 fail-open 的
 * 谎报。现在返回值只说"正在停"（一件已经真发生的事），停没停稳由后续注入回报兑现。
 */
async function cancelTask(state: LedgerState, target?: string): Promise<string> {
  const mismatch = rejectMismatchedTarget(state, target, '停');
  if (mismatch) return mismatch;
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  if (status !== 'running' && status !== 'queued' && status !== 'paused') {
    return '现在没有在跑的活，不用停。';
  }
  if (state.pendingStop) {
    return '已经在停了，还没停稳。停好了我会说。';
  }
  const pendingId = state.pendingId;
  const pending = pendingId ? state.items.get(pendingId) : undefined;
  if (!pendingId || !pending) {
    // 不是语音派出去的活：照发 cancel，但没有可等的终态事件，不武装确认链，
    // 也就不能承诺"停好了会告诉你"。
    await tm.cancelTask(state.neoSessionId);
    return '现在对用户说：「我已经发出了停止的指令。」不要说它已经停了——那件活不是我派的，我确认不了。';
  }
  await requestStop(state, { workItemId: pendingId, title: pending.title });
  return [
    `现在对用户说：「我正在让『${pending.title}』停下来。」就说这一个意思。`,
    '**不要说它已经停了**——停没停稳会以 [BACKEND] 开头的消息告诉你，在那之前你不知道。',
  ].join('\n');
}

// ============================================================================
// 只读查询
// ============================================================================

/**
 * 现在几点（真机 2026-07-28：用户问「现在几点了？」，通话 brain 答「我这边看不到具体时间」，
 * 用户只好说「通过 computer use 来看」才绕出去——语音层拿不到时间是产品缺陷不是模型笨）。
 * 走工具而不是往 instructions 里注入时间：instructions 只在建连和焦点变化时刷新，
 * 注进去的时间会随通话变旧，而这是个「问了就该准」的问题。
 */
function describeCurrentTime(): string {
  const now = new Date();
  const text = now.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  return `现在是${text}。`;
}

/**
 * 「现在在跑什么」。分两组，因为这两组**能不能被指挥是不一样的**：
 *
 * 上面一组是我派出去的 run，带编号，可以拿编号定向 steer / cancel；下面一组是执行侧
 * 计划里的条目，它们不是 run，停不了也改不了。上一版把两组平铺成同一串 `- xxx`，
 * 通话 brain 无从分辨，只能把「停掉那个」翻译成「停手上那件」——指挥台的第一课是
 * 先让人看清哪些东西是可以被指的。
 */
function describeStatus(state: LedgerState): string {
  const lines: string[] = [];
  const live = [...state.items.values()].filter((item) => !TERMINAL.includes(item.status));
  if (live.length) {
    lines.push('我派出去的活（要改方向或叫停，把编号传给 target）：');
    for (const item of live) {
      lines.push(`${ordinalOf(state, item.id)}. ${item.title}（${statusText(item.status)}）`);
    }
  }
  const planned = getIncompleteTasks(state.neoSessionId);
  if (planned.length) {
    lines.push('执行侧计划里还没做完的（这些不是我派的活，改不了也停不了）：');
    for (const task of planned) lines.push(`- ${task.subject}（${task.status}）`);
  }
  if (!lines.length) return '当前没有进行中的任务。';
  return lines.join('\n');
}

/** 此刻有几件活还没落终态。>1 时口播必须点名是哪件的进度，否则用户不知道在讲谁。 */
function liveWorkCount(state: LedgerState): number {
  let count = 0;
  for (const item of state.items.values()) if (!TERMINAL.includes(item.status)) count += 1;
  return count;
}

function statusText(status: VoiceWorkItemStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '进行中';
    case 'done': return '已完成';
    // 终态项已被 describeStatus 滤掉，这几支只为穷尽联合；措辞仍按「不可润色」写，
    // 免得哪天有人把终态也列进去，就地变成一句可以被润成「做完了」的话。
    case 'unverified': return '跑完了但没看到产物，不能算做完';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
  }
}

/**
 * 「你在动哪些文件」。真焦点优先——用户问的是「我现在看的这个」，不是「这轮碰过的一堆」。
 * 没有焦点（CLI 态 / 右栏没开东西）时退回刮会话里发生过的文件动作。
 */
async function describeFocusedFiles(state: LedgerState): Promise<string> {
  const focus = state.focus;
  if (focus?.filePath) {
    const lines = [`当前打开的是 ${focus.filePath}${focus.unsaved ? '（有未保存改动）' : ''}`];
    if (focus.selectedElement) lines.push(`选中的元素：${focus.selectedElement}`);
    return lines.join('\n');
  }
  if (focus?.view && !focus.view.startsWith('preview:')) {
    return `右栏现在看的是${focus.view}，没有打开具体文件。`;
  }
  return describeRecentFiles(state.neoSessionId);
}

/** 兜底：从会话消息里工具调用的 file_path 反推「这轮动过什么」。 */
async function describeRecentFiles(neoSessionId: string): Promise<string> {
  const session = await getSessionManager().getSession(neoSessionId, 30);
  const paths = new Set<string>();
  for (const message of session?.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      const filePath = (call.arguments as Record<string, unknown> | undefined)?.file_path;
      if (typeof filePath === 'string' && filePath) paths.add(filePath);
    }
  }
  if (!paths.size) return '本次会话还没有读写过文件。';
  return [...paths].slice(-VOICE_RECENT_FILE_LIMIT).map((path) => `- ${path}`).join('\n');
}
