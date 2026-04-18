import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => {
  const getDefinition = vi.fn();
  const execute = vi.fn();
  return { getDefinition, execute };
});

vi.mock('../../../src/main/protocol/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

import { ToolExecutor } from '../../../src/main/tools/toolExecutor';

describe('ToolExecutor executionIntent propagation', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();

    resolverState.getDefinition.mockReturnValue({
      name: 'browser_action',
      description: 'browser action test tool',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      requiresPermission: false,
      permissionLevel: 'execute',
    });
    resolverState.execute.mockResolvedValue({
      success: true,
      output: 'ok',
    });
  });

  it('passes executionIntent into the runtime tool context', async () => {
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });
    const executionIntent = {
      browserSessionMode: 'managed' as const,
      preferBrowserSession: true,
      allowBrowserAutomation: true,
    };

    await executor.execute(
      'browser_action',
      {
        action: 'navigate',
        url: 'https://example.com',
      },
      {
        sessionId: 'session-1',
        executionIntent,
      },
    );

    expect(resolverState.execute).toHaveBeenCalledWith(
      'browser_action',
      {
        action: 'navigate',
        url: 'https://example.com',
      },
      expect.objectContaining({
        sessionId: 'session-1',
        workingDirectory: '/tmp/workbench',
        executionIntent,
      }),
    );
  });
});
