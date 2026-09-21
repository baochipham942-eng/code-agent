// ============================================================================
// 工具熔断器常量 — 熔断计数只认基础设施类失败
// ============================================================================
//
// 错误分类真源是 telemetry 的 ErrorCategory + classifyError
//（src/host/telemetry/telemetryCollectorInternal.ts），不另造平行分类。
// 这里只挑「计入熔断计数」的基础设施子集：网络 / 数据库 / 5xx / 依赖与进程资源类。
// 业务可预期失败（命令非零退出、工具参数校验失败、断言失败、文件不存在等）
// 不计入熔断计数，照常回喂模型自行修正。

import type { ErrorCategory } from '../contract/telemetry';

export const TOOL_CIRCUIT_BREAKER = {
  /** 连续基础设施类失败达到此次数即熔断 */
  MAX_CONSECUTIVE_FAILURES: 5,
  /**
   * 计入熔断计数的基础设施类错误分类（classifyError 的输出）。
   * 不在表内的分类（command_failure / tool_args_validation / file_not_found /
   * syntax_error / edit_not_unique / path_hallucination / permission_denied /
   * http_4xx / sandbox_denied / unknown）一律视为业务失败，不影响计数。
   */
  TRIPPABLE_ERROR_CATEGORIES: [
    'timeout',
    'network_error',
    'http_5xx',
    'rate_limit',
    'database_error',
    'dependency_missing',
    'auth_failed',
    'context_overflow',
  ] as const satisfies readonly ErrorCategory[],
} as const;
