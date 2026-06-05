// ============================================================================
// LoopController — 会话内循环执行器（Slice 1：前台版，状态存内存不持久化）
//
// 在指定 session 上反复调 orchestrator.sendMessage，直到：
//   - agent 输出软停止标记（condition_met）
//   - 触到 maxTurns 上限（completed/max_turns）
//   - 用户喊停（stopped/user）
//   - 出错（failed/error）
// 每轮回复走当前 session 的正常流式链路，自然显示在聊天里——无需专门事件推送。
// Slice 2 再做后台化（脱离会话存活、持久化、完成通知）。
// ============================================================================

import { randomUUID } from 'node:crypto';
import {
  LOOP_DEFAULT_MAX_TURNS,
  type LoopRunConfig,
  type LoopRunState,
  type LoopStatus,
  type LoopStopReason,
} from '../../shared/contract/loop';
import { buildTurnPrompt, detectDoneMarker, parseWaitMs } from './loopPrompt';
import { getTaskManager } from '../task';
import { getSessionManager } from '../services/infra/sessionManager';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('LoopController');
/** 读取最近 assistant 回复时回看的消息条数。 */
const REPLY_LOOKBACK = 5;

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
