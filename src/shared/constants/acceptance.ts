/**
 * Acceptance script defaults — Best-of-N + repair-loop hard cap + monotonicity gate.
 *
 * 背景：v8 platformer acceptance 17 轮（v10–v26）盲改踩坑。同一 prompt 在 v11/v18 PASS、
 * 其他轮 fail，是概率性失败被当 deterministic bug 修。Audit 详见
 * 内部文档 §7。
 *
 * 这里是 acceptance 脚本的硬上限，env 可覆盖（CLI flag 优先级最高）。
 */
export const ACCEPTANCE_DEFAULTS = {
  /** Best-of-N 采样默认 N — 生成 N 份候选，validator 打分挑最好的（execution-filter） */
  BON_N: 3,
  /** Repair 循环硬上限 — 超过这个数立即 escalate，不再盲修 */
  REPAIR_CAP: 2,
  /** 单候选 generate→validate 的兜底超时（ms） */
  CANDIDATE_GENERATION_TIMEOUT_MS: 120_000,
  /** 单候选 runtime smoke 超时（ms） */
  CANDIDATE_RUNTIME_TIMEOUT_MS: 10_000,
  /** Browser visual smoke 超时下限（ms）— 与 runtime 取 max */
  CANDIDATE_BROWSER_TIMEOUT_MS: 10_000,
} as const;

/**
 * Monotonicity gate 模式：
 * - 'warn'：第 N 轮 PASS 数 < 第 N-1 轮 → 日志告警，丢弃这一轮 prompt change，用上一轮重试
 * - 'strict'：检测到退化立即 hard fail
 */
export type AcceptanceMonotonicMode = 'warn' | 'strict';
