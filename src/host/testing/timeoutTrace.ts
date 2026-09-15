// ============================================================================
// N-EVAL-TIMEOUT-K1-TRACE：超时那一轮的轨迹保全
// ============================================================================
// withTimeout 只是赛跑，超时抛错时原 sendMessage 还在跑，工具调用攒在 adapter 的局部
// 数组里、只在 return 带出。持有这个 promise，runner 掐掉 run 后限时等它回来。
// ============================================================================
import { withTimeout } from '../services/infra/timeoutController';
import type { AgentInterface } from './testRunner';

type AgentRound = Awaited<ReturnType<AgentInterface['sendMessage']>>;

export class InFlightRound {
  private pending?: Promise<AgentRound>;

  async race(round: Promise<AgentRound>, ms: number, message: string): Promise<AgentRound> {
    this.pending = round;
    const value = await withTimeout(round, ms, message);
    this.pending = undefined;
    return value;
  }

  /** 没有在跑的轮 ⇒ 轨迹本就完整；在跑的轮宽限期内没回来（或抛错）⇒ 不可得。 */
  async settle(graceMs: number): Promise<{ round?: AgentRound; available: boolean }> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return { available: true };
    const round = await withTimeout(pending, graceMs).catch(() => undefined);
    return { round, available: round !== undefined };
  }
}
