// ============================================================================
// N-EVAL-ORCHARM-REALCASE · ai-review 第 1 轮 Important
// ============================================================================
// 病：评测放行 Task 之后，子代理成了绕开 scripted 审批策略的新通道。
// 父级评测 adapter 装的是 forcePermissionHandler=true（分类器判 approve 也要落到
// handler），但 createSubagentToolRuntime 建子执行器时没继承它 ⇒ 子代理里凡是分类器
// 自动放行的工具（WebFetch 等网络只读）压根不进 context.permission.request，
// 父级策略对它们是瞎的。explore 子代理的工具面就含 WebFetch/WebSearch。
//
// 本文件走**真实** ToolExecutor（只 mock tool resolver 造一个假工具定义），
// 不是直调 handler，也不是断言构造参数。
// 反向变异锚点：摘掉 subagentToolRuntime 里 forcePermissionHandler 的透传
// （或 subagentExecutionContext / ToolContext 那两段），第一个用例立刻红。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';

/** 评测里父级装的那种 handler：策略没登记的工具一律拒（缺覆盖即拒）。 */
function scriptedDenyingParent() {
  return vi.fn(async () => false);
}

function makeRuntime(forcePermissionHandler: boolean | undefined, permissionRequest: ReturnType<typeof scriptedDenyingParent>) {
  return createSubagentToolRuntime({
    context: {
      sessionId: 'session-1',
      cwd: '/tmp/workbench',
      resolver: { getDefinition: resolverState.getDefinition },
      permission: { request: permissionRequest },
      events: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
      ...(forcePermissionHandler !== undefined ? { forcePermissionHandler } : {}),
    } as never,
    sessionId: 'session-1',
    effectiveMode: 'default',
    identity: { agentId: 'agent-1', runId: 'run-1' },
    allowedToolNames: new Set(['WebFetch']),
    checkToolExecution: vi.fn(() => true),
  });
}

describe('子代理执行器继承父级 forcePermissionHandler', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'fetched' });
    // 分类器对 NETWORK_READ_TOOLS 判 approve（permissionClassifier.ts:639），
    // 正是「装了策略却看不见」的那一类工具。
    resolverState.getDefinition.mockReturnValue({
      name: 'WebFetch',
      description: 'network read test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    });
  });

  it('父级 forcePermissionHandler=true 时，分类器自动放行的工具仍要过父级审批，且拒绝生效', async () => {
    const permissionRequest = scriptedDenyingParent();
    const { executor } = makeRuntime(true, permissionRequest);

    const result = await executor.execute('WebFetch', { url: 'https://example.com' }, { sessionId: 'session-1' });

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({ tool: 'WebFetch' }));
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('缺省（生产路径）行为零变化：分类器自动放行，不打扰父级', async () => {
    const permissionRequest = scriptedDenyingParent();
    const { executor } = makeRuntime(undefined, permissionRequest);

    const result = await executor.execute('WebFetch', { url: 'https://example.com' }, { sessionId: 'session-1' });

    expect(permissionRequest).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
