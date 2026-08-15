import { beforeEach, describe, expect, it, vi } from 'vitest';

// N-PTCEXEC：PTC（Code Mode）执行侧的承重契约。
// 脚本里的 tools.X() 必须走回**签发本次 context 的那个 ToolExecutor 实例**的完整
// execute()——收缩档 / subagentPolicy / 审批一条不落，而不是另造一个 executor
// 或直呼 resolver。这里钉死四条：签发点、一层封顶、收缩档继承、权限档继承。

const resolverState = vi.hoisted(() => {
  const getDefinition = vi.fn();
  const execute = vi.fn();
  return { getDefinition, execute };
});

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolContext } from '../../../src/host/tools/types';

const READ_DEF = {
  name: 'read_file',
  description: 'read file test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: false,
  permissionLevel: 'read',
};

const WRITE_DEF = {
  name: 'write_file',
  description: 'write file test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: true,
  permissionLevel: 'write',
};

/** 捕获传给 resolver 的 legacy ToolContext（executeTool 就挂在它上面）。 */
function captureContexts(): ToolContext[] {
  const seen: ToolContext[] = [];
  resolverState.execute.mockImplementation(async (_name: string, _params: unknown, ctx: ToolContext) => {
    seen.push(ctx);
    return { success: true, output: 'ok' };
  });
  return seen;
}

describe('ToolExecutor 嵌套工具再入口（PTC 执行侧）', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => {
      if (name === 'write_file') return { ...WRITE_DEF, name };
      // workflow 在真注册表里是 permissionLevel:'execute'——夹具照抄真值，
      // 写成 'read' 会让写隔离那条根本不触发，测试永远绿（假绿）。
      if (name === 'workflow') return { ...READ_DEF, name, permissionLevel: 'execute' };
      return { ...READ_DEF, name };
    });
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('外层工具调用拿得到 executeTool，且它真的走完整 execute 管线', async () => {
    const contexts = captureContexts();
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });

    const outer = contexts[0];
    expect(typeof outer.executeTool).toBe('function');

    const nested = await outer.executeTool!('read_file', { file_path: '/tmp/x' });
    expect(nested.success).toBe(true);
    // 第二次进的是同一条 resolver 派发链，不是旁路
    expect(resolverState.execute).toHaveBeenCalledTimes(2);
    expect(resolverState.execute.mock.calls[1][0]).toBe('read_file');
  });

  it('一层封顶：嵌套调用自己的 context 不再签发 executeTool（防递归）', async () => {
    const contexts = captureContexts();
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });
    await contexts[0].executeTool!('read_file', { file_path: '/tmp/x' });

    expect(contexts[1].executeTool).toBeUndefined();
  });

  it('嵌套调用继承 subagentPolicy —— 名单外的工具照样被拒', async () => {
    const contexts = captureContexts();
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    await executor.execute('workflow', { script: 'noop' }, {
      sessionId: 's1',
      subagentPolicy: { allowedTools: new Set(['workflow']), check: () => 'ask' },
    });

    const denied = await contexts[0].executeTool!('read_file', { file_path: '/tmp/x' });
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('not allowed for subagent');
    // 被拒的调用不该进到 resolver
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('嵌套调用继承权限收缩档 —— readOnly 下写工具强制走审批，且拒绝即失败', async () => {
    const contexts = captureContexts();
    const requestPermission = vi.fn().mockResolvedValue(false);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
      permissionModeOverride: 'readOnly',
    });

    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });
    const result = await contexts[0].executeTool!('write_file', { file_path: '/tmp/x', content: 'y' });

    expect(requestPermission).toHaveBeenCalled();
    expect(result.success).toBe(false);
    // 写调用没被放进 resolver（只有外层 workflow 那一次）
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  // workflow 是 permissionLevel:'execute'，照 getWriteIsolationScope 的原判会握住整个
  // workspace 锁。脚本里第一个写/执行类调用就会等在父调用自己握着的锁上——死等到 run 超时。
  // 它自己一个字节都不写，正确归属是 delegation（子 agent / PTC 调用各自照常取锁）。
  it('脚本里的写调用不会卡在 workflow 自己握着的 workspace 锁上', async () => {
    resolverState.execute.mockImplementation(async (name: string, _params: unknown, ctx: ToolContext) => {
      if (name !== 'workflow') return { success: true, output: 'ok' };
      const nested = await ctx.executeTool!('write_file', { file_path: '/tmp/workbench/a.txt', content: 'x' });
      return { success: nested.success, output: 'done' };
    });
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await Promise.race([
      executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' }),
      new Promise((resolve) => setTimeout(() => resolve({ success: false, error: 'DEADLOCK' }), 3000)),
    ]) as { success: boolean; error?: string };

    expect(result.error).not.toBe('DEADLOCK');
    expect(result.success).toBe(true);
  }, 10_000);

  it('放宽档下同一次嵌套写调用不再拦人 —— 证明档位是继承来的，不是写死的', async () => {
    const contexts = captureContexts();
    const requestPermission = vi.fn().mockResolvedValue(false);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
      permissionModeOverride: 'bypassPermissions',
    });

    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });
    const result = await contexts[0].executeTool!('write_file', { file_path: '/tmp/x', content: 'y' });

    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
