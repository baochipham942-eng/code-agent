// ============================================================================
// BudgetTracker —— dynamic-workflow 的 token 预算（P2-B；P2-D 加并发预留）
//
// 主线程权威账本，单位 = outputTokens（对齐 Claude Code Workflow 的 budget.spent()）。
//
// 并发硬上限（Codex audit HIGH#1）：纯「调用前查 spent、调用后加」在高扇出 parallel 下形同
// 软上限——N 个并发 agent() 看见同一旧 spent 齐过闸。这里加 reserve/commit：发起前按「已提交
// 调用的均值」预留一份 quota（exceeded 计 spent+reserved），并发调用因此能看见彼此的在途占用，
// 把溢出从「无界」收窄到「在途数 × 均值」量级。冷启动（无历史）预留 0，保证首调永不被预先挡住。
// 计费在 finally 统一 commit（成功/失败/abort 都入账，Codex HIGH#2 漏计）。
// remaining()/spent() 是「已提交」视图（worker 镜像、meta 用），不含在途预留。
// total=null 表示不设预算（remaining=Infinity，永不 exceeded）。
// ============================================================================

export class BudgetTracker {
  private _spent = 0;
  private _reserved = 0;
  private _calls = 0;

  constructor(public readonly total: number | null) {}

  spent(): number {
    return this._spent;
  }

  /** 已提交视图：不含在途预留（worker 镜像 / meta 报告用）。 */
  remaining(): number {
    if (this.total == null) return Infinity;
    return Math.max(0, this.total - this._spent);
  }

  /** 已提交调用的均值（无历史返回 0），作为下一次预留的估值。 */
  private estimate(): number {
    return this._calls > 0 ? Math.ceil(this._spent / this._calls) : 0;
  }

  /** 发起前预留一份估值 quota，返回预留量（commit 时需原样传回以释放）。 */
  reserve(): number {
    const est = this.estimate();
    this._reserved += est;
    return est;
  }

  /** 调用结束（成功/失败/abort 都要调）：释放预留并入账真实 outputTokens。 */
  commit(reservedEst: number, outputTokens: number): void {
    this._reserved = Math.max(0, this._reserved - reservedEst);
    if (outputTokens > 0) this._spent += outputTokens;
    this._calls++;
  }

  /** 直接入账（无预留路径 / 测试用）：等价于 commit(0, n)。 */
  add(outputTokens: number): void {
    this.commit(0, outputTokens);
  }

  /** 是否已达/超上限——计入在途预留，让并发调用看见彼此（无预算永远 false）。 */
  exceeded(): boolean {
    return this.total != null && this._spent + this._reserved >= this.total;
  }
}
