import { describe, expect, it } from 'vitest';
import { buildToolErrorActions } from '../../../src/renderer/utils/toolExecutionPresentation';
import type { ToolCall } from '../../../src/shared/contract';

function toolCall(over: Partial<ToolCall>): ToolCall {
  return { id: 't1', name: 'Bash', arguments: {}, ...over };
}

describe('buildToolErrorActions', () => {
  it('hides actions for a successful tool result', () => {
    const state = buildToolErrorActions(
      toolCall({ result: { toolCallId: 't1', success: true, output: 'ok' } }),
      'msg-1',
    );
    expect(state.show).toBe(false);
    expect(state.canRetry).toBe(false);
  });

  it('shows copy + retry for a failed result with a known messageId', () => {
    const state = buildToolErrorActions(
      toolCall({ result: { toolCallId: 't1', success: false, error: 'boom: ENOENT' } }),
      'msg-1',
    );
    expect(state.show).toBe(true);
    expect(state.errorText).toBe('boom: ENOENT');
    expect(state.canRetry).toBe(true);
  });

  it('shows copy but not retry when the messageId is missing', () => {
    const state = buildToolErrorActions(
      toolCall({ result: { toolCallId: 't1', success: false, error: 'boom' } }),
      undefined,
    );
    expect(state.show).toBe(true);
    expect(state.canRetry).toBe(false);
  });

  it('falls back to string output when error text is absent', () => {
    const state = buildToolErrorActions(
      toolCall({ result: { toolCallId: 't1', success: false, output: 'stderr dump' } }),
      'msg-1',
    );
    expect(state.errorText).toBe('stderr dump');
  });

  it('treats a result with no result object as non-failing', () => {
    const state = buildToolErrorActions(toolCall({}), 'msg-1');
    expect(state.show).toBe(false);
  });
});
