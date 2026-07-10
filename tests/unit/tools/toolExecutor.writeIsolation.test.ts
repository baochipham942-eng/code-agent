import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionResult } from '../../../src/host/tools/types';

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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resetWriteIsolationForTests } from '../../../src/host/security/writeIsolation';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createExecutor(): ToolExecutor {
  const executor = new ToolExecutor({
    requestPermission: async () => true,
    workingDirectory: '/tmp/code-agent-write-isolation',
  });
  executor.setAuditEnabled(false);
  return executor;
}

const canonicalWorkspace = resolveCanonicalRunPath('/tmp/code-agent-write-isolation');

function writeToolDefinition(name = 'Write') {
  return {
    name,
    description: 'write test tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: false,
    permissionLevel: 'write',
  };
}

describe('ToolExecutor write isolation', () => {
  beforeEach(() => {
    resetWriteIsolationForTests();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockReturnValue(writeToolDefinition());
  });

  afterEach(() => {
    resetWriteIsolationForTests();
  });

  it('serializes concurrent writes to the same file', async () => {
    const first = deferred<ToolExecutionResult>();
    const second = deferred<ToolExecutionResult>();
    resolverState.execute
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const executor = createExecutor();
    const firstRun = executor.execute('Write', { file_path: 'notes.md', content: 'one' }, {});
    await nextTick();
    const secondRun = executor.execute('Write', { file_path: 'notes.md', content: 'two' }, {});
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(1);

    first.resolve({ success: true, result: 'first' });
    const firstResult = await firstRun;
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(2);

    second.resolve({ success: true, result: 'second' });
    const secondResult = await secondRun;

    expect(firstResult.metadata?.writeIsolation).toMatchObject({
      kind: 'file',
      lockKey: `file:${canonicalWorkspace}/notes.md`,
    });
    expect(secondResult.metadata?.writeIsolation).toMatchObject({
      kind: 'file',
      lockKey: `file:${canonicalWorkspace}/notes.md`,
    });
  });

  it('allows concurrent writes to different files in the same workspace', async () => {
    const first = deferred<ToolExecutionResult>();
    const second = deferred<ToolExecutionResult>();
    resolverState.execute
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const executor = createExecutor();
    const firstRun = executor.execute('Write', { file_path: 'a.md', content: 'a' }, {});
    const secondRun = executor.execute('Write', { file_path: 'b.md', content: 'b' }, {});
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(2);

    first.resolve({ success: true, result: 'a' });
    second.resolve({ success: true, result: 'b' });
    await expect(firstRun).resolves.toMatchObject({ success: true });
    await expect(secondRun).resolves.toMatchObject({ success: true });
  });

  it('uses a workspace lock for shell execution', async () => {
    resolverState.getDefinition.mockImplementation((toolName: string) => {
      if (toolName === 'bash') {
        return {
          name: 'bash',
          description: 'shell test tool',
          inputSchema: { type: 'object', properties: {}, required: [] },
          requiresPermission: false,
          permissionLevel: 'execute',
        };
      }
      return writeToolDefinition();
    });

    const shellRun = deferred<ToolExecutionResult>();
    const writeRun = deferred<ToolExecutionResult>();
    resolverState.execute
      .mockImplementationOnce(() => shellRun.promise)
      .mockImplementationOnce(() => writeRun.promise);

    const executor = createExecutor();
    const firstRun = executor.execute('bash', { command: 'npm test' }, {});
    await nextTick();
    const secondRun = executor.execute('Write', { file_path: 'a.md', content: 'a' }, {});
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(1);

    shellRun.resolve({ success: true, result: 'shell' });
    await firstRun;
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(2);

    writeRun.resolve({ success: true, result: 'write' });
    await expect(secondRun).resolves.toMatchObject({ success: true });
  });

  it('does not hold a workspace lock for internal delegation tools', async () => {
    resolverState.getDefinition.mockImplementation((toolName: string) => {
      if (['Task', 'spawn_agent', 'AgentSpawn'].includes(toolName)) {
        return {
          name: toolName,
          description: 'delegation test tool',
          inputSchema: { type: 'object', properties: {}, required: [] },
          requiresPermission: false,
          permissionLevel: 'execute',
        };
      }
      return writeToolDefinition(toolName);
    });

    const delegationRun = deferred<ToolExecutionResult>();
    const writeRun = deferred<ToolExecutionResult>();
    resolverState.execute
      .mockImplementationOnce(() => delegationRun.promise)
      .mockImplementationOnce(() => writeRun.promise);

    const executor = createExecutor();
    const firstRun = executor.execute('Task', { subagent_type: 'coder', prompt: 'nested' }, {});
    await nextTick();
    const secondRun = executor.execute('Write', { file_path: 'a.md', content: 'a' }, {});
    await nextTick();

    expect(resolverState.execute).toHaveBeenCalledTimes(2);

    delegationRun.resolve({ success: true, result: 'delegated' });
    writeRun.resolve({ success: true, result: 'write' });
    const [delegationResult, writeResult] = await Promise.all([firstRun, secondRun]);

    expect(delegationResult.metadata?.writeIsolation).toBeUndefined();
    expect(writeResult.metadata?.writeIsolation).toMatchObject({
      kind: 'file',
      lockKey: `file:${canonicalWorkspace}/a.md`,
    });
  });
});
