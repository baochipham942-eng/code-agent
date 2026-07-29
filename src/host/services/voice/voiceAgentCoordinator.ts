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
import type { VoiceFocusContext, VoiceWorkItem, VoiceWorkItemStatus, VoiceWorkNarration } from '../../../shared/contract/voice';
import { VOICE_CONCLUSION_LOOKBACK_MESSAGES, VOICE_RECENT_FILE_LIMIT, VOICE_SPAWN_TASK_MAX_ITERATIONS } from '../../../shared/constants/voice';
import { getIncompleteTasks } from '../planning/taskStore';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { buildRoleContextBlock } from '../roleAssets/roleAssetService';
import { withWorkbenchTurnSystemContext } from '../../app/workbenchTurnContext';
import { getPermissionModeManager } from '../../permissions/modes';
import { getConfigService } from '../core/configService';
import { buildWorkNarration, resolveNarrationSpeaker } from './voiceNarration';
import { describeWorkFailure } from './workFailureDescription';
import type { ProjectSourceTrustFailureMarker } from '../../../shared/contract/project';

const logger = createLogger('VoiceCoordinator');

/** 方案 §6.3。share_context 归批 H 的焦点上报，appshot 是 Phase 3，都不在这里。 */
export type VoiceIntent =
  | { kind: 'status' }
  | { kind: 'recent_files' }
  | { kind: 'spawn_task'; title: string; prompt: string }
  | { kind: 'steer_task'; instruction: string }
  | { kind: 'cancel_task' }
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

const TERMINAL: readonly VoiceWorkItemStatus[] = ['done', 'failed', 'cancelled'];

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
  listener: (event: TaskManagerEvent) => void;
  listenerAttached: boolean;
  /** 用户此刻在看什么（§6.5 焦点上报）；决定 get_current_file_summary 答什么。 */
  focus: VoiceFocusContext | null;
  /** 近窗字幕原文（voiceSessionService 每落一条 final 就推一次），派活时随 run 一起交给执行侧。 */
  transcript: VoiceTranscriptEntry[];
}

// ponytail: 通话是全局单路（voiceSessionService 的互斥），一个模块级账本就够，
// 不为「将来可能多路」预建 Map。
let ledger: LedgerState | null = null;

async function taskManager() {
  const { getTaskManager } = await import('../../task');
  return getTaskManager();
}

async function notifyVoiceWorkSettledAfterHangup(
  state: LedgerState,
  item: VoiceWorkItem,
  status: 'done' | 'failed',
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
    listener: (event) => onTaskManagerEvent(event),
    listenerAttached: false,
    focus: null,
    transcript: [],
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
  return [
    '[Voice — 通话近窗字幕原文]',
    '这件活来自一通实时语音通话。任务描述是语音层改写出来的，可能丢信息，也可能被语音识别写错。',
    '下面是通话最近几轮的原始字幕（可能含半句、重复、同音错字）：',
    ...entries.map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`),
    '以字幕原文为准重建用户的真实意图。文件名/路径/专名明显是同音错写时（例：「a点text」= a.txt），',
    '按上下文纠正后执行，并在结果里说明你是按什么理解做的。',
    '**用户此刻在打电话，不在键盘前**：不要向他提问、不要弹选择框等他回答——他看不见也点不了。',
    '信息不全就按最合理的默认做法先做完，然后在结果里一句话说明你按什么假设做的。',
  ].join('\n');
}

/** 第一件活派出去时才把生命周期 listener 挂上。 */
async function ensureListener(state: LedgerState): Promise<void> {
  if (state.listenerAttached) return;
  state.listenerAttached = true;
  (await taskManager()).on('event', state.listener);
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
  detachIfSettled(false);
}

function detachIfSettled(force: boolean): void {
  const state = ledger;
  if (!state) return;
  const unsettled = [...state.items.values()].some((item) => !TERMINAL.includes(item.status));
  if (!force && (unsettled || state.emit)) return;
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
  failure?: ProjectSourceTrustFailureMarker,
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
  if (status === 'done' || status === 'failed') {
    if (state.narrate === null) {
      void notifyVoiceWorkSettledAfterHangup(state, settled, status);
    } else {
      void narrateSettled(state, settled, status);
    }
  }
  getPermissionModeManager().clearLiveVoiceSession(state.neoSessionId, runHoldId(id));
  if (state.pendingId === id) state.pendingId = null;
  detachIfSettled(false);
}

/**
 * 取结论文本 → 裁成能说的话 → 连署名一起交给语音层（W6-1）。
 *
 * 结论来源是**执行侧这一轮真写下来的最后一句 assistant 消息**，不是工具返回值的措辞——
 * 后者是我们自己编的模板（「已经排上队」），念出来等于系统在自言自语。
 * 取不到就退回状态本身：`buildWorkNarration` 允许 summary 为空，宁可只说「做完了」，
 * 也不编一句它没说过的话。
 */
async function narrateSettled(state: LedgerState, item: VoiceWorkItem, status: 'done' | 'failed'): Promise<void> {
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
      settle(state, pendingId, 'done');
      break;
    case 'task_error': {
      const data = event.data as {
        error?: unknown;
        failure?: ProjectSourceTrustFailureMarker;
      } | undefined;
      const detail = typeof data?.error === 'string' ? data.error : '执行失败';
      const failure = data?.failure?.code === 'PROJECT_SOURCE_TRUST'
        && (
          data.failure.kind === 'source_missing'
          || data.failure.kind === 'identity_changed'
          || data.failure.kind === 'not_trusted'
        )
        ? data.failure
        : undefined;
      settle(state, pendingId, 'failed', detail, failure);
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
      return spawnTask(state, intent.title, intent.prompt);
    case 'steer_task':
      return steerTask(state, intent.instruction);
    case 'cancel_task':
      return cancelTask(state);
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
  const speaker = resolveNarrationSpeaker(state.activeAgentId);
  upsert(state, { id: workItemId, title, status: 'queued' });
  state.pendingId = workItemId;
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

/**
 * 挂断 tail flush（P0-3，产品负责人 2026-07-28 拍板「自动补派」）。
 *
 * 真机 dogfood 的失败形态是「说了一通，一件活都没派出去」——通话 brain 在碎句里
 * 一路追问澄清，直到用户挂断。挂断是这条链上最后一次机会：把这通电话的字幕交给
 * 执行侧的文本模型，让它自己判断有没有没做的事。
 *
 * 三条闸同时满足才补派，宁可漏补不可乱补：
 * 1. **本通电话一件活都没派过**——派过就说明链路是通的，没派的那部分多半是用户主动放弃的；
 * 2. 近窗里**有用户说过话**——空通话什么都不做；
 * 3. 会话**当前空闲**——有活在跑时插一件新的会撞 TaskManager 的并发闸。
 *
 * 判「有没有要做的事」交给执行侧模型，不自己写分类器：它已经拿到近窗原文
 * （buildRunOptions 的 transcript 块），而「没有待办就什么都不做」是它能理解的指令。
 *
 * 已知代价：人已经挂断走开，这条 run 若撞上 D4 抬严的权限卡就会停在那儿等确认。
 * 这是「宁可停下也不越权」的正确行为，但用户下次回来才看得到。
 */
export async function flushVoiceTail(): Promise<boolean> {
  const state = ledger;
  if (!state) return false;
  if (state.items.size > 0) return false;
  const lastUser = [...state.transcript].reverse().find((entry) => entry.role === 'user');
  if (!lastUser) return false;

  const tm = await taskManager();
  // 忙档与 spawnTask 用同一份判据：startTask 在这四档会抛。
  const status = tm.getSessionState(state.neoSessionId).status;
  if (status === 'running' || status === 'queued' || status === 'paused' || status === 'cancelling') {
    logger.info('tail flush skipped: session busy', { status });
    return false;
  }

  const title = `通话结束补派：${lastUser.text.slice(0, 20)}`;
  logger.info('tail flush dispatching', { neoSessionId: state.neoSessionId, entries: state.transcript.length });
  await startRun(state, title, [
    '这通语音通话刚刚结束，通话过程中一件任务都没有派出来。',
    '看上面「通话近窗字幕原文」里用户说的话：',
    '如果里面有明确的、还没被执行的动作请求（建文件、改东西、跑命令等），现在把它做掉。',
    '如果只是闲聊、或者没有能确定下来的动作，就什么都不要做，直接结束并说明没有发现待办。',
    '注意用户已经挂断电话，不在旁边——不要反问，按最合理的理解做或者不做。',
  ].join('\n'));
  return true;
}

async function spawnTask(state: LedgerState, title: string, prompt: string): Promise<string> {
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  // startTask 在 running/queued/paused/cancelling 时会抛。与其抛给通话 brain 一句
  // 异常文本，不如把「现在有活在跑」这个事实说清楚，并告诉用户两条出路。
  if (status === 'running' || status === 'queued' || status === 'paused' || status === 'cancelling') {
    return `现在还有一件活在跑，没有派新的。要改方向就说「改成……」，要停就说「别做了」。`;
  }
  await startRun(state, title, prompt);
  // 措辞必须写死状态：通话 brain 会把工具返回值当事实原样转述给用户。
  return `任务「${title}」已经排上队，还在后台跑，没做完。别说已经完成。`;
}

async function steerTask(state: LedgerState, instruction: string): Promise<string> {
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  const pending = state.pendingId ? state.items.get(state.pendingId) : undefined;

  if (status !== 'running' && status !== 'queued' && status !== 'paused') {
    // 没有在跑的活，「改成 X」就是「做 X」。开新的一件，别假装 steer 成功了。
    const title = instruction.slice(0, 30);
    await startRun(state, title, instruction);
    return `刚才没有在跑的活，已经把「${title}」当成新任务派出去了，还在后台跑。`;
  }

  await tm.interruptAndContinue(state.neoSessionId, instruction, undefined, await buildRunOptions(state));
  const title = pending?.title ?? '进行中的任务';
  return `已经打断「${title}」并按新要求继续，还在后台跑，没做完。`;
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

async function cancelTask(state: LedgerState): Promise<string> {
  const tm = await taskManager();
  const status = tm.getSessionState(state.neoSessionId).status;
  if (status !== 'running' && status !== 'queued' && status !== 'paused') {
    return '现在没有在跑的活，不用停。';
  }
  const title = state.pendingId ? state.items.get(state.pendingId)?.title : undefined;
  await tm.cancelTask(state.neoSessionId);
  // 终态由 task_cancelled 事件落；这里只回话，不抢着改状态。
  return title ? `已经让「${title}」停下来了。` : '已经让正在跑的活停下来了。';
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

function describeStatus(state: LedgerState): string {
  const lines: string[] = [];
  const live = [...state.items.values()].filter((item) => !TERMINAL.includes(item.status));
  for (const item of live) lines.push(`- ${item.title}（${statusText(item.status)}）`);
  for (const task of getIncompleteTasks(state.neoSessionId)) lines.push(`- ${task.subject}（${task.status}）`);
  if (!lines.length) return '当前没有进行中的任务。';
  return lines.join('\n');
}

function statusText(status: VoiceWorkItemStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '进行中';
    case 'done': return '已完成';
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
