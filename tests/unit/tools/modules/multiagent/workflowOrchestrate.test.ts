// ============================================================================
// WorkflowOrchestrate (native ToolModule) Tests — Wave 3 multiagent
// Native shell only — execute body 在 legacy executeWorkflowOrchestrate
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const { executeWorkflowMock, buildLegacyCtxMock } = vi.hoisted(() => ({
  executeWorkflowMock: vi.fn(),
  buildLegacyCtxMock: vi.fn(),
}));

vi.mock('../../../../../src/host/agent/multiagentTools/workflowOrchestrate', () => ({
  executeWorkflowOrchestrate: executeWorkflowMock,
}));

vi.mock('../../../../../src/host/tools/modules/_helpers/legacyAdapter', () => ({
  buildLegacyCtxFromProtocol: (...args: unknown[]) => buildLegacyCtxMock(...args),
  adaptLegacyResult: (r: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }) =>
    r.success
      ? { ok: true, output: r.output ?? '', meta: r.metadata }
      : { ok: false, error: r.error ?? 'unknown', meta: r.metadata },
}));

import { workflowOrchestrateModule } from '../../../../../src/host/tools/modules/multiagent/workflowOrchestrate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'no' });

beforeEach(() => {
  vi.clearAllMocks();
  buildLegacyCtxMock.mockImplementation((ctx: ToolContext) => ({ workingDirectory: ctx.workingDir }));
});

describe('workflow_orchestrate schema', () => {
  it('对齐 legacy schema (含 dynamicDescription)', () => {
    expect(workflowOrchestrateModule.schema.name).toBe('workflow_orchestrate');
    expect(workflowOrchestrateModule.schema.inputSchema.required).toEqual(['workflow', 'task']);
    expect(workflowOrchestrateModule.schema.category).toBe('multiagent');
    expect(workflowOrchestrateModule.schema.permissionLevel).toBe('execute');
    expect(typeof workflowOrchestrateModule.schema.dynamicDescription).toBe('function');
  });

  it('description 含可用工作流列表（dynamic from listBuiltInWorkflows）', () => {
    const desc = workflowOrchestrateModule.schema.description;
    expect(desc).toContain('可用工作流');
  });

  it('exposes stage-level toolPolicy in custom stage schema', () => {
    const stages = workflowOrchestrateModule.schema.inputSchema.properties?.stages;
    const stageItem = stages?.items;
    const toolPolicy = stageItem?.properties?.toolPolicy;

    expect(stageItem?.properties?.maxExecutionTimeMs?.type).toBe('number');
    expect(toolPolicy?.properties?.mode?.enum).toEqual([
      'inherit',
      'none',
      'noTool',
      'readonly',
      'readOnly',
      'allowlist',
    ]);
    expect(toolPolicy?.properties?.tools?.items?.type).toBe('string');
    expect(toolPolicy?.properties?.maxToolCalls?.type).toBe('number');
  });
});

describe('workflow_orchestrate behavior', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await workflowOrchestrateModule.createHandler();
    const result = await handler.execute(
      { workflow: 'doc', task: 't' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await workflowOrchestrateModule.createHandler();
    const result = await handler.execute(
      { workflow: 'doc', task: 't' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('opaque service handle: 缺 ctx.modelConfig → NOT_INITIALIZED', async () => {
    const handler = await workflowOrchestrateModule.createHandler();
    const result = await handler.execute(
      { workflow: 'doc', task: 't' },
      makeCtx({ modelConfig: undefined }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  it('happy path 透传 args + 桥接 ctx + adapt 结果', async () => {
    executeWorkflowMock.mockResolvedValue({
      success: true,
      output: 'workflow done',
      metadata: { workflowId: 'doc-flow', stageCount: 2 },
    });
    const handler = await workflowOrchestrateModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { workflow: 'doc', task: 'process pdf', stages: [{ name: 'extract' }, { name: 'draft' }] },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('workflow done');
      expect(result.meta).toMatchObject({
        tool: 'workflow_orchestrate',
        category: 'multiagent',
        action: 'workflow',
        status: 'completed',
        targets: ['doc', 'extract', 'draft'],
        counts: { stages: 2 },
        result: { workflowId: 'doc-flow', stageCount: 2 },
        legacyMetadata: { workflowId: 'doc-flow', stageCount: 2 },
        request: {
          args: {
            workflow: 'doc',
            task: { type: 'string', length: 11, preview: 'process pdf' },
            stages: {
              type: 'array',
              length: 2,
              preview: [{ name: 'extract' }, { name: 'draft' }],
            },
          },
        },
        bridge: { protocolContext: true, legacyContext: true },
        artifactRole: 'multiagent-result',
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'workflow_orchestrate' }),
        artifacts: [expect.objectContaining({ kind: 'text', sourceTool: 'workflow_orchestrate' })],
      });
    }
    expect(executeWorkflowMock).toHaveBeenCalledWith(
      { workflow: 'doc', task: 'process pdf', stages: [{ name: 'extract' }, { name: 'draft' }] },
      expect.objectContaining({ workingDirectory: '/tmp/test' }),
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'workflow_orchestrate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('legacy failure → ok=false', async () => {
    executeWorkflowMock.mockResolvedValue({
      success: false,
      error: 'unknown workflow',
      metadata: { workflowId: 'foo-flow' },
    });
    const handler = await workflowOrchestrateModule.createHandler();
    const result = await handler.execute(
      { workflow: 'foo', task: 't' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown workflow');
      expect(result.meta).toMatchObject({
        tool: 'workflow_orchestrate',
        action: 'workflow',
        status: 'failed',
        targets: ['foo'],
        result: { workflowId: 'foo-flow' },
        legacyMetadata: { workflowId: 'foo-flow' },
        request: {
          args: {
            workflow: 'foo',
            task: { type: 'string', length: 1, preview: 't' },
          },
        },
        bridge: { protocolContext: true, legacyContext: true },
      });
    }
  });
});
