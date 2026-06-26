import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression cover for G5/G18: subagent tool calls must go through ToolExecutor,
// and the subagentPolicy gate can only tighten (allowlist + deny), never bypass.

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

describe('ToolExecutor subagentPolicy gate', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();

    resolverState.getDefinition.mockReturnValue({
      name: 'read_file',
      description: 'read file test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'read',
    });
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('rejects a tool that is not in the subagent allowlist', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('read_file', { file_path: '/tmp/x' }, {
      sessionId: 's1',
      subagentPolicy: {
        allowedTools: new Set(['some_other_tool']),
        check: () => 'ask',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed for subagent');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('rejects when the subagent policy check returns deny', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });
    const check = vi.fn().mockReturnValue('deny');

    const result = await executor.execute('read_file', { file_path: '/tmp/x' }, {
      sessionId: 's1',
      subagentPolicy: { allowedTools: new Set(['read_file']), check },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied by subagent permission policy');
    expect(check).toHaveBeenCalledWith('read_file', { file_path: '/tmp/x' });
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('proceeds through the normal pipeline when policy check returns ask', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('read_file', { file_path: '/tmp/x' }, {
      sessionId: 's1',
      subagentPolicy: { allowedTools: new Set(['read_file']), check: () => 'ask' },
    });

    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });
});
