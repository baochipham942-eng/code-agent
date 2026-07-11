// ============================================================================
// Workflow Output Schema Tests — GAP-016: 子代理输出端质量检查点
// stage outputSchema 校验 / 校验失败转阶段失败 / 与 GAP-004 重试组合
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentExecutionContext } from '../../../../src/host/agent/subagentExecutorTypes';

const { executeSubagentMock } = vi.hoisted(() => ({
  executeSubagentMock: vi.fn(),
}));

vi.mock('../../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: (request: { prompt: string; config: unknown; context: unknown }) =>
      executeSubagentMock(request.prompt, request.config, request.context),
  }),
}));

import { executeWorkflowOrchestrate } from '../../../../src/host/agent/multiagentTools/workflowOrchestrate';

function makeContext(overrides: Record<string, unknown> = {}): SubagentExecutionContext {
  return {
    sessionId: 'workflow-test',
    cwd: '/tmp/test',
    resolver: { getDefinition: vi.fn() },
    permission: { request: vi.fn(async () => true) },
    events: { emit: vi.fn() },
    abortSignal: new AbortController().signal,
    modelConfig: {
      provider: 'zhipu',
      model: 'glm-5',
      temperature: 0.2,
    },
    ...overrides,
  } as unknown as SubagentExecutionContext;
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string' },
  },
  required: ['findings', 'severity'],
};

const ANALYZE_STAGE = {
  name: 'Analyze',
  role: 'plan',
  prompt: 'Analyze the codebase.',
  maxRetries: 0,
  outputSchema: FINDINGS_SCHEMA,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflow stage outputSchema (GAP-016)', () => {
  it('passes validation when stage output matches the schema', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: '分析完成：\n```json\n{"findings": ["issue A", "issue B"], "severity": "high"}\n```',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'schema pass test',
        parallel: false,
        stages: [ANALYZE_STAGE],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const stages = (result.metadata as { stages: Array<{ name: string; success: boolean }> }).stages;
    expect(stages[0]).toMatchObject({ name: 'Analyze', success: true });
  });

  it('fails the stage when output is missing required schema fields', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      // 缺 severity 字段
      output: '```json\n{"findings": ["issue A"]}\n```',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'schema missing field test',
        parallel: false,
        stages: [ANALYZE_STAGE],
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('schema validation');
    expect(result.error).toContain('severity');
  });

  it('fails the stage when no JSON can be extracted from output', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: '我分析完了，发现两个问题，都不严重。',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'schema no json test',
        parallel: false,
        stages: [ANALYZE_STAGE],
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no JSON could be extracted');
  });

  it('retries the stage when schema validation fails and succeeds on valid output (GAP-004 composition)', async () => {
    executeSubagentMock
      // 第一次：缺字段 → schema 校验失败 → 触发 GAP-004 重试
      .mockResolvedValueOnce({
        success: true,
        output: '```json\n{"findings": ["issue A"]}\n```',
        toolsUsed: [],
      })
      // 重试：完整输出 → 通过
      .mockResolvedValueOnce({
        success: true,
        output: '```json\n{"findings": ["issue A"], "severity": "low"}\n```',
        toolsUsed: [],
      });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'schema retry test',
        parallel: false,
        stages: [{ ...ANALYZE_STAGE, maxRetries: 1 }],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executeSubagentMock).toHaveBeenCalledTimes(2);
  });

  it('injects the output schema requirement into the stage prompt', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: '```json\n{"findings": [], "severity": "none"}\n```',
      toolsUsed: [],
    });

    await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'schema prompt test',
        parallel: false,
        stages: [ANALYZE_STAGE],
      },
      makeContext(),
    );

    const prompt = executeSubagentMock.mock.calls[0][0] as string;
    expect(prompt).toContain('Output Schema Requirement');
    expect(prompt).toContain('"required"');
    expect(prompt).toContain('severity');
  });

  it('does not validate stages without outputSchema (backward compatible)', async () => {
    executeSubagentMock.mockResolvedValue({
      success: true,
      output: '纯文本输出，没有任何 JSON。',
      toolsUsed: [],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'no schema test',
        parallel: false,
        stages: [{ name: 'Analyze', role: 'plan', prompt: 'Analyze.', maxRetries: 0 }],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const prompt = executeSubagentMock.mock.calls[0][0] as string;
    expect(prompt).not.toContain('Output Schema Requirement');
  });

  it('passes validated structured data to downstream stages', async () => {
    executeSubagentMock
      .mockResolvedValueOnce({
        success: true,
        output: '```json\n{"findings": ["issue A"], "severity": "high"}\n```',
        toolsUsed: [],
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'Fix done.',
        toolsUsed: [],
      });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'downstream data test',
        parallel: false,
        stages: [
          ANALYZE_STAGE,
          { name: 'Fix', role: 'coder', prompt: 'Fix issues.', dependsOn: ['Analyze'], maxRetries: 0 },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    // 下游 stage 的 prompt 里能看到上游通过校验的结构化数据
    const fixPrompt = executeSubagentMock.mock.calls[1][0] as string;
    expect(fixPrompt).toContain('Structured Data (JSON)');
    expect(fixPrompt).toContain('issue A');
  });
});
