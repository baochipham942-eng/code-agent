// ============================================================================
// CLI 退出码约定 — resolveRunExitCode 映射
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  CLI_EXIT_FAILURE,
  CLI_EXIT_PARTIAL_MAX_ITERATIONS,
  CLI_EXIT_SUCCESS,
  resolveRunExitCode,
} from '../../../src/cli/exitCodes';

describe('resolveRunExitCode', () => {
  it('maps a successful run to 0', () => {
    expect(resolveRunExitCode({ success: true, output: 'done' })).toBe(CLI_EXIT_SUCCESS);
    expect(CLI_EXIT_SUCCESS).toBe(0);
  });

  it('maps a plain failure to 1', () => {
    expect(resolveRunExitCode({ success: false, error: 'boom' })).toBe(CLI_EXIT_FAILURE);
    expect(CLI_EXIT_FAILURE).toBe(1);
  });

  it('maps max-iterations partial completion to 2 (distinguishable from failure)', () => {
    const code = resolveRunExitCode({
      success: false,
      error: 'Max iterations reached',
      terminationReason: 'max_iterations',
      output: '⚠️ 已达最大执行轮次（50 轮），任务未全部完成，执行已停止。',
    });
    expect(code).toBe(CLI_EXIT_PARTIAL_MAX_ITERATIONS);
    expect(code).toBe(2);
    expect(code).not.toBe(CLI_EXIT_FAILURE);
  });
});
