// ============================================================================
// CLI 退出码约定 —— headless 编排（cron / 调度器 / 上层 agent）据此分支
// ============================================================================
//
// | code | 语义 |
// |------|------|
// | 0    | 正常完成 |
// | 1    | 异常失败（推理错误、内部异常、未收尾的运行时失败等） |
// | 2    | 部分完成：撞最大执行轮次上限，已产出「部分结果 + 未完成说明」收尾 |
//
// 文档同步：docs/architecture/cli.md「退出码」节。新增退出码必须同时更新这两处。

import type { CLIRunResult } from './types';

const CLI_EXIT_SUCCESS = 0;
const CLI_EXIT_FAILURE = 1;
const CLI_EXIT_PARTIAL_MAX_ITERATIONS = 2;

/** `neo run` 单次执行的退出码：部分完成（max iterations）与异常失败可区分。 */
export function resolveRunExitCode(result: CLIRunResult): number {
  if (result.success) return CLI_EXIT_SUCCESS;
  if (result.terminationReason === 'max_iterations') return CLI_EXIT_PARTIAL_MAX_ITERATIONS;
  return CLI_EXIT_FAILURE;
}
