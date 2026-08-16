// ============================================================================
// N-PTCEXEC · PTC 执行侧接线（workflow 命令层 → ScriptRunHostDeps）
//
// 钉四条：默认关、开了但没有执行入口也关（fail-closed 且留痕）、
// 名单与下发侧同源并按本轮 denylist 收窄、执行方真的把调用送回 ctx.executeTool。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import type { ScriptRunSpec, ScriptRunState, ScriptRunHostDeps } from '../../../../../src/host/agent/scriptRuntime';
import { SCRIPT_RUNTIME } from '../../../../../src/shared/constants';

const ORIGINAL_FLAG = process.env.CODE_AGENT_PTC_ENABLED;

const startRunMock = vi.fn();
vi.mock('../../../../../src/host/agent/scriptRuntime', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/scriptRuntime')>();
  return { ...actual, startRun: (spec: ScriptRunSpec, deps: ScriptRunHostDeps) => startRunMock(spec, deps) };
});

vi.mock('../../../../../src/host/tools/protocolToolRegistration', async (orig) => ({
  ...(await orig<typeof import('../../../../../src/host/tools/protocolToolRegistration')>()),
  getProtocolToolSchemas: () => [
    { name: 'Read', description: 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, permissionLevel: 'read' },
    { name: 'Bash', description: 'run', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, permissionLevel: 'execute' },
    // workflow 自己不进目录：既是抄 dsh 对 run_code 的处理，也断掉脚本递归起 run 的路
    { name: 'workflow', description: 'self', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, permissionLevel: 'execute' },
  ],
}));

vi.mock('../../../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: vi.fn() }),
}));

const { launchRequests } = vi.hoisted(() => ({ launchRequests: [] as Array<{ writeHint?: boolean }> }));
vi.mock('../../../../../src/host/agent/workflowLaunchApproval', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/workflowLaunchApproval')>();
  return {
    ...actual,
    getWorkflowLaunchApprovalGate: () => ({
      requestApproval: async ({ request }: { request: { writeHint?: boolean } }) => {
        launchRequests.push(request);
        return { approved: true, autoApproved: true, request };
      },
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

async function run(ctx: ToolContext, script = 'return 1;'): Promise<ScriptRunHostDeps> {
  const handler = await workflowModule.createHandler();
  await handler.execute({ script }, ctx, allowAll, undefined as never);
  expect(startRunMock).toHaveBeenCalledTimes(1);
  return startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
}

beforeEach(() => {
  launchRequests.length = 0;
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

  it('外层 workflow 输出超过硬上限时按 UTF-8 字节安全截断并显式留痕', async () => {
    startRunMock.mockResolvedValueOnce({
      ...completedState(),
      result: '中'.repeat(SCRIPT_RUNTIME.MAX_OUTER_OUTPUT_BYTES),
    });
    const handler = await workflowModule.createHandler();
    const result = await handler.execute({ script: 'return 1;' }, makeCtx(), allowAll, undefined as never);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain('[workflow output truncated: exceeded');
    expect(Buffer.byteLength(result.output ?? '', 'utf8')).toBeLessThanOrEqual(SCRIPT_RUNTIME.MAX_OUTER_OUTPUT_BYTES);
    expect(result.output).not.toContain('\uFFFD');
  });
});

// 跑前审批闸的超时授权按 writeHint 分档（只读自动批准 / 含写自动拒绝）。
// PTC 让脚本绕过子 agent 直接写，writeHint 只看 agent({tools:'edit'}) 就成了假只读。
describe('PTC 写风险进审批预览', () => {
  it('脚本只调只读工具 → 仍判只读', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    await run(makeCtx({ executeTool: vi.fn() }), "await tools.Read({ file_path: 'a' }); return 1;");
    expect(launchRequests[0].writeHint).toBe(false);
  });

  it('脚本调了写档工具 → 判有写风险', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    await run(makeCtx({ executeTool: vi.fn() }), "await tools.Bash({ command: 'ls' }); return 1;");
    expect(launchRequests[0].writeHint).toBe(true);
  });

  it('注册表里没有的工具名 → fail-closed 判有写风险', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    await run(makeCtx({ executeTool: vi.fn() }), "await tools.NotARealTool({}); return 1;");
    expect(launchRequests[0].writeHint).toBe(true);
  });

  it('计算成员访问证不了是谁 → fail-closed 判有写风险', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    await run(makeCtx({ executeTool: vi.fn() }), "const n = pick(); await tools[n]({}); return 1;");
    expect(launchRequests[0].writeHint).toBe(true);
  });

  it('PTC 通道关着时脚本碰不到 tools，不因静态文本误报写风险', async () => {
    delete process.env.CODE_AGENT_PTC_ENABLED;
    await run(makeCtx({ executeTool: vi.fn() }), "await tools.Bash({ command: 'ls' }); return 1;");
    expect(launchRequests[0].writeHint).toBe(false);
  });
});
