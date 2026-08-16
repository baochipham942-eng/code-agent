import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreInspectCase } from '../../../scripts/inspect/inspectBridge';
import type { TestCase } from '../../../src/host/testing/types';

const context = {
  toolExecutions: [{
    tool: 'Bash',
    input: { command: 'ls' },
    output: 'package.json\nsrc',
    success: true,
    duration: 0,
    timestamp: 0,
  }],
  responses: ['package.json is present'],
  errors: [],
  turnCount: 2,
  workingDirectory: path.resolve('.'),
};

describe('Inspect assertion scorer bridge', () => {
  it('uses P1 expectations as the final score, matching TestRunner precedence', async () => {
    const testCase: TestCase = {
      id: 'inspect-score',
      type: 'tool',
      description: 'score adapter',
      prompt: 'list files',
      expect: { response_contains: ['missing legacy text'] },
      expectations: [
        {
          type: 'tool_output_contains',
          description: 'tool output includes package.json',
          params: { text: 'package.json' },
          weight: 1,
        },
        {
          type: 'no_crash',
          description: 'agent does not crash',
          params: {},
          weight: 1,
          critical: true,
        },
      ],
    };

    const result = await scoreInspectCase(testCase, context);

    expect(result.legacy.passed).toBe(false);
    expect(result.status).toBe('passed');
    expect(result.score).toBe(1);
  });

  it('preserves critical expectation failure semantics', async () => {
    const testCase: TestCase = {
      id: 'inspect-critical',
      type: 'tool',
      description: 'critical score adapter',
      prompt: 'list files',
      expect: {},
      expectations: [
        {
          type: 'response_contains',
          description: 'required response text',
          params: { text: 'absent' },
          weight: 1,
          critical: true,
        },
        {
          type: 'no_crash',
          description: 'agent does not crash',
          params: {},
          weight: 1,
        },
      ],
    };

    const result = await scoreInspectCase(testCase, context);

    expect(result.status).toBe('failed');
    expect(result.score).toBe(0);
    expect(result.hasCriticalFailure).toBe(true);
  });
});
