// ============================================================================
// dynamic-workflow 脚本运行时常量（scriptRuntime）
// ============================================================================

export const SCRIPT_RUNTIME = {
  /** 全局并发上限：一次 run 同时在途的 agent() 调用总数。provider-aware 分配见 ConcurrencyGate。 */
  GLOBAL_MAX_CONCURRENCY: 16,
  /** worker 沙箱整体执行超时（ms）：防失控脚本无限跑。 */
  WORKER_TIMEOUT_MS: 30 * 60 * 1000,
  /** worker 沙箱 old-generation 堆上限（MB）：限制不可信脚本内存。 */
  WORKER_MAX_OLD_GEN_MB: 256,
  /** 单次 run 最多 agent() 调用数：失控脚本兜底（对齐 Claude Code Workflow 的 1000 上限）。 */
  MAX_AGENT_CALLS_PER_RUN: 1000,
} as const;
