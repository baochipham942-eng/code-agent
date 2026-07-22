import type { CreateRunContextInput, RunHandle } from '../../runtime/runContext';
import type { RunRegistry } from '../../runtime/runRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('DurableRunStart');

/**
 * 优先把本轮注册成 Durable Native Run（带 owner lease），拿不到就回落旧的同步 start()。
 *
 * 为什么需要：组队 / Agent Team 的 durable 准备**硬要求父 run 持有活跃 owner lease**
 * （prepareAgentTeamDurableController → 无租约即抛）。web 的 /api/agent 路由本来就会
 * startDurable，所以用户敲字那条链没问题；但**主机侧发起的轮**（cron 定时、角色醒来、
 * 组队主理人）走的是 orchestrator.sendMessage，此前只 start()，于是这些轮里任何起团都必失败。
 *
 * 回落是安全的：startDurable 对「本会话已有活跃 run」会抛 RunSessionConflictError
 * （web 路由已建 root 的情况），此时行为与改动前逐字一致；没配 durable kernel 时同理。
 */
export async function startRunPreferringDurable(
  registry: RunRegistry,
  input: CreateRunContextInput,
): Promise<RunHandle> {
  try {
    return await registry.startDurable(input);
  } catch (error) {
    logger.debug('Durable run start unavailable, falling back to plain run registration', {
      sessionId: input.sessionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return registry.start(input);
  }
}
