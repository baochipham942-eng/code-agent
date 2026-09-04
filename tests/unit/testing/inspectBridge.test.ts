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

  it('T1：bash-ls 期望对 Codex/Grok/Kimi/Neo 工具名同分 1.0', async () => {
    const bashLsCase: TestCase = {
      id: 'bash-ls',
      type: 'tool',
      description: 'bash 工具 - 列出目录',
      prompt: '列出当前目录的文件',
      expect: {
        tool: 'bash|list_directory|glob',
        response_contains: ['package.json'],
      },
      expectations: [
        {
          type: 'tool_output_contains',
          description: '工具输出应包含 package.json',
          weight: 1,
          critical: true,
          params: { text: ['package.json'] },
        },
        {
          type: 'tool_called',
          description: '应调用 bash、list_directory 或 glob 工具来列出目录',
          weight: 0.8,
          params: { tool: 'bash|list_directory|glob' },
        },
        {
          type: 'no_crash',
          description: '不应崩溃',
          weight: 0.5,
          params: {},
        },
        {
          type: 'max_turns',
          description: '简单任务应在 10 轮内完成',
          weight: 0.3,
          params: { max: 10 },
        },
      ],
    };

    const scores: Record<string, number> = {};
    for (const tool of ['exec_command', 'run_terminal_command', 'Bash', 'ListDirectory'] as const) {
      const result = await scoreInspectCase(bashLsCase, {
        ...context,
        toolExecutions: [{
          tool,
          input: { command: 'ls' },
          output: 'package.json\nsrc',
          success: true,
          duration: 0,
          timestamp: 0,
        }],
      });
      scores[tool] = result.score;
      expect(result.status, `${tool} status`).toBe('passed');
      expect(result.score, `${tool} score`).toBe(1);
      expect(result.legacy.passed, `${tool} legacy expect.tool`).toBe(true);
      expect(result.legacy.failures).toEqual([]);
    }

    expect(scores).toEqual({
      exec_command: 1,
      run_terminal_command: 1,
      Bash: 1,
      ListDirectory: 1,
    });
  });
});
