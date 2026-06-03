// ============================================================================
// Cancellation Contract — 取消原因类型与级联策略
// ============================================================================
//
// 用途：统一 `agentLoop / subagentExecutor / parallelCoordinator / spawnGuard`
// 等多个层级的 abort reason，区分 cascade（向 child 传播）和 non-cascade
// （只影响当前 agent，兄弟不受影响）。
//
// **重要语义警示**（防止未来 PR 回归）：
//
//   `child-error`、`timeout`、`idle-timeout`、`budget-exceeded`
//   都属于 **NON_CASCADE_REASONS**。它们表示**单个 agent** 出问题，
//   不应触发 `parallelCoordinator.abortAllRunning` / `spawnGuard.cancelAll`。
//
//   反例：LangChain deepagents Issue #694 把 child-fail 路径接到 abort
//   信号上，导致"1 个 subagent 失败，全队被 cancel"——这是 bug 不是 feature。
//   Code Agent 当前路径正确（`parallelAgentCoordinator.executeTask`
//   line 465-491 只清理自己的 abortController，不调 abortAllRunning），
//   不要"修复"它。
//
//   `parallelErrorHandler` 是建议层 (advisory) — 它返回的
//   `recoveryStrategy: 'abort'` 仅是给主 agent 的"建议停止"信号，
//   是否真停由 main agent 下一轮 LLM 决策，**不直接下发 abort 信号**。
// ============================================================================

/**
 * Abort 原因枚举。沿 abort signal `reason` 字段透传。
 */
export type CancellationReason =
  | 'user-cancel' // 用户主动 ESC / Stop 按钮 / cmd palette
  | 'session-switch' // 切换 session 触发的副作用 cancel
  | 'parent-cancel' // 父 agent 被 cancel，向下 cascading
  | 'child-error' // 单个 child 抛错（兄弟不受影响，**不**触发 cascade）
  | 'timeout' // 执行时长超过 maxExecutionTimeMs（沿用 shutdownProtocol 现有语义）
  | 'idle-timeout' // N 分钟无 stream/progress（场景 D 新增）
  | 'budget-exceeded' // 超 budget 兜底（沿用现有）
  // ── swarm 护栏 P1-2 #1：把笼统的 child-error 细分成可路由的结构化失败码 ──
  // 三者都属 NON_CASCADE（单 agent 问题，不连坐兄弟）。
  | 'depth-limit' // spawn 嵌套深度超过 maxDepth（确定性，重试无意义）
  | 'child-refusal' // 子代理被拒绝执行（如 readonly 父 role 拒启 writer 子）
  | 'child-max-tokens'; // 子代理触顶自身 token/预算（已产出部分工作，可降级续跑）

/**
 * Cascade reasons — 这些 reason 应向下传播到所有 child / subagent。
 * 主 agent 收到这类 reason 时，会触发：
 *   - `spawnGuard.cancelAll(reason)`
 *   - `parallelCoordinator.abortAllRunning(reason)`
 */
export const CASCADE_REASONS: readonly CancellationReason[] = [
  'user-cancel',
  'session-switch',
  'parent-cancel',
] as const;

/**
 * Non-cascade reasons — 这些 reason 只影响**当前** agent，
 * **不** 应触发兄弟 agent 的 abort。
 *
 * 任何把 `child-error` 接到 `abortAllRunning` 的 PR 都是 regression。
 */
export const NON_CASCADE_REASONS: readonly CancellationReason[] = [
  'child-error',
  'timeout',
  'idle-timeout',
  'budget-exceeded',
  // swarm 护栏 P1-2 #1：细粒度 child 失败码同样只影响当前 agent，绝不连坐兄弟
  'depth-limit',
  'child-refusal',
  'child-max-tokens',
] as const;

/**
 * 判断给定 reason 是否应 cascade 到 child agent。
 */
export function isCascadeReason(reason: unknown): reason is CancellationReason {
  return (
    typeof reason === 'string' &&
    (CASCADE_REASONS as readonly string[]).includes(reason)
  );
}

/**
 * 类型守卫：判断给定 reason 是否是已知的 CancellationReason。
 */
export function isKnownCancellationReason(
  reason: unknown,
): reason is CancellationReason {
  return (
    typeof reason === 'string' &&
    ((CASCADE_REASONS as readonly string[]).includes(reason) ||
      (NON_CASCADE_REASONS as readonly string[]).includes(reason))
  );
}

/**
 * 将任意 reason 归一化为 CancellationReason；未知值落回 'user-cancel'
 * （保守的 cascade 策略，未知 reason 当作用户主动停）。
 */
export function normalizeCancellationReason(
  reason: unknown,
  fallback: CancellationReason = 'user-cancel',
): CancellationReason {
  return isKnownCancellationReason(reason) ? reason : fallback;
}

// ============================================================================
// 按码分治 —— 失败码消费策略（swarm 护栏 P1-2 #1）
// ============================================================================
//
// 编排层（spawnAgent 返回给主 loop / agentBridge / coordinator）拿到失败码后，
// 不再 parse error 字符串猜路由，而是查这张表决定怎么处理：
//
//   - 'retry'   瞬时故障，可原样重试（timeout / idle-timeout / child-error）
//   - 'throw'   确定性 / 终态失败，重试无意义，直接终止（depth-limit / budget /
//               用户或父级主动取消）
//   - 'surface' 上抛给编排层决策，不自动重试（child-refusal / 未知码——保守默认）
//   - 'degrade' 子代理已产出部分工作，可降级 / 截断续跑（child-max-tokens）
// ============================================================================

/** 失败码的消费策略。 */
export type FailureRouting = 'retry' | 'throw' | 'surface' | 'degrade';

/**
 * 把失败码映射到消费策略。未知 / undefined 落到 'surface'（不静默重试，交编排层决策）。
 */
export function routeFailureCode(reason: unknown): FailureRouting {
  switch (reason) {
    case 'depth-limit':
    case 'budget-exceeded':
    case 'user-cancel':
    case 'session-switch':
    case 'parent-cancel':
      return 'throw';
    case 'child-max-tokens':
      return 'degrade';
    case 'timeout':
    case 'idle-timeout':
    case 'child-error':
      return 'retry';
    case 'child-refusal':
    default:
      return 'surface';
  }
}
