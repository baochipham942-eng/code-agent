// ============================================================================
// BudgetTracker —— dynamic-workflow 的 token 预算（P2-B）
//
// 主线程权威账本：每次 agent() 完成把 outputTokens 累加进来；agent() 发起前若已达上限就抛错。
// 单位 = outputTokens（对齐 Claude Code Workflow 的 budget.spent()）。脚本侧暴露的 budget 全局
// 是这里的只读镜像（值随 agent RPC 响应回传），enforce 由主线程做、是权威。
// total=null 表示不设预算（remaining=Infinity，永不 exceeded）。
// ============================================================================

export class BudgetTracker {
  private _spent = 0;

  constructor(public readonly total: number | null) {}

  spent(): number {
    return this._spent;
  }

  remaining(): number {
    if (this.total == null) return Infinity;
    return Math.max(0, this.total - this._spent);
  }

  /** 累加一次调用消耗的 outputTokens（非正数忽略）。 */
  add(outputTokens: number): void {
    if (outputTokens > 0) this._spent += outputTokens;
  }

  /** 是否已达/超上限（无预算永远 false）。 */
  exceeded(): boolean {
    return this.total != null && this._spent >= this.total;
  }
}
