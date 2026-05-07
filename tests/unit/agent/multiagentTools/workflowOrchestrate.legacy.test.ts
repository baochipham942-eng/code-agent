import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';

const { executeSubagentMock } = vi.hoisted(() => ({
  executeSubagentMock: vi.fn(),
}));

vi.mock('../../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executeSubagentMock,
  }),
}));

import { executeWorkflowOrchestrate } from '../../../../src/main/agent/multiagentTools/workflowOrchestrate';

function makeContext(): ToolContext {
  return {
    workingDirectory: '/tmp/test',
    requestPermission: vi.fn(async () => true),
    modelConfig: {
      provider: 'xiaomi',
      model: 'mimo-v2',
      temperature: 0.2,
    },
  } as unknown as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeWorkflowOrchestrate legacy behavior', () => {
  it('inherits the active provider model when a stage tier is provider-incompatible', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'ui-smoke-workflow-ok',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'workflow smoke',
        parallel: false,
        stages: [
          {
            name: 'smoke-plan',
            role: 'plan',
            prompt: 'Return ui-smoke-workflow-ok.',
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.stringContaining('Return ui-smoke-workflow-ok.'),
      expect.objectContaining({ name: 'Stage:smoke-plan' }),
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          provider: 'xiaomi',
          model: 'mimo-v2',
        }),
      }),
    );
  });

  it('returns the failing stage reason instead of a generic workflow failure', async () => {
    executeSubagentMock.mockResolvedValue({
      success: false,
      output: '',
      error: 'Xiaomi: 请求格式错误 (400) — Not supported model sonnet',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'workflow smoke',
        parallel: false,
        stages: [
          {
            name: 'smoke-plan',
            role: 'plan',
            prompt: 'Return ui-smoke-workflow-ok.',
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('smoke-plan (plan)');
    expect(result.error).toContain('Not supported model sonnet');
    expect(result.output).toContain('1 stages completed');
  });
});
