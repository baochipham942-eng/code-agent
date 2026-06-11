/**
 * CUA 轨迹预算上限（软停）。
 *
 * 一次 run 内的操控类动作数超过预算后，操控类工具被拒并提示模型收尾，
 * 只读观察类工具继续放行（允许最后确认状态、end_session 善后）。
 * 动机：真机 E2E 出现 35 回合 / 334 万 tokens 的失控轨迹，此前没有任何
 * 机制兜底（对照 cua-agent SDK 的 max_trajectory_budget，落在 Neo loop 层）。
 *
 * 只数操控类、不数观察类——"多看少动"正是协议鼓励的行为，不该被惩罚。
 * 计数失败的操控调用同样消耗预算：反复失败重试本身就是轨迹失控的形态。
 * 计数器由 RunFinalizer 在 run 结束时重置，临界区与 CU 锁一致（一次 run）。
 */

import { CUA_READONLY_TOOLS } from './cuaSessionLock';

/** 默认预算：一次 run 最多 25 次操控动作（对齐旧 guiAgent 的 max_steps） */
export const CUA_DEFAULT_BUDGET = 25;

const counters = new Map<string, number>();

export function getCuaBudgetLimit(): number {
  const raw = Number(process.env.CODE_AGENT_CUA_BUDGET);
  return Number.isInteger(raw) && raw > 0 ? raw : CUA_DEFAULT_BUDGET;
}

/**
 * 预算闸门。返回 null 放行；返回字符串表示超限拒绝，
 * 内容是可直接喂给模型的收尾指引（与锁的 blocked 提示同一设计语言）。
 */
export function gateCuaBudget(toolName: string, sessionId: string): string | null {
  if (CUA_READONLY_TOOLS.has(toolName)) return null;

  const limit = getCuaBudgetLimit();
  const used = counters.get(sessionId) ?? 0;
  if (used >= limit) {
    return (
      `本次任务的桌面操作轨迹预算已用尽（${limit} 次操控动作上限），该操作已拒绝。` +
      `请停止继续操作：基于当前已观察到的状态总结任务进度，明确报告已完成与未完成的部分，然后结束。` +
      `只读观察类工具（get_window_state 等）和 end_session 仍可使用，可做最后确认与善后。`
    );
  }

  counters.set(sessionId, used + 1);
  return null;
}

/** run 结束时由 RunFinalizer 调用，与 CU 锁释放同一时机。 */
export function resetCuaBudget(sessionId: string): void {
  counters.delete(sessionId);
}
