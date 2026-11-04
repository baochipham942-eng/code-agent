import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../../../../src/shared/contract';
import {
  classifyToolAttemptOutcome,
  toolAttemptOutcomeWord,
} from '../../../../src/host/agent/runtime/toolAttemptTrace';

function result(over: Partial<ToolResult> = {}): ToolResult {
  return {
    toolCallId: 'call-1',
    success: false,
    ...over,
    metadata: over.metadata,
  };
}

describe('classifyToolAttemptOutcome', () => {
  it('uses the same outcome order and Chinese words as toolAttemptTrace.finish', () => {
    expect(classifyToolAttemptOutcome(result({ success: true, metadata: { cancelledByRun: true } }), true)).toBe('cancelled');
    expect(classifyToolAttemptOutcome(result({ success: true, metadata: { skipped: true } }), true)).toBe('skipped');
    expect(classifyToolAttemptOutcome(result({ success: true, metadata: { autoLoaded: true } }), false)).toBe('skipped');
    expect(classifyToolAttemptOutcome(result({ success: true }), false)).toBe('succeeded');
    expect(classifyToolAttemptOutcome(result({ success: false }), false)).toBe('rejected');
    expect(classifyToolAttemptOutcome(result({ success: false, metadata: { permissionDecision: 'deny' } }), true)).toBe('rejected');
    expect(classifyToolAttemptOutcome(result({ success: false, metadata: { blocked: true } }), true)).toBe('rejected');
    expect(classifyToolAttemptOutcome(result({ success: false, metadata: { code: 'PERMISSION_DENIED_PATH' } }), true)).toBe('rejected');
    expect(classifyToolAttemptOutcome(result({ success: false, error: 'exit 1' }), true)).toBe('failed');

    expect(toolAttemptOutcomeWord('succeeded')).toBe('成功');
    expect(toolAttemptOutcomeWord('rejected')).toBe('拒绝');
    expect(toolAttemptOutcomeWord('failed')).toBe('失败');
    expect(toolAttemptOutcomeWord('cancelled')).toBe('取消');
    expect(toolAttemptOutcomeWord('skipped')).toBe('跳过');
  });
});
