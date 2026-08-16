// ============================================================================
// dynamic-workflow 脚本运行时常量（scriptRuntime）
// ============================================================================

export const SCRIPT_RUNTIME = {
  /** 全局并发上限：一次 run 同时在途的 agent() 调用总数。provider-aware 分配见 ConcurrencyGate。 */
  GLOBAL_MAX_CONCURRENCY: 16,
  /** worker 沙箱整体执行超时（ms）：防失控脚本无限跑。 */
  WORKER_TIMEOUT_MS: 30 * 60 * 1000,
  /** worker 进程组累计 CPU 时间上限（ms）：忙循环即使堵死 child 事件循环也能被 Host 终止。 */
  WORKER_CPU_TIME_LIMIT_MS: 5 * 60 * 1000,
  /** Host 轮询 worker 进程组 CPU 时间的间隔（ms）。 */
  WORKER_CPU_POLL_INTERVAL_MS: 1000,
  /** 连续读不到进程组 CPU 计时的最大次数；超过即 fail-loud，避免第二道超时静默失效。 */
  WORKER_CPU_POLL_MAX_FAILURES: 3,
  /** worker 沙箱 old-generation 堆上限（MB）：限制不可信脚本内存。 */
  WORKER_MAX_OLD_GEN_MB: 256,
  /** 外层 run_code/workflow 返回到模型上下文的 UTF-8 字节上限；中间值不套此限制。 */
  MAX_OUTER_OUTPUT_BYTES: 32 * 1024,
  /** 单次 run 最多 agent() 调用数：失控脚本兜底（对齐 Claude Code Workflow 的 1000 上限）。 */
  MAX_AGENT_CALLS_PER_RUN: 1000,
  /** 模型脚本源码体积上限（字节）：主线程在送进 worker 前 fail-fast，挡住异常大的注入。 */
  MAX_SCRIPT_BYTES: 64 * 1024,
  /** agent({schema}) 的 forced schema JSON 体积上限（字节）：防超大 schema 的 clone/请求炸弹。 */
  MAX_SCHEMA_BYTES: 16 * 1024,
  /** forced schema 嵌套深度上限：防超深结构。 */
  MAX_SCHEMA_DEPTH: 8,
} as const;
