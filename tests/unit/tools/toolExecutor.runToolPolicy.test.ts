import { beforeEach, describe, expect, it, vi } from 'vitest';

// Run 级工具面执行层兜底闸（CLI --tools/--disallowed-tools）：
// 即便调用绕过 AgentLoop 的 schema 过滤 + messageProcessor 拦截
// （嵌套 PTC 调用 / 直接 executor 调用），被裁剪工具也必须硬拒且永不执行。

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
import { getDecisionHistory } from '../../../src/host/security/decisionHistory';

describe('ToolExecutor run tool policy gate (--tools/--disallowed-tools)', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();

    resolverState.getDefinition.mockReturnValue({
      name: 'Bash',
      description: 'run shell command',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'write',
    });
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('denylist 命中的工具被拒并给出清晰错误，且 handler 未执行', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Bash', { command: 'ls' }, {
      sessionId: 's1',
      deniedToolNames: ['Bash'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Tool not allowed: Bash (disabled by --tools/--disallowed-tools)');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('denylist 大小写不敏感（--disallowed-tools bash 禁掉 Bash）', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Bash', { command: 'ls' }, {
      sessionId: 's1',
      deniedToolNames: ['bash'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Tool not allowed: Bash');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('allowlist 非空时名单外工具被拒', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Bash', { command: 'ls' }, {
      sessionId: 's1',
      allowedToolNames: ['Read'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Tool not allowed: Bash (disabled by --tools/--disallowed-tools)');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('allowlist 内工具正常放行（兜底闸不误伤）', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Bash', { command: 'echo hi' }, {
      sessionId: 's1',
      allowedToolNames: ['bash'],
    });

    expect(resolverState.execute).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('无策略时行为不变（不触发兜底闸）', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Bash', { command: 'echo hi' }, {
      sessionId: 's1',
    });

    expect(resolverState.execute).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('拒绝决策写入权限账本（recordDecision 配对，policy-deny）', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });
    const before = getDecisionHistory().getAll().length;

    await executor.execute('Bash', { command: 'ls' }, {
      sessionId: 's1',
      deniedToolNames: ['Bash'],
    });

    const entries = getDecisionHistory().getAll();
    expect(entries.length).toBeGreaterThan(before);
    const latest = entries[entries.length - 1];
    expect(latest?.toolName).toBe('Bash');
    expect(latest?.outcome).toBe('policy-deny');
    expect(latest?.reason).toContain('run tool policy');
  });
});
