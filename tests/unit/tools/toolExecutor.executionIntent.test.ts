import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('adds the Surface event projection after tool-result artifact processing', async () => {
    resolverState.execute.mockResolvedValueOnce({
      success: true,
      output: 'delivery uncertain',
      metadata: {
        surfaceSessionId: 'surface-browser-1',
        surfaceActionResultV1: { overall: 'ambiguous' },
        browserComputerProof: { evidenceRefs: [{ id: 'proof-browser-1' }] },
        artifact: { artifactId: 'artifact-browser-1' },
      },
    });
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute(
      'browser_action',
      { action: 'click', selector: '#submit' },
      {
        runId: 'run-surface-1',
        sessionId: 'conversation-surface-1',
        agentId: 'agent-surface-1',
        currentToolCallId: 'tool-call-surface-1',
      },
    );

    expect(result.metadata).toMatchObject({
      surfaceProjectionMode: 'compatibility',
      surfaceExecutionEventV1: {
        eventId: 'surface-tool:tool-call-surface-1',
        sessionId: 'surface-browser-1',
        runId: 'run-surface-1',
        agentId: 'agent-surface-1',
        status: 'ambiguous',
        evidenceRefs: ['proof-browser-1'],
        artifactRefs: ['artifact-browser-1'],
      },
    });
  });
});
