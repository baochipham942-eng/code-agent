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
import type { VoiceWorkItem, VoiceWorkItemStatus } from '../../../shared/contract/voice';
import { VOICE_RECENT_FILE_LIMIT, VOICE_SPAWN_TASK_MAX_ITERATIONS } from '../../../shared/constants/voice';
import { getIncompleteTasks } from '../planning/taskStore';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { buildRoleContextBlock } from '../roleAssets/roleAssetService';
import { withWorkbenchTurnSystemContext } from '../../app/workbenchTurnContext';
import { getPermissionModeManager } from '../../permissions/modes';

const logger = createLogger('VoiceCoordinator');

/** 方案 §6.3。share_context 归批 H 的焦点上报，appshot 是 Phase 3，都不在这里。 */
export type VoiceIntent =
  | { kind: 'status' }
  | { kind: 'recent_files' }
  | { kind: 'spawn_task'; title: string; prompt: string }
  | { kind: 'steer_task'; instruction: string }
  | { kind: 'cancel_task' };

export interface VoiceDispatchBinding {
  neoSessionId: string;
  /** 派活时带上的专家身份；undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** work item 变化推给 Renderer 的 Active Work 条 */
  onWorkItem: (item: VoiceWorkItem) => void;
}

const TERMINAL: readonly VoiceWorkItemStatus[] = ['done', 'failed', 'cancelled'];

interface LedgerState {
  neoSessionId: string;
  activeAgentId?: string;
  /** 通话挂断后置 null：只记账、不再往已关闭的 WS 推。 */
  emit: ((item: VoiceWorkItem) => void) | null;
  items: Map<string, VoiceWorkItem>;
  /** 当前等着状态迁移的那件活。一会话一 orchestrator，同时只可能有一件。 */
  pendingId: string | null;
  listener: (event: TaskManagerEvent) => void;
  listenerAttached: boolean;
}

// ponytail: 通话是全局单路（voiceSessionService 的互斥），一个模块级账本就够，
// 不为「将来可能多路」预建 Map。
let ledger: LedgerState | null = null;

async function taskManager() {
  const { getTaskManager } = await import('../../task');
  return getTaskManager();
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
    items: new Map(),
    pendingId: null,
    listener: (event) => onTaskManagerEvent(event),
    listenerAttached: false,
  };
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
function settle(state: LedgerState, id: string, status: VoiceWorkItemStatus, detail?: string): void {
  const item = state.items.get(id);
  if (!item || TERMINAL.includes(item.status)) return;
  upsert(state, { ...item, status, ...(detail ? { detail } : {}) });
  getPermissionModeManager().clearLiveVoiceSession(state.neoSessionId, runHoldId(id));
  if (state.pendingId === id) state.pendingId = null;
  detachIfSettled(false);
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
      const data = event.data as { error?: unknown } | undefined;
      const detail = typeof data?.error === 'string' ? data.error : '执行失败';
      settle(state, pendingId, 'failed', detail);
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
      return describeRecentFiles(state.neoSessionId);
    case 'spawn_task':
      return spawnTask(state, intent.title, intent.prompt);
    case 'steer_task':
      return steerTask(state, intent.instruction);
    case 'cancel_task':
      return cancelTask(state);
  }
}

/** 派活/改方向共用的一轮 run 选项：身份链与文本轮同源（#637 链，两件事缺一不可）。 */
async function buildRunOptions(state: LedgerState) {
  const roleContextBlock = state.activeAgentId
    ? await buildRoleContextBlock(state.activeAgentId).catch(() => null)
    : null;
  // mode 在返回值里必须是确定的字面量：withWorkbenchTurnSystemContext 的返回类型把它
  // 放宽成可选，而 AgentRunOptions 要求必填。在这里一次收窄，两个调用点都不用各自补。
  return {
    ...withWorkbenchTurnSystemContext({
      mode: 'normal' as const,
      ...(state.activeAgentId ? { agentOverrideId: state.activeAgentId } : {}),
      ...(roleContextBlock ? { turnSystemContext: [roleContextBlock] } : {}),
      maxIterations: VOICE_SPAWN_TASK_MAX_ITERATIONS,
    }),
    mode: 'normal' as const,
  };
}

function newWorkItemId(): string {
  return `voice-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function startRun(state: LedgerState, title: string, prompt: string): Promise<string> {
  const tm = await taskManager();
  await ensureListener(state);
  const options = await buildRunOptions(state);
  const workItemId = newWorkItemId();
  upsert(state, { id: workItemId, title, status: 'queued' });
  state.pendingId = workItemId;
  // D4：这张票的寿命跟着 run 走，不跟着通话走。终态事件或启动失败才还。
  getPermissionModeManager().markLiveVoiceSession(state.neoSessionId, runHoldId(workItemId));
  void tm
    .startTask(state.neoSessionId, prompt, undefined, options)
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : 'unknown';
      logger.warn('voice run failed to start', { title, message: detail });
      // 派发失败必须回流：真机踩过「任务其实没跑起来，通话里却说已经做完了」。
      settle(state, workItemId, 'failed', detail);
    });
  return workItemId;
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
 * 「最近动过的文件」取自会话消息里工具调用的 file_path。批 H 的焦点上报通道落地后
 * 由真焦点优先，这条作为兜底（CLI 态 / 没有编辑器焦点时仍要能答）。
 */
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
