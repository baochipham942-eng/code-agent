// ============================================================================
// WakeService — agent 自发挂起-续跑（self-wake）
// ============================================================================
// 挂起本身不占任何运行时资源：agent 调 sleep_until / wake_on / wake_on_event 后
// 本轮就结束了，等待期零 idle 成本。到点/条件满足由本服务的 tick 从 SQLite 台账里
// 捞出来，再把续跑提示词投递回原会话。
//
// 两条护栏（评审要求，缺一不可）：
//   ① 台账落 SQLite —— 重启后 pending 的醒来仍然会触发（迟到也送）；
//   ② 每会话唤醒配额 —— 挡住「醒来→又挂起→再醒来」的重试风暴和死循环。
// ============================================================================

import { randomUUID } from 'crypto';
import { AGENT_WAKE } from '../../../shared/constants/agent';
import {
  buildWakeResumePrompt,
  type AgentWakeRecord,
  type CreateAgentWakeInput,
} from '../../../shared/contract/agentWake';
import type { AgentWakeRepository } from '../core/repositories/AgentWakeRepository';
import { getDatabase } from '../core/databaseService';
import { createLogger } from '../infra/logger';

const logger = createLogger('WakeService');

export type WakeDeliverFn = (record: AgentWakeRecord) => Promise<void>;

export interface ParkWakeInput extends Omit<CreateAgentWakeInput, 'id' | 'createdAt'> {
  id?: string;
}

export type ParkWakeResult =
  | { ok: true; record: AgentWakeRecord }
  | { ok: false; reason: 'quota_exceeded'; used: number; limit: number };

/**
 * 默认投递：把续跑提示词发回原会话的 orchestrator。
 * 动态 import 避免 services → task/bootstrap 的循环依赖（与 cronService 同款写法）。
 */
async function defaultDeliver(record: AgentWakeRecord): Promise<void> {
  const { getTaskManager } = await import('../../task');
  const tm = getTaskManager();
  const orchestrator = tm.getOrCreateCurrentOrchestrator(record.sessionId) ?? null;
  if (!orchestrator) {
    throw new Error(`AgentOrchestrator not available for wake session ${record.sessionId}`);
  }
  // 醒来是无人值守的续跑：与 cron agent 会话同档，审批走停车挂起而不是卡死在这里。
  orchestrator.setExecutionTopology('async_agent');
  await orchestrator.sendMessage(buildWakeResumePrompt(record));
}

export class WakeService {
  private timer: NodeJS.Timeout | null = null;
  private readonly deliver: WakeDeliverFn;
  private readonly now: () => number;

  constructor(
    private readonly repo: AgentWakeRepository,
    options: { deliver?: WakeDeliverFn; now?: () => number } = {},
  ) {
    this.deliver = options.deliver ?? defaultDeliver;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 挂起一次醒来。超配额直接拒绝并把用量说清楚——模型据此换策略，
   * 而不是对着一个含糊的失败继续重试。
   */
  park(input: ParkWakeInput): ParkWakeResult {
    const used = this.repo.countBySession(input.sessionId);
    if (used >= AGENT_WAKE.MAX_PER_SESSION) {
      logger.warn('Wake rejected: session quota exceeded', { sessionId: input.sessionId, used });
      return { ok: false, reason: 'quota_exceeded', used, limit: AGENT_WAKE.MAX_PER_SESSION };
    }
    const record = this.repo.insert({
      ...input,
      // 用 uuid 而不是「时间戳+序号」：同一毫秒里两个会话各自的 used 都是 0，
      // 拼出来会撞成同一个 id，INSERT OR REPLACE 直接把前一条吃掉（单测实测踩坑）。
      id: input.id ?? `wake_${randomUUID()}`,
      createdAt: this.now(),
    });
    logger.info('Wake parked', { id: record.id, kind: record.kind, sessionId: record.sessionId });
    return { ok: true, record };
  }

  /** 启动周期检查。重启后第一次 tick 就会把过期未投递的时间型醒来补送出去。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, AGENT_WAKE.TICK_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('Wake service started', { pending: this.repo.listPending().length });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 到点的时间型醒来逐条投递。任何一条失败不阻断其余条。 */
  async tick(): Promise<number> {
    const due = this.repo.listDueTimeWakes(this.now());
    let delivered = 0;
    for (const record of due) {
      if (await this.fire(record)) delivered += 1;
    }
    return delivered;
  }

  /** 某个自动化任务跑完 —— 唤醒所有等它的会话。 */
  async onJobCompleted(jobId: string): Promise<number> {
    return this.fireAll(this.repo.listPendingByTrigger('job', jobId));
  }

  /** 某个具名事件发生 —— 唤醒所有等它的会话。 */
  async onEvent(eventName: string): Promise<number> {
    return this.fireAll(this.repo.listPendingByTrigger('event', eventName));
  }

  /** 会话被删除/放弃时把它挂着的醒来一起撤掉，别叫醒一个不存在的会话。 */
  cancelForSession(sessionId: string): number {
    return this.repo.cancelBySession(sessionId);
  }

  private async fireAll(records: AgentWakeRecord[]): Promise<number> {
    let delivered = 0;
    for (const record of records) {
      if (await this.fire(record)) delivered += 1;
    }
    return delivered;
  }

  /**
   * 幂等只靠一处：markFired 的原子 UPDATE（status='pending' 才改得动），changes=0
   * 说明这条已经被别的路径 fire 过，直接跳过。顺序不能反——先投递后标记，会在崩溃
   * 窗口里把同一次醒来送两遍。
   */
  private async fire(record: AgentWakeRecord): Promise<boolean> {
    if (this.repo.markFired(record.id, this.now()) === 0) return false;
    try {
      await this.deliver(record);
      logger.info('Wake delivered', { id: record.id, kind: record.kind, sessionId: record.sessionId });
      return true;
    } catch (err) {
      logger.warn('Wake delivery failed', { id: record.id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}

let singleton: WakeService | null = null;

export function getWakeService(): WakeService {
  if (!singleton) {
    singleton = new WakeService(getDatabase().getAgentWakeRepo());
  }
  return singleton;
}
