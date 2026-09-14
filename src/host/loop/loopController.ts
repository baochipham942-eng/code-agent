// ============================================================================
// LoopController — 会话内循环执行器（Slice 1：前台版，状态存内存不持久化）
//
// 在指定 session 上反复调 orchestrator.sendMessage，直到：
//   - agent 输出软停止标记（condition_met）
//   - 触到 maxTurns 上限（completed/max_turns）
//   - 用户喊停（stopped/user）
//   - 出错（failed/error）
// 每轮回复走当前 session 的模型历史链路，但标成 meta，不污染用户可见聊天历史。
//
// Slice 2 后台化：LoopController 仍是内存里的执行器（loop 本就跑在主进程单例上，
// 切走/关会话不会被杀），这里只把生命周期**镜像**进 backgroundTaskLedger——
// 登记 kind='loop' 的任务、每轮更新进度、终态发系统通知 + 入台账通知，
// 让后台运行的 loop 在任务面板可见、跑完能提醒。
//
// 刀2-c：`adopt(state, ledgerCtx)` 从 durable cursor 重建内存态并续跑——
// dispatching/awaiting_reply 重跑当轮（at-least-once）；sleeping 按 nextRunAt 重排。
// ============================================================================

import { randomUUID } from 'node:crypto';
import {
  LOOP_DEFAULT_MAX_TURNS,
  LOOP_TASK_KIND,
  LOOP_TASK_TITLE_MAX_LEN,
  type LoopRunConfig,
  type LoopRunState,
  type LoopStatus,
  type LoopStopReason,
} from '../../shared/contract/loop';
import type { TaskStatus } from '../../shared/contract/backgroundTask';
import { buildTurnPrompt, detectDoneMarker, parseWaitMs } from './loopPrompt';
import { captureLoopOwnerStamp } from './loopOwnership';
import {
  LOOP_DURABLE_PARENT_MISSING_CODE,
  LOOP_INTERRUPTED_REASON,
  LoopDurableLedgerLostError,
  LoopDurableStartError,
  getLoopDurableLedger,
  isLoopDurableArmed,
  waitForLoopDurableLedger,
  type LoopAdoptLedgerContext,
  type LoopEngineCursor,
} from './loopDurableLedger';
import { resolveLoopParentRunId } from './loopDurableParent';
import { getTaskManager } from '../task';
import { getSessionManager } from '../services/infra/sessionManager';
import { getBackgroundTaskLedger } from '../task/backgroundTaskLedger';
import { notificationService } from '../services/infra/notificationService';
import { createLogger } from '../services/infra/logger';
import { getSessionAutomationService } from '../services/sessionAutomation';
import type { SessionAutomationEventKind, SessionAutomationStatus } from '../../shared/contract/sessionAutomation';

const logger = createLogger('LoopController');
/** 读取最近 assistant 回复时回看的消息条数。 */
const REPLY_LOOKBACK = 5;

/** loop 终态 → 后台任务台账终态的映射（running 不在此表内）。 */
const LOOP_TO_TASK_STATUS: Record<Exclude<LoopStatus, 'running'>, TaskStatus> = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'cancelled',
};

function loopTaskTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const clipped =
    flat.length > LOOP_TASK_TITLE_MAX_LEN ? `${flat.slice(0, LOOP_TASK_TITLE_MAX_LEN)}…` : flat;
  return `循环 · ${clipped || '未命名任务'}`;
}

function formatLoopCadence(state: Pick<LoopRunState, 'intervalMs'>): string {
  if (!state.intervalMs) return '自定步调';
  const seconds = Math.round(state.intervalMs / 1000);
  if (seconds < 60) return `每 ${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `每 ${hours} 小时`;
}

interface LoopTurnOrchestrator {
  sendMessage(
    prompt: string,
    attachments: undefined,
    options: {
      inputSource: 'automation';
      mode: 'normal';
      historyVisibility: 'meta';
      deniedToolNames: string[];
    },
  ): Promise<unknown>;
}

interface LoopRuntimePorts {
  getOrchestrator?(sessionId: string): LoopTurnOrchestrator | null;
  readSession?(
    sessionId: string,
    lookback: number,
  ): Promise<{ messages: Array<{ role: string; content: unknown }> } | null>;
}

export class LoopController {
  private loops = new Map<string, LoopRunState>();
  private aborted = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private waiters = new Map<string, () => void>();

  constructor(private readonly ports: LoopRuntimePorts = {}) {}

  async start(config: LoopRunConfig): Promise<LoopRunState> {
    const id = `loop_${randomUUID()}`;
    const wantsDurable = isLoopDurableArmed() && config.durable !== false;
    const maxTurns = config.maxTurns && config.maxTurns > 0 ? config.maxTurns : LOOP_DEFAULT_MAX_TURNS;
    const state: LoopRunState = {
      id,
      sessionId: config.sessionId,
      prompt: config.prompt,
      intervalMs: config.intervalMs,
      maxTurns,
      until: config.until,
      handoffPrompt: config.handoffPrompt,
      turn: 0,
      status: 'running',
      startedAt: Date.now(),
      durable: wantsDurable,
      phase: 'sleeping',
    };
    if (wantsDurable) {
      await this.beginDurable(state);
    }
    this.loops.set(id, state);
    this.registerTask(state);
    this.recordAutomationCreated(state);
    void this.runLoop(id);
    return { ...state };
  }

  stop(id: string, reason: LoopStopReason = 'user'): LoopRunState | null {
    const state = this.loops.get(id);
    if (!state) return null;
    if (state.status === 'running') {
      this.aborted.add(id);
      this.wake(id); // 中断正在等待的 sleep
      state.status = 'stopped';
      state.stopReason = reason;
      state.nextRunAt = undefined;
      this.finalizeTask(state);
      void this.finalizeDurable(state);
    }
    return { ...state };
  }

  list(sessionId?: string): LoopRunState[] {
    const all = [...this.loops.values()].map((s) => ({ ...s }));
    return sessionId ? all.filter((s) => s.sessionId === sessionId) : all;
  }

  get(id: string): LoopRunState | null {
    const s = this.loops.get(id);
    return s ? { ...s } : null;
  }

  /** 停止某 session 上所有运行中的 loop（会话关闭/重置时调用）。 */
  stopAllForSession(sessionId: string): void {
    for (const s of this.loops.values()) {
      if (s.sessionId === sessionId && s.status === 'running') {
        this.stop(s.id, 'user');
      }
    }
  }

  /**
   * 从 durable cursor 重建内存态并续跑。判据一律用内存状态,与 finish() 的终态
   * 守卫同哲学:
   * - 同 id 仍在跑:正常不该发生(租约在本进程手里,sweeper 不该认领);防御性
   *   直接返回,不动账本、不复跑。
   * - 同 id 已是终态(典型:心跳曾失联被 untrack,stop/finish 的 finalize 跳过,
   *   行留 running 被 sweeper 认领回来):不许复活续跑;把认领来的行按内存终态
   *   收口(stopped→cancelled、failed→failed、completed→completed)。
   * - 否则:dispatching/awaiting_reply → 重跑当轮;sleeping → 按 nextRunAt 重排
   *   (过期立即跑)。
   */
  adopt(state: LoopRunState, ledgerCtx: LoopAdoptLedgerContext): LoopRunState {
    const existing = this.loops.get(state.id);
    if (existing?.status === 'running') return { ...existing };
    if (existing) {
      const ledger = getLoopDurableLedger();
      if (ledger) {
        ledger.adopt(existing.id, ledgerCtx);
        void this.finalizeDurable(existing);
      }
      return { ...existing };
    }

    const adopted: LoopRunState = {
      ...state,
      status: 'running',
      durable: true,
      phase: state.phase ?? 'sleeping',
    };
    this.loops.set(adopted.id, adopted);
    const ledger = getLoopDurableLedger();
    if (ledger) ledger.adopt(adopted.id, ledgerCtx);
    this.registerTask(adopted);
    void this.resumeLoop(adopted.id);
    return { ...adopted };
  }

  private finish(id: string, status: LoopStatus, reason: LoopStopReason, error?: string): void {
    const s = this.loops.get(id);
    if (!s) return;
    // 终态守卫:stop() 或先到的 finish 已收口时,竞态迟到的 finish(典型:在途
    // checkpoint 撞上 finalize 后抛错)不许覆写终态、不许重跑 finalizeTask。
    if (s.status !== 'running') return;
    s.status = status;
    s.stopReason = reason;
    s.nextRunAt = undefined;
    if (error) s.error = error;
    this.finalizeTask(s);
    void this.finalizeDurable(s);
  }

  private async beginDurable(state: LoopRunState): Promise<void> {
    const ledger = getLoopDurableLedger() ?? await waitForLoopDurableLedger();
    const parentRunId = resolveLoopParentRunId(state.sessionId);
    if (!parentRunId) {
      throw new LoopDurableStartError(
        LOOP_DURABLE_PARENT_MISSING_CODE,
        'Cannot start a durable loop because this session has no foreground run to parent it',
      );
    }
    await ledger.begin({
      loopId: state.id,
      sessionId: state.sessionId,
      parentRunId,
      config: {
        prompt: state.prompt,
        maxTurns: state.maxTurns,
        ...(state.intervalMs !== undefined ? { intervalMs: state.intervalMs } : {}),
        ...(state.until ? { until: state.until } : {}),
        ...(state.handoffPrompt ? { handoffPrompt: state.handoffPrompt } : {}),
      },
      startedAt: state.startedAt,
    });
  }

  private engineCursor(state: LoopRunState): LoopEngineCursor {
    const inFlight = state.phase === 'dispatching' || state.phase === 'awaiting_reply';
    return {
      schemaVersion: 1,
      kind: 'loop',
      config: {
        prompt: state.prompt,
        maxTurns: state.maxTurns,
        ...(state.intervalMs !== undefined ? { intervalMs: state.intervalMs } : {}),
        ...(state.until ? { until: state.until } : {}),
        ...(state.handoffPrompt ? { handoffPrompt: state.handoffPrompt } : {}),
      },
      turn: inFlight ? Math.max(0, state.turn - 1) : state.turn,
      phase: state.phase ?? 'sleeping',
      ...(state.lastTurnAt !== undefined ? { lastTurnAt: state.lastTurnAt } : {}),
      ...(state.nextRunAt !== undefined ? { nextRunAt: state.nextRunAt } : {}),
    };
  }

  private async checkpointDispatched(state: LoopRunState): Promise<void> {
    if (!state.durable) return; // legacy / --ephemeral：不挂账本，行为不变
    const ledger = getLoopDurableLedger();
    // durable 模式账本失联即 fail-closed：抛给 runLoop 收口 failed，不再花钱。
    if (!ledger) throw new LoopDurableLedgerLostError(state.id);
    await ledger.turnDispatched(state.id, { turn: state.turn, cursor: this.engineCursor(state) });
  }

  private async checkpointCompleted(
    state: LoopRunState,
    extra: { done?: boolean; waitMs?: number } = {},
  ): Promise<void> {
    if (!state.durable) return;
    const ledger = getLoopDurableLedger();
    if (!ledger) throw new LoopDurableLedgerLostError(state.id);
    await ledger.turnCompleted(state.id, {
      turn: state.turn,
      cursor: this.engineCursor(state),
      ...extra,
    });
  }

  private async finalizeDurable(state: LoopRunState): Promise<void> {
    const ledger = getLoopDurableLedger();
    // untracked = 账本已失联（fence 或连续瞬时失败超阈值时已停写）；此处不再补写，
    // durable 行留 running，租约到期由 sweeper 认领后走刀2-c 恢复 handler：
    // 本进程内存已是终态 → adopt 按内存终态收口，否则续跑或降级 interrupted。
    // SQLITE_BUSY 单次抖动不再 untrack（见 track() 的连续窗口容忍），不走这条路。
    if (!ledger?.isTracked(state.id)) return;
    const outcome = state.status === 'completed'
      ? 'completed'
      : state.status === 'stopped' ? 'cancelled' : 'failed';
    try {
      await ledger.finalize(state.id, {
        outcome,
        reason: state.error
          ?? (state.stopReason === 'user' ? 'user' : state.stopReason)
          ?? (outcome === 'failed' ? LOOP_INTERRUPTED_REASON : undefined),
        turn: state.turn,
        cursor: this.engineCursor(state),
        finishedAt: Date.now(),
      });
    } catch (err) {
      logger.warn(`finalizeDurable failed for ${state.id}:`, err);
    }
  }

  // --------------------------------------------------------------------------
  // 后台任务台账镜像：登记 / 进度 / 终态通知
  // --------------------------------------------------------------------------

  /** loop 启动时在台账登记一条 running 任务。 */
  private registerTask(state: LoopRunState): void {
    try {
      getBackgroundTaskLedger().upsertTask({
        id: state.id,
        kind: LOOP_TASK_KIND,
        source: LOOP_TASK_KIND,
        sessionId: state.sessionId,
        title: loopTaskTitle(state.prompt),
        status: 'running',
        createdAt: state.startedAt,
        startedAt: state.startedAt,
        progress: { current: 0, total: state.maxTurns, label: '0 轮' },
        metadata: {
          loopId: state.id,
          until: state.until,
          intervalMs: state.intervalMs,
          handoffPrompt: state.handoffPrompt,
        },
      });
    } catch (err) {
      logger.warn(`registerTask failed for ${state.id}:`, err);
    }
  }

  /** 每轮推进时更新台账进度。 */
  private syncTaskProgress(state: LoopRunState): void {
    try {
      getBackgroundTaskLedger().upsertTask({
        id: state.id,
        status: 'running',
        progress: { current: state.turn, total: state.maxTurns, label: `${state.turn} 轮` },
        metadata: { loopId: state.id, turn: state.turn, lastTurnAt: state.lastTurnAt },
      });
    } catch (err) {
      logger.warn(`syncTaskProgress failed for ${state.id}:`, err);
    }
  }

  /** loop 进入终态时：置台账终态 + 自然完成（非用户喊停）发系统通知与台账通知。 */
  private finalizeTask(state: LoopRunState): void {
    if (state.status === 'running') return;
    const taskStatus = LOOP_TO_TASK_STATUS[state.status];
    const completedAt = Date.now();
    const durationMs = completedAt - state.startedAt;
    const title = loopTaskTitle(state.prompt);
    const succeeded = state.status === 'completed';
    const summary = state.error
      ? state.error
      : succeeded
        ? `已完成 ${state.turn} 轮`
        : `已停止（${state.turn} 轮）`;

    try {
      const ledger = getBackgroundTaskLedger();
      ledger.upsertTask({
        id: state.id,
        status: taskStatus,
        completedAt,
        durationMs,
        summary,
        progress: { current: state.turn, total: state.maxTurns, label: `${state.turn} 轮` },
        ...(state.error
          ? { failure: { message: state.error, reason: state.stopReason } }
          : {}),
        metadata: { loopId: state.id, turn: state.turn, stopReason: state.stopReason },
      });

      // 用户主动喊停不算「跑完」，不发完成提醒；自然完成 / 失败才通知。
      if (state.status !== 'stopped') {
        ledger.queueNotification({
          taskId: state.id,
          sessionId: state.sessionId,
          type: succeeded ? 'task_completed' : 'task_failed',
          title,
          message: summary,
        });
        notificationService.notifyTaskComplete(
          {
            sessionId: state.sessionId,
            sessionTitle: title,
            summary,
            duration: durationMs,
            toolsUsed: [],
            succeeded,
          },
          { force: true }, // 后台 loop 完成：绕过焦点门，无论 app 前台/在哪条会话都提醒
        );
      }
    } catch (err) {
      logger.warn(`finalizeTask failed for ${state.id}:`, err);
    }

    this.recordAutomationFinalized(state, summary, completedAt);
  }

  private recordAutomationCreated(state: LoopRunState): void {
    try {
      void getSessionAutomationService().recordCreated({
        id: `loop:${state.id}`,
        sourceSessionId: state.sessionId,
        type: 'loop',
        status: 'running',
        title: loopTaskTitle(state.prompt),
        cadenceLabel: formatLoopCadence(state),
        nextRunAt: state.nextRunAt,
        sourceRefId: state.id,
        config: {
          // 归属戳（N-LOOP-DURABLE 修复棒）：启动收口只对「归属进程已确认消失」的
          // running 记录动手；没有戳的记录判不出归属，保持原样。
          ownerProcess: captureLoopOwnerStamp(),
          prompt: state.prompt,
          until: state.until,
          intervalMs: state.intervalMs,
          maxTurns: state.maxTurns,
          ...(state.handoffPrompt ? {
            handoffPrompt: state.handoffPrompt,
            nextStage: { prompt: state.handoffPrompt, title: '循环完成后继续' },
          } : {}),
        },
      }).catch((err) => logger.warn(`recordAutomationCreated failed for ${state.id}:`, err));
    } catch (err) {
      logger.warn(`recordAutomationCreated failed for ${state.id}:`, err);
    }
  }

  private recordAutomationFinalized(state: LoopRunState, summary: string, completedAt: number): void {
    const event: SessionAutomationEventKind = state.status === 'failed'
      ? 'failed'
      : state.status === 'stopped'
        ? 'cancelled'
        : 'completed';
    const status: SessionAutomationStatus = state.status === 'failed'
      ? 'failed'
      : state.status === 'stopped'
        ? 'cancelled'
        : 'completed';
    try {
      void getSessionAutomationService().recordEvent({
        automationId: `loop:${state.id}`,
        event,
        status,
        recordStatus: status,
        summary,
        error: state.error,
        eventId: `${event}:loop:${state.id}:${completedAt}`,
        lastRunAt: completedAt,
        // 终态即摘除归属戳：记录不再代表任何活进程（configPatch 里显式 undefined
        // 会在 JSON 序列化时把键抹掉）。
        configPatch: { ownerProcess: undefined },
      }).catch((err) => logger.warn(`recordAutomationFinalized failed for ${state.id}:`, err));
    } catch (err) {
      logger.warn(`recordAutomationFinalized failed for ${state.id}:`, err);
    }
  }

  private async resumeLoop(id: string): Promise<void> {
    const state = this.loops.get(id);
    if (state?.status !== 'running') return;
    const phase = state.phase ?? 'sleeping';
    if (phase === 'sleeping') {
      const remaining = (state.nextRunAt ?? 0) - Date.now();
      if (remaining > 0) {
        await this.sleep(id, remaining);
        if (this.aborted.has(id) || this.loops.get(id)?.status !== 'running') {
          this.aborted.delete(id);
          this.timers.delete(id);
          this.waiters.delete(id);
          return;
        }
      }
    }
    await this.runLoop(id);
  }

  private async runLoop(id: string): Promise<void> {
    const state = this.loops.get(id);
    if (!state) return;
    try {
      while (!this.aborted.has(id) && state.status === 'running') {
        if (state.turn >= state.maxTurns) {
          this.finish(id, 'completed', 'max_turns');
          break;
        }
        state.turn += 1;
        state.lastTurnAt = Date.now();
        state.nextRunAt = undefined;
        state.phase = 'dispatching';
        this.syncTaskProgress(state);
        await this.checkpointDispatched(state);

        const orchestrator = this.ports.getOrchestrator?.(state.sessionId)
          ?? getTaskManager().getOrCreateCurrentOrchestrator(state.sessionId);
        if (!orchestrator) {
          this.finish(id, 'failed', 'error', `orchestrator unavailable for session ${state.sessionId}`);
          break;
        }

        await orchestrator.sendMessage(buildTurnPrompt(state), undefined, {
          inputSource: 'automation',
          mode: 'normal',
          historyVisibility: 'meta',
          deniedToolNames: ['AskUserQuestion', 'ask_user_question'],
        });
        if (this.aborted.has(id)) break;

        state.phase = 'awaiting_reply';
        const reply = await this.readLastAssistantReply(state.sessionId);
        if (detectDoneMarker(reply)) {
          state.phase = 'sleeping';
          await this.checkpointCompleted(state, { done: true });
          this.finish(id, 'completed', 'condition_met');
          break;
        }

        const waitMs = state.intervalMs ?? parseWaitMs(reply) ?? 0;
        state.phase = 'sleeping';
        if (waitMs > 0) {
          state.nextRunAt = Date.now() + waitMs;
          await this.checkpointCompleted(state, { waitMs });
          await this.sleep(id, waitMs);
        } else {
          await this.checkpointCompleted(state, { waitMs: 0 });
        }
      }
    } catch (err) {
      // 判据用状态而非错误文案:stop() 已收口(status 已 stopped)时在途
      // checkpoint 抛错(账本已失联/被 finalize 抢先收口)是预期竞态,维持
      // stopped、不重跑 finalizeTask、不报 task_failed;其余为真实故障,收口 failed。
      if (state.status === 'running') {
        this.finish(id, 'failed', 'error', err instanceof Error ? err.message : String(err));
        logger.error(`Loop ${id} failed:`, err);
      }
    } finally {
      this.aborted.delete(id);
      this.timers.delete(id);
      this.waiters.delete(id);
    }
  }

  private async readLastAssistantReply(sessionId: string): Promise<string> {
    try {
      const session = this.ports.readSession
        ? await this.ports.readSession(sessionId, REPLY_LOOKBACK)
        : await getSessionManager().getSession(sessionId, REPLY_LOOKBACK);
      const messages = session?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          const content = messages[i].content;
          return typeof content === 'string' ? content : '';
        }
      }
    } catch (err) {
      logger.warn(`readLastAssistantReply failed for ${sessionId}:`, err);
    }
    return '';
  }

  /** 可被 stop 中断的 sleep。 */
  private sleep(id: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(id);
        this.waiters.delete(id);
        resolve();
      }, ms);
      this.timers.set(id, timer);
      this.waiters.set(id, resolve);
    });
  }

  private wake(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const resolve = this.waiters.get(id);
    if (resolve) {
      this.waiters.delete(id);
      resolve();
    }
  }
}

let instance: LoopController | null = null;
export function getLoopController(): LoopController {
  if (!instance) instance = new LoopController();
  return instance;
}
