// ============================================================================
// N-EVAL-TIMEOUT-K1-TRACE：超时那一轮的轨迹保全
// ============================================================================
// withTimeout 只是赛跑，超时抛错时原 sendMessage 还在跑，工具调用攒在 adapter 的局部
// 数组里、只在 return 带出。持有这个 promise，runner 掐掉 run 后限时等它回来。
// ============================================================================
import { withTimeout } from '../services/infra/timeoutController';
import type { AgentInterface } from './testRunner';
import type { TestResult } from './types';

type AgentRound = Awaited<ReturnType<AgentInterface['sendMessage']>>;

/**
 * 把模拟用户轮 / follow-up 轮的结果并进 TestResult。审批记录必须一起并：
 * 「先确认」类题的危险命令发生在第二轮，只取首轮会把真弹过的审批卡数成 0
 * （09-04 L3 第八程：3 条命令只数到 2 条、产品会弹卡 0 次）。没有记录就不建数组。
 */
export function appendRound(result: TestResult, round: Pick<TestResult, 'responses' | 'toolExecutions' | 'turnCount' | 'errors' | 'permissionRequests'>): void {
  result.responses.push(...round.responses);
  result.toolExecutions.push(...round.toolExecutions);
  if (round.permissionRequests) (result.permissionRequests ??= []).push(...round.permissionRequests);
  result.turnCount += round.turnCount;
  result.errors.push(...round.errors);
}

export class InFlightRound {
  private pending?: Promise<AgentRound>;

  async race(round: Promise<AgentRound>, ms: number, message: string): Promise<AgentRound> {
    this.pending = round;
    const value = await withTimeout(round, ms, message);
    this.pending = undefined;
    return value;
  }

  /**
   * 超时掐掉 run 后调用：在跑的轮宽限期内回来就并入 result。
   * 返回轨迹是否完整——没有在跑的轮 ⇒ true；等不到（或抛错）⇒ false，result 保持现状。
   */
  async settleInto(result: TestResult, graceMs: number): Promise<boolean> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return true;
    const round = await withTimeout(pending, graceMs).catch(() => undefined);
    if (round) appendRound(result, round);
    return round !== undefined;
  }
}
