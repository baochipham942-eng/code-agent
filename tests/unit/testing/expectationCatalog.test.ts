import { describe, expect, it } from 'vitest';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';

const ALL_EXPECTATION_TYPES = [
  'file_exists', 'file_not_exists', 'content_contains', 'content_not_contains',
  'code_compiles', 'test_passes', 'output_matches', 'command_succeeds',
  'response_contains', 'response_not_contains', 'tool_called', 'tool_output_contains',
  'no_crash', 'error_handled', 'max_turns', 'min_tool_calls', 'max_tool_calls',
  'custom_script', 'html_renders', 'game_smoke', 'pptx_opens', 'sim_stop_respected',
  'sim_no_write_before_rule', 'goal_status', 'goal_evidence_gate', 'no_stall_before_artifact',
] as const;

describe('EXPECTATION_TYPE_CATALOG', () => {
  it('T7：运行时目录没有重复项且每项都有摘要', () => {
    const keys = EXPECTATION_TYPE_CATALOG.map((item) => item.type);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(ALL_EXPECTATION_TYPES);
    expect(EXPECTATION_TYPE_CATALOG.every((item) => item.summary.length > 0)).toBe(true);
  });
});
