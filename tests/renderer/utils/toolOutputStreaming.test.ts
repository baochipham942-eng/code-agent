import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { applyToolOutputDelta } from '../../../src/renderer/utils/toolOutputStreaming';

describe('applyToolOutputDelta', () => {
  it('appends stdout and stderr deltas to a pending tool call without marking it complete', () => {
    const initial: ToolCall[] = [
      {
        id: 'tool-1',
        name: 'Bash',
        arguments: { command: 'npm test' },
      },
    ];

    const withStdout = applyToolOutputDelta(initial, {
      toolCallId: 'tool-1',
      toolName: 'Bash',
      stream: 'stdout',
      content: 'running\n',
    }, 1000);
    const withStderr = applyToolOutputDelta(withStdout, {
      toolCallId: 'tool-1',
      toolName: 'Bash',
      stream: 'stderr',
      content: 'warn\n',
    }, 1100);

    expect(withStderr[0]?.result).toBeUndefined();
    expect(withStderr[0]?.liveOutput).toMatchObject({
      stdout: 'running\n',
      stderr: 'warn\n',
      updatedAt: 1100,
    });
  });

  it('ignores deltas for other tool calls', () => {
    const initial: ToolCall[] = [
      {
        id: 'tool-1',
        name: 'Bash',
        arguments: {},
      },
    ];

    const next = applyToolOutputDelta(initial, {
      toolCallId: 'tool-2',
      toolName: 'Bash',
      stream: 'stdout',
      content: 'other',
    });

    expect(next).toEqual(initial);
  });
});
