// ============================================================================
// N-PTCEXEC · PTC 执行侧接线（workflow 命令层 → ScriptRunHostDeps）
//
// 钉四条：默认关、开了但没有执行入口也关（fail-closed 且留痕）、
// 名单与下发侧同源并按本轮 denylist 收窄、执行方真的把调用送回 ctx.executeTool。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import type { ScriptRunSpec, ScriptRunState, ScriptRunHostDeps } from '../../../../../src/host/agent/scriptRuntime';

const ORIGINAL_FLAG = process.env.CODE_AGENT_PTC_ENABLED;

const startRunMock = vi.fn();
vi.mock('../../../../../src/host/agent/scriptRuntime', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/scriptRuntime')>();
  return { ...actual, startRun: (spec: ScriptRunSpec, deps: ScriptRunHostDeps) => startRunMock(spec, deps) };
});

vi.mock('../../../../../src/host/tools/protocolToolRegistration', async (orig) => ({
  ...(await orig<typeof import('../../../../../src/host/tools/protocolToolRegistration')>()),
  getProtocolToolSchemas: () => [
    { name: 'Read', description: 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'string' } },
    { name: 'Bash', description: 'run', inputSchema: { type: 'object' }, outputSchema: { type: 'string' } },
    // workflow 自己不进目录：既是抄 dsh 对 run_code 的处理，也断掉脚本递归起 run 的路
    { name: 'workflow', description: 'self', inputSchema: { type: 'object' }, outputSchema: { type: 'string' } },
  ],
}));

vi.mock('../../../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: vi.fn() }),
}));

vi.mock('../../../../../src/host/agent/workflowLaunchApproval', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/workflowLaunchApproval')>();
  return {
    ...actual,
    getWorkflowLaunchApprovalGate: () => ({
      requestApproval: async ({ request }: { request: unknown }) => ({ approved: true, autoApproved: true, request }),
    }),
  };
});

import { workflowModule } from '../../../../../src/host/tools/modules/multiagent/workflow';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'sess',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'k' },
    resolver: { list: () => [], has: () => false, getDefinition: () => undefined, listDefinitions: () => [], execute: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function completedState(): ScriptRunState {
  return { runId: 'x', status: 'completed', scriptHash: 'h', startedAt: 0, agentCallCount: 0, tokensSpent: 0, cacheHits: 0, phases: [], result: 'ok' };
}

async function run(ctx: ToolContext): Promise<ScriptRunHostDeps> {
  const handler = await workflowModule.createHandler();
  await handler.execute({ script: 'return 1;' }, ctx, allowAll, undefined as never);
  expect(startRunMock).toHaveBeenCalledTimes(1);
  return startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
}

beforeEach(() => {
  startRunMock.mockReset();
  startRunMock.mockResolvedValue(completedState());
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CODE_AGENT_PTC_ENABLED;
  else process.env.CODE_AGENT_PTC_ENABLED = ORIGINAL_FLAG;
});

describe('PTC 执行侧 · 通道注入', () => {
  it('默认关：不注入执行方也不给名单（child 侧 tools 是空对象）', async () => {
    delete process.env.CODE_AGENT_PTC_ENABLED;
    const deps = await run(makeCtx({ executeTool: vi.fn() } as Partial<ToolContext>));
    expect(deps.executeTool).toBeUndefined();
    expect(deps.visibleToolNames).toBeUndefined();
  });

  it('开了但本次调用没有工具执行入口 → 通道关闭且留痕，不静默', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    const logger = makeLogger();
    const deps = await run(makeCtx({ logger, executeTool: undefined }));
    expect(deps.executeTool).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('PTC 通道关闭'));
  });

  it('名单与下发侧同源：排除 workflow 自己，并按本轮 denylist 收窄', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    const deps = await run(makeCtx({ executeTool: vi.fn(), deniedToolNames: ['bash'] }));
    expect(deps.visibleToolNames).toEqual(['Read']);
  });

  it('denylist 把名单收成空 → 通道关闭且留痕（不给「有名单没得调」的半开状态）', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    const logger = makeLogger();
    const deps = await run(makeCtx({ logger, executeTool: vi.fn(), deniedToolNames: ['read', 'bash'] }));
    expect(deps.executeTool).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('PTC 通道关闭'));
  });

  it('执行方把调用原样送回 ctx.executeTool，成功/失败都转成脚本可读的结果', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ success: true, result: { text: 'hi' } })
      .mockResolvedValueOnce({ success: false, error: 'permission denied by user' });
    const deps = await run(makeCtx({ executeTool }));
    const signal = new AbortController().signal;

    await expect(deps.executeTool!({ name: 'Read', args: { path: '/a' }, signal }))
      .resolves.toEqual({ ok: true, value: { text: 'hi' } });
    expect(executeTool).toHaveBeenCalledWith('Read', { path: '/a' });

    await expect(deps.executeTool!({ name: 'Read', args: { path: '/b' }, signal }))
      .resolves.toEqual({ ok: false, error: 'permission denied by user' });
  });

  it('执行方抛错不炸穿运行时，转成 ok:false', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    const executeTool = vi.fn().mockRejectedValue(new Error('boom'));
    const deps = await run(makeCtx({ executeTool }));
    await expect(deps.executeTool!({ name: 'Read', args: {}, signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, error: 'boom' });
  });
});
