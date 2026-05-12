import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { applyToolCallArgumentDelta } from '../../../src/renderer/utils/toolCallStreaming';

describe('applyToolCallArgumentDelta', () => {
  it('accumulates raw arguments and parses them when JSON becomes complete', () => {
    const initial: ToolCall[] = [
      {
        id: 'pending_0',
        name: '',
        arguments: {},
        _streaming: true,
        _argumentsRaw: '',
      },
    ];

    const partial = applyToolCallArgumentDelta(initial, {
      index: 0,
      name: 'Bash',
      argumentsDelta: '{"command":"npm',
    });

    expect(partial[0]?.name).toBe('Bash');
    expect(partial[0]?._argumentsRaw).toBe('{"command":"npm');
    expect(partial[0]?.arguments).toEqual({});

    const complete = applyToolCallArgumentDelta(partial, {
      index: 0,
      argumentsDelta: ' test"}',
    });

    expect(complete[0]?._argumentsRaw).toBe('{"command":"npm test"}');
    expect(complete[0]?.arguments).toEqual({ command: 'npm test' });
  });

  it('lifts streaming _meta into ToolCall semantic fields', () => {
    const initial: ToolCall[] = [
      {
        id: 'pending_0',
        name: 'Read',
        arguments: {},
        _streaming: true,
        _argumentsRaw: '',
      },
    ];

    const next = applyToolCallArgumentDelta(initial, {
      index: 0,
      argumentsDelta: JSON.stringify({
        path: '/tmp/a.ts',
        _meta: {
          shortDescription: 'Read a.ts',
          expectedOutcome: 'File content is available',
          targetContext: {
            kind: 'file',
            label: 'a.ts',
          },
        },
      }),
    });

    expect(next[0]?.arguments).toEqual({ path: '/tmp/a.ts' });
    expect(next[0]?.shortDescription).toBe('Read a.ts');
    expect(next[0]?.expectedOutcome).toBe('File content is available');
    expect(next[0]?.targetContext).toEqual({ kind: 'file', label: 'a.ts' });
  });
});
