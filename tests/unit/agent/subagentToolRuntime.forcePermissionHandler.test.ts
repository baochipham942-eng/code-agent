// ============================================================================
// N-EVAL-ORCHARM-REALCASE · ai-review 第 1、2 轮 Important
// ============================================================================
// 病：评测放行 Task 之后，子代理成了绕开 scripted 审批策略的新通道。
// 父级评测 adapter 装的是 forcePermissionHandler=true（分类器判 approve 也要落到
// handler），但这个契约在委派链上断过两处：
//   第 1 轮 —— createSubagentToolRuntime 建子执行器时没继承它；
//   第 2 轮 —— shadowAdapter.buildProtocolContext 逐字段抄 legacy ToolContext 时漏抄，
//              于是子代理上下文读到 undefined，第 1 轮的修等于没生效。
// 后果一样：子代理里凡是分类器自动放行的工具（WebFetch 等网络只读）压根不进
// context.permission.request，父级策略对它们是瞎的。explore 子代理工具面就含 WebFetch。
//
// 所以本文件从**宿主 legacy ToolContext** 起跑完整条真实转换链：
//   buildProtocolContext → createProtocolSubagentExecutionContext
//   → createSubagentToolRuntime → 真实 ToolExecutor.execute
// 只 mock tool resolver（造一个分类器会自动放行的假工具定义），不注入中间上下文。
// 反向变异锚点：链上任意一段的透传被摘掉（shadowAdapter / subagentExecutionContext /
// subagentToolRuntime），第一个用例立刻红。
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

import { buildProtocolContext } from '../../../src/host/tools/dispatch/shadowAdapter';
import { createProtocolSubagentExecutionContext } from '../../../src/host/agent/subagentExecutionContext';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';

/** 评测里父级装的那种 handler：策略没登记的工具一律拒（缺覆盖即拒）。 */
function scriptedDenyingParent() {
  return vi.fn(async () => false);
}

/**
 * 从宿主 legacy ToolContext 起，走真实转换链造出子代理工具执行器。
 * forcePermissionHandler 只在这一处设，之后每一跳都得自己把它带过去。
 */
function runtimeFromLegacyContext(input: {
  forcePermissionHandler?: boolean;
  requestPermission: (request: { tool: string }) => Promise<boolean>;
}) {
  const legacyCtx = {
    workingDirectory: '/tmp/workbench',
    sessionId: 'session-1',
    abortSignal: new AbortController().signal,
    requestPermission: input.requestPermission,
    modelConfig: { provider: 'mock', model: 'mock-model' },
    resolver: { getDefinition: resolverState.getDefinition },
    ...(input.forcePermissionHandler !== undefined
      ? { forcePermissionHandler: input.forcePermissionHandler }
      : {}),
  };

  const protocolCtx = buildProtocolContext({
    workingDirectory: '/tmp/workbench',
    sessionId: 'session-1',
    legacyCtx: legacyCtx as never,
  });

  const subagentCtx = createProtocolSubagentExecutionContext(
    protocolCtx,
    // 委派工具传给子代理的 canUseTool：桥回父级 requestPermission。
    (async (name: string) => (await input.requestPermission({ tool: name })) ? { allow: true } : { allow: false }) as never,
    { resolver: { getDefinition: resolverState.getDefinition } as never },
  );

  return createSubagentToolRuntime({
    context: subagentCtx,
    sessionId: 'session-1',
    effectiveMode: 'default',
    identity: { agentId: 'agent-1', runId: 'run-1' },
    allowedToolNames: new Set(['WebFetch']),
    checkToolExecution: vi.fn(() => true),
  });
}

describe('委派链原样透传父级 forcePermissionHandler', () => {
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

  it('宿主上下文 forcePermissionHandler=true 时，分类器自动放行的工具经真实转换链后仍要过父级审批', async () => {
    const requestPermission = scriptedDenyingParent();
    const { executor } = runtimeFromLegacyContext({
      forcePermissionHandler: true,
      requestPermission,
    });

    const result = await executor.execute(
      'WebFetch',
      { url: 'https://example.com' },
      { sessionId: 'session-1' },
    );

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({ tool: 'WebFetch' }));
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('缺省（生产路径）行为零变化：分类器自动放行，不打扰父级', async () => {
    const requestPermission = scriptedDenyingParent();
    const { executor } = runtimeFromLegacyContext({ requestPermission });

    const result = await executor.execute(
      'WebFetch',
      { url: 'https://example.com' },
      { sessionId: 'session-1' },
    );

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
