import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';
import { CORE_AGENT_IDS } from '../../../../src/main/agent/hybrid/coreAgents';
import { getBuiltInWorkflow, listBuiltInWorkflowIds, validateWorkflowDependencies } from '../../../../src/shared/contract/workflow';

const { executeSubagentMock } = vi.hoisted(() => ({
  executeSubagentMock: vi.fn(),
}));

vi.mock('../../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executeSubagentMock,
  }),
}));

import {
  DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS,
  executeWorkflowOrchestrate,
} from '../../../../src/main/agent/multiagentTools/workflowOrchestrate';

function makeContext(overrides: Record<string, unknown> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/test',
    requestPermission: vi.fn(async () => true),
    modelConfig: {
      provider: 'xiaomi',
      model: 'mimo-v2',
      temperature: 0.2,
    },
    ...overrides,
  } as unknown as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeWorkflowOrchestrate legacy behavior', () => {
  it('keeps every built-in workflow executable by core agents', () => {
    const validAgentIds = new Set<string>(CORE_AGENT_IDS);

    for (const workflowId of listBuiltInWorkflowIds()) {
      const workflow = getBuiltInWorkflow(workflowId);
      expect(workflow).toBeDefined();
      if (!workflow) {
        continue;
      }

      const dependencyCheck = validateWorkflowDependencies(workflow.stages);
      expect(dependencyCheck.valid, `${workflowId}: ${dependencyCheck.error ?? 'invalid dependencies'}`).toBe(true);

      for (const stage of workflow.stages) {
        expect(
          validAgentIds.has(stage.role),
          `${workflowId}:${stage.name} uses invalid role "${stage.role}"`,
        ).toBe(true);
      }
    }
  });

  it('returns useful metadata for built-in workflow execution', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'stage-ok',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'documentation-flow',
        task: 'metadata smoke',
        parallel: false,
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 stages completed');
    expect(result.metadata).toMatchObject({
      workflow: 'documentation-flow',
      workflowName: 'Documentation Flow',
      stageCount: 2,
      completedStages: 2,
      failedStages: 0,
      stages: [
        expect.objectContaining({ name: 'Architecture Analysis', role: 'plan', success: true }),
        expect.objectContaining({ name: 'Documentation', role: 'coder', success: true }),
      ],
    });
  });

  it('normalizes legacy workflow role names to core agents', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'legacy-role-ok',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'legacy role smoke',
        parallel: false,
        stages: [
          {
            name: 'Architecture Analysis',
            role: 'architect',
            prompt: 'Analyze architecture.',
          },
          {
            name: 'Documentation',
            role: 'documenter',
            prompt: 'Write docs.',
            dependsOn: ['Architecture Analysis'],
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 stages completed');
    expect(executeSubagentMock).toHaveBeenCalledTimes(2);
  });

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
      expect.objectContaining({
        name: 'Stage:smoke-plan',
        maxExecutionTimeMs: DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS,
      }),
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          provider: 'xiaomi',
          model: 'mimo-v2',
          reasoningEffort: 'high',
          thinkingBudget: 16384,
        }),
      }),
    );
  });

  it('passes parent tool identity and longer workflow timeout to stage subagents', async () => {
    const abort = new AbortController();
    const hookManager = {} as ToolContext['hookManager'];
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'parent-trace-ok',
      toolsUsed: ['Grep'],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'trace parent',
        parallel: false,
        stages: [
          {
            name: 'readonly reviewer',
            role: 'reviewer',
            prompt: 'Review only.',
            toolPolicy: { mode: 'readOnly' },
          },
        ],
      },
      makeContext({
        currentToolCallId: 'tool-workflow-1',
        abortSignal: abort.signal,
        hookManager,
      }),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        name: 'Stage:readonly reviewer',
        maxExecutionTimeMs: DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS,
      }),
      expect.objectContaining({
        parentToolUseId: 'tool-workflow-1',
        abortSignal: abort.signal,
        hookManager,
      }),
    );
    expect(result.metadata).toMatchObject({
      stages: [
        expect.objectContaining({
          name: 'readonly reviewer',
          toolsUsed: ['Grep'],
        }),
      ],
    });
  });

  it('honors explicit stage maxExecutionTimeMs', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'explicit-timeout-ok',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'timeout override',
        parallel: false,
        stages: [
          {
            name: 'deep review',
            role: 'reviewer',
            prompt: 'Review deeply.',
            maxExecutionTimeMs: 300_000,
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxExecutionTimeMs: 300_000 }),
      expect.any(Object),
    );
  });

  it('keeps workflow subagents in thinking-enabled mode for MiMo', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'thinking-on',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'cowork thinking smoke',
        parallel: false,
        stages: [
          {
            name: 'review',
            role: 'reviewer',
            prompt: 'Review with reasoning.',
            toolPolicy: { mode: 'readOnly' },
          },
        ],
      },
      makeContext({
        modelConfig: {
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          reasoningEffort: 'low',
        },
      }),
    );

    expect(result.success).toBe(true);
    const subagentContext = executeSubagentMock.mock.calls[0][2] as { modelConfig: Record<string, unknown> };
    expect(subagentContext.modelConfig).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      reasoningEffort: 'low',
      thinkingBudget: 16384,
    });
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

  it('normalizes tools: [] to a no-tool stage policy', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'pure-output',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'pure reasoning only',
        parallel: false,
        stages: [
          {
            name: 'pure-plan',
            role: 'plan',
            prompt: 'Return pure-output without tools.',
            toolPolicy: { tools: [] },
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        availableTools: [],
        maxToolCalls: 0,
      }),
      expect.any(Object),
    );
    expect(result.metadata).toMatchObject({
      stages: [
        expect.objectContaining({
          toolPolicy: expect.objectContaining({
            mode: 'none',
            requestedTools: [],
            availableTools: [],
            maxToolCalls: 0,
          }),
        }),
      ],
    });
  });

  it('filters readOnly stage policy to read permission tools', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'readonly-output',
      toolsUsed: ['Read'],
    });

    const readTools = new Set(['Glob', 'Grep', 'Read', 'ListDirectory']);
    const resolver = {
      getDefinition: vi.fn((name: string) => ({
        name,
        description: name,
        inputSchema: { type: 'object' },
        requiresPermission: false,
        permissionLevel: readTools.has(name) ? 'read' : 'write',
      })),
    };

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'read only exploration',
        parallel: false,
        stages: [
          {
            name: 'inspect',
            role: 'coder',
            prompt: 'Inspect files only.',
            toolPolicy: { mode: 'readOnly' },
          },
        ],
      },
      makeContext({ resolver }),
    );

    expect(result.success).toBe(true);
    const stageConfig = executeSubagentMock.mock.calls[0][1] as { availableTools: string[] };
    expect(stageConfig.availableTools.length).toBeGreaterThan(0);
    expect(stageConfig.availableTools).toEqual(expect.arrayContaining([
      'Glob',
      'Grep',
      'Read',
      'ListDirectory',
    ]));
    expect(stageConfig.availableTools).not.toContain('Write');
    expect(stageConfig.availableTools).not.toContain('Edit');
    expect(result.metadata).toMatchObject({
      stages: [
        expect.objectContaining({
          toolPolicy: expect.objectContaining({
            mode: 'readonly',
            availableTools: stageConfig.availableTools,
            blockedTools: expect.arrayContaining(['Bash', 'Write', 'Edit']),
          }),
        }),
      ],
    });
  });

  it('keeps allowlist inside declared role tools and reports ignored requests', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'allowlist-output',
      toolsUsed: ['Read'],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'allowlist smoke',
        parallel: false,
        stages: [
          {
            name: 'inspect',
            role: 'reviewer',
            prompt: 'Inspect one file.',
            toolPolicy: { mode: 'allowlist', tools: ['Read', 'WebSearch'] },
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        availableTools: ['Read'],
      }),
      expect.any(Object),
    );
    expect(result.metadata).toMatchObject({
      stages: [
        expect.objectContaining({
          toolPolicy: expect.objectContaining({
            mode: 'allowlist',
            requestedTools: ['Read', 'WebSearch'],
            availableTools: ['Read'],
            blockedTools: expect.arrayContaining(['WebSearch']),
          }),
        }),
      ],
    });
  });

  it('treats explicit allowlist without tools as no available tools', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: 'empty-allowlist-output',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'empty allowlist',
        parallel: false,
        stages: [
          {
            name: 'inspect',
            role: 'coder',
            prompt: 'Do not use tools.',
            toolPolicy: { mode: 'allowlist' },
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        availableTools: [],
        maxToolCalls: 0,
      }),
      expect.any(Object),
    );
    expect(result.metadata).toMatchObject({
      stages: [
        expect.objectContaining({
          toolPolicy: expect.objectContaining({
            mode: 'allowlist',
            availableTools: [],
            maxToolCalls: 0,
          }),
        }),
      ],
    });
  });
});
