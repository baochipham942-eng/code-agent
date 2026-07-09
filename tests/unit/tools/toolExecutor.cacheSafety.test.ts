import { beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const resolverState = vi.hoisted(() => ({
  definition: undefined as Record<string, unknown> | undefined,
  execute: vi.fn(),
}));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(),
  appendToolExecutionBegin: vi.fn(),
  appendToolExecutionComplete: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: () => resolverState.definition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendPermissionDecision: ledgerState.appendPermissionDecision,
    appendToolExecutionBegin: ledgerState.appendToolExecutionBegin,
    appendToolExecutionComplete: ledgerState.appendToolExecutionComplete,
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import { initToolCache } from '../../../src/host/services/infra/toolCache';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const SIDE_EFFECT_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'Task',
  'AgentSpawn',
  'workflow',
  'mcp_add_server',
  'unknown_side_effect',
];

function permissionLevelFor(toolName: string): 'read' | 'write' | 'execute' {
  if (['Bash', 'Task', 'AgentSpawn', 'workflow'].includes(toolName)) return 'execute';
  if (['Write', 'Edit', 'mcp_add_server', 'unknown_side_effect'].includes(toolName)) return 'write';
  return 'read';
}

describe('ToolExecutor cache safety', () => {
  beforeEach(() => {
    initToolCache({ persistentCache: false });
    resolverState.definition = undefined;
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({
      success: true,
      result: { toolCallId: 'result', success: true, output: 'executed' },
    });
    ledgerState.appendPermissionDecision.mockReset();
    ledgerState.appendToolExecutionBegin.mockReset();
    ledgerState.appendToolExecutionComplete.mockReset();
  });

  it.each(SIDE_EFFECT_TOOLS)('%s executes twice for identical repeated calls', async (toolName) => {
    resolverState.definition = {
      name: toolName,
      description: toolName,
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: permissionLevelFor(toolName),
    };
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/tool-cache-safety',
    });
    const params = toolName === 'Bash' ? { command: 'pwd' } : { value: 'same-input' };

    await executor.execute(toolName, params, { sessionId: 'session-a' });
    await executor.execute(toolName, params, { sessionId: 'session-a' });

    expect(resolverState.execute).toHaveBeenCalledTimes(2);
  });

  it('passes the current workspace and session scope to every cache lookup and write', async () => {
    const cache = initToolCache({ persistentCache: false });
    vi.spyOn(cache, 'isCacheable').mockReturnValue(true);
    const get = vi.spyOn(cache, 'get').mockReturnValue(null);
    const set = vi.spyOn(cache, 'set').mockImplementation(() => {});
    resolverState.definition = {
      name: 'PureReadFixture',
      description: 'test-only pure read fixture',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'read',
    };
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/tool-cache-safety',
    });
    const params = { value: 'same-input' };

    await executor.execute('PureReadFixture', params, { sessionId: 'session-a' });

    const scope = { sessionId: 'session-a', workingDirectory: '/tmp/tool-cache-safety' };
    expect(get).toHaveBeenCalledWith('PureReadFixture', params, scope);
    expect(set).toHaveBeenCalledWith(
      'PureReadFixture',
      params,
      { toolCallId: 'result', success: true, output: 'executed' },
      scope,
    );
  });

  it('connects successful file and workspace mutations to cache invalidation', async () => {
    const cache = initToolCache({ persistentCache: false });
    const invalidatePath = vi.spyOn(cache, 'invalidateForPath');
    const invalidateWorkspace = vi.spyOn(cache, 'invalidateForWorkspace');
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/tool-cache-safety',
    });

    resolverState.definition = {
      name: 'Write',
      description: 'Write',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'write',
    };
    await executor.execute('Write', { file_path: 'src/example.ts', content: 'value' }, {
      sessionId: 'session-a',
    });

    expect(invalidatePath).toHaveBeenCalledWith(
      join(realpathSync.native('/tmp'), 'tool-cache-safety/src/example.ts'),
      { sessionId: 'session-a', workingDirectory: '/tmp/tool-cache-safety' },
    );

    resolverState.definition = {
      name: 'Bash',
      description: 'Bash',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'execute',
    };
    await executor.execute('Bash', { command: 'pwd' }, { sessionId: 'session-a' });

    expect(invalidateWorkspace).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workingDirectory: '/tmp/tool-cache-safety',
    });
  });
});
