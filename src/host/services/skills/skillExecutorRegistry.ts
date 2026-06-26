// ============================================================================
// SkillExecutorRegistry — skill 的 service 层执行扩展点（roadmap 3.2 裁决产物）
// ============================================================================
// 通用注册表：skill 可以注册一个 service 层 executor，显式触发（/name）时由
// 代码持有执行权——确定性编排器先跑完，运行报告作为上下文块回注，模型只负责
// 呈现。设计动机：跨两轮对抗审计的结论是"信代码不信模型"，硬门（频率验证、
// 字段校验、重名拒绝）必须在 service 层执行，不能依赖 prompt 自觉。
//
// 签名刻意不绑定 distill 的形状（executor: request → 报告文本），dream 等
// 既有 prompt 驱动维护流后续可迁移接入（audit 遗留清单）。
//
// 四条守护（全部在注册表层统一执行，executor 不必各自实现）：
// 1. 仅显式触发：matchKind 必须是 slash/inline-slash，alias 模糊匹配不执行
// 2. 失败降级：executor 抛错 → failed 降级报告，绝不向上抛、不打断聊天 turn
// 3. 并发互斥：同名 executor 运行中再次触发 → busy，不重复执行
// 4. 执行超时：超过 timeoutMs → timeout 降级报告，不拖死消息链路
//    （互斥槽位保留到底层 Promise 真正 settle 才释放，超时后不会双跑）
// ============================================================================

import { DISTILL } from '../../../shared/constants';
import { createLogger } from '../infra/logger';
import type { SkillInvocationMatchKind } from './skillInvocationResolver';

const logger = createLogger('SkillExecutorRegistry');

export interface SkillExecutionRequest {
  skillName: string;
  args?: string;
  workingDirectory: string;
  matchKind: SkillInvocationMatchKind;
}

/** 返回值是注入上下文块的运行报告文本 */
export type SkillExecutor = (request: SkillExecutionRequest) => Promise<string>;

export interface SkillExecutorOptions {
  timeoutMs?: number;
}

export type SkillExecutionStatus = 'completed' | 'failed' | 'timeout' | 'busy' | 'skipped-not-explicit';

export interface SkillExecutionOutcome {
  status: SkillExecutionStatus;
  report: string;
}

interface RegisteredExecutor {
  executor: SkillExecutor;
  timeoutMs: number;
}

const registry = new Map<string, RegisteredExecutor>();
const inFlight = new Set<string>();

export function registerSkillExecutor(name: string, executor: SkillExecutor, options: SkillExecutorOptions = {}): void {
  registry.set(name, {
    executor,
    timeoutMs: options.timeoutMs ?? DISTILL.EXECUTOR_TIMEOUT_MS,
  });
}

export function unregisterSkillExecutor(name: string): void {
  registry.delete(name);
  inFlight.delete(name);
}

export function hasSkillExecutor(name: string): boolean {
  return registry.has(name);
}

/**
 * 执行已注册的 executor。未注册返回 null；其余一切情况都收敛为
 * SkillExecutionOutcome（本函数承诺不抛异常）。
 */
export async function runRegisteredSkillExecutor(request: SkillExecutionRequest): Promise<SkillExecutionOutcome | null> {
  const registered = registry.get(request.skillName);
  if (!registered) return null;

  if (request.matchKind !== 'slash' && request.matchKind !== 'inline-slash') {
    return {
      status: 'skipped-not-explicit',
      report: `executor 仅在显式 /${request.skillName} 触发时执行（本次匹配方式: ${request.matchKind}）`,
    };
  }

  if (inFlight.has(request.skillName)) {
    return {
      status: 'busy',
      report: `已有一次 /${request.skillName} 在执行中，本次不重复触发。`,
    };
  }

  inFlight.add(request.skillName);
  const run = Promise.resolve()
    .then(() => registered.executor(request))
    .finally(() => {
      // 槽位在底层 Promise 真正 settle 时释放：超时后挂死的 run 不会被并发双跑
      inFlight.delete(request.skillName);
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSentinel = Symbol('skill-executor-timeout');
  try {
    const outcome = await Promise.race([
      run,
      new Promise<typeof timeoutSentinel>((resolve) => {
        timer = setTimeout(() => resolve(timeoutSentinel), registered.timeoutMs);
      }),
    ]);
    if (outcome === timeoutSentinel) {
      logger.warn('Skill executor timed out', { skill: request.skillName, timeoutMs: registered.timeoutMs });
      // 防止挂死的 run 之后 reject 变成 unhandled rejection
      run.catch(() => undefined);
      return {
        status: 'timeout',
        report: `执行超时（>${registered.timeoutMs}ms），已降级。底层任务可能仍在运行，完成前再次触发会得到 busy。`,
      };
    }
    return { status: 'completed', report: outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Skill executor failed', { skill: request.skillName, error: message });
    return {
      status: 'failed',
      report: `执行失败: ${message}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
