// ============================================================================
// LoopController — 会话内循环执行器（Slice 1：前台版，状态存内存不持久化）
//
// 在指定 session 上反复调 orchestrator.sendMessage，直到：
//   - agent 输出软停止标记（condition_met）
//   - 触到 maxTurns 上限（completed/max_turns）
//   - 用户喊停（stopped/user）
//   - 出错（failed/error）
// 每轮回复走当前 session 的正常流式链路，自然显示在聊天里——无需专门事件推送。
//
// Slice 2 后台化：LoopController 仍是内存里的执行器（loop 本就跑在主进程单例上，
// 切走/关会话不会被杀），这里只把生命周期**镜像**进 backgroundTaskLedger——
// 登记 kind='loop' 的任务、每轮更新进度、终态发系统通知 + 入台账通知，
// 让后台运行的 loop 在任务面板可见、跑完能提醒。App 重启恢复运行不在本切片范围。
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
import { getTaskManager } from '../task';
import { getSessionManager } from '../services/infra/sessionManager';
import { getBackgroundTaskLedger } from '../tasks/backgroundTaskLedger';
import { notificationService } from '../services/infra/notificationService';
import { createLogger } from '../services/infra/logger';

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

export class LoopController {
  private loops = new Map<string, LoopRunState>();
  private aborted = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private waiters = new Map<string, () => void>();

  start(config: LoopRunConfig): LoopRunState {
    const id = `loop_${randomUUID()}`;
    const state: LoopRunState = {
      id,
      sessionId: config.sessionId,
      prompt: config.prompt,
      intervalMs: config.intervalMs,
      maxTurns: config.maxTurns && config.maxTurns > 0 ? config.maxTurns : LOOP_DEFAULT_MAX_TURNS,
      until: config.until,
      turn: 0,
      status: 'running',
      startedAt: Date.now(),
    };
    this.loops.set(id, state);
    this.registerTask(state);
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

  private finish(id: string, status: LoopStatus, reason: LoopStopReason, error?: string): void {
    const s = this.loops.get(id);
    if (!s) return;
    s.status = status;
    s.stopReason = reason;
    s.nextRunAt = undefined;
    if (error) s.error = error;
    this.finalizeTask(s);
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
        metadata: { loopId: state.id, until: state.until, intervalMs: state.intervalMs },
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
        notificationService.notifyTaskComplete({
          sessionId: state.sessionId,
          sessionTitle: title,
          summary,
          duration: durationMs,
          toolsUsed: [],
        });
      }
    } catch (err) {
      logger.warn(`finalizeTask failed for ${state.id}:`, err);
    }
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
        this.syncTaskProgress(state);

        const orchestrator = getTaskManager().getOrCreateCurrentOrchestrator(state.sessionId);
        if (!orchestrator) {
          this.finish(id, 'failed', 'error', `orchestrator unavailable for session ${state.sessionId}`);
          break;
        }

        await orchestrator.sendMessage(buildTurnPrompt(state));
        if (this.aborted.has(id)) break;

        const reply = await this.readLastAssistantReply(state.sessionId);
        if (detectDoneMarker(reply)) {
          this.finish(id, 'completed', 'condition_met');
          break;
        }

        const waitMs = state.intervalMs ?? parseWaitMs(reply) ?? 0;
        if (waitMs > 0) {
          state.nextRunAt = Date.now() + waitMs;
          await this.sleep(id, waitMs);
        }
      }
    } catch (err) {
      this.finish(id, 'failed', 'error', err instanceof Error ? err.message : String(err));
      logger.error(`Loop ${id} failed:`, err);
    } finally {
      this.aborted.delete(id);
      this.timers.delete(id);
      this.waiters.delete(id);
    }
  }

  private async readLastAssistantReply(sessionId: string): Promise<string> {
    try {
      const session = await getSessionManager().getSession(sessionId, REPLY_LOOKBACK);
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
