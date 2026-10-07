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
import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ToolSchema, ToolLoader } from '../../../src/host/protocol/tools';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// ADR-073 K3：静态声明域与运行时写锁域 disagree 时串行（锁照拿）并落
// resource_scope_mismatch trace；一致时无记录；resolver 故障只记 mismatch 不拦执行。
describe('ToolExecutor resource scope mismatch trace', () => {
  let trace: TurnTraceRecorder;
  let traceDir: string;

  beforeEach(() => {
    resetWriteIsolationForTests();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockReturnValue(writeToolDefinition());
    traceDir = mkdtempSync(path.join(os.tmpdir(), 'toolres-k3-trace-'));
    trace = new TurnTraceRecorder('write-isolation-test', traceDir);
  });

  afterEach(() => {
    resetWriteIsolationForTests();
  });

  afterEach(() => {
    trace.flush();
    rmSync(traceDir, { recursive: true, force: true });
  });

  function mismatchEvents() {
    return trace.getEvents().filter((event) => event.type === 'resource_scope_mismatch');
  }

  it('records exactly one mismatch when the static declaration is read-only but the runtime level is write, and still serializes', async () => {
    resolverState.getDefinition.mockReturnValue(writeToolDefinition('Read'));
    const first = deferred<ToolExecutionResult>();
    const second = deferred<ToolExecutionResult>();
    resolverState.execute
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const executor = createExecutor();
    const firstRun = executor.execute('Read', { file_path: 'notes.md', content: 'one' }, {
      turnTrace: trace, currentToolCallId: 'call-a',
    });
    await nextTick();

    // 锁照拿：第二个同文件写必须等第一个释放，绝不因静态"只读"而并行。
    const secondRun = executor.execute('Read', { file_path: 'notes.md', content: 'two' }, {
      turnTrace: trace, currentToolCallId: 'call-b',
    });
    await nextTick();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);

    first.resolve({ success: true, result: 'first' });
    await firstRun;
    await nextTick();
    expect(resolverState.execute).toHaveBeenCalledTimes(2);
    second.resolve({ success: true, result: 'second' });
    const secondResult = await secondRun;

    expect(secondResult.metadata?.writeIsolation).toMatchObject({
      kind: 'file',
      lockKey: `file:${canonicalWorkspace}/notes.md`,
    });
    const events = mismatchEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toEqual({
      toolCallId: 'call-a',
      toolName: 'Read',
      staticDomains: ['read:path'],
      runtimeLockKey: `file:${canonicalWorkspace}/notes.md`,
    });
    expect(events[1]?.data).toEqual({
      toolCallId: 'call-b',
      toolName: 'Read',
      staticDomains: ['read:path'],
      runtimeLockKey: `file:${canonicalWorkspace}/notes.md`,
    });
  });

  it('records nothing for a tool whose static declaration matches the runtime lock', async () => {
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    const executor = createExecutor();
    const result = await executor.execute('Write', { file_path: 'a.md', content: 'a' }, {
      turnTrace: trace, currentToolCallId: 'call-c',
    });
    expect(result).toMatchObject({ success: true });
    expect(result.metadata?.writeIsolation).toMatchObject({ kind: 'file' });
    expect(mismatchEvents()).toHaveLength(0);
  });

  it('records a mismatch and keeps the tool result unchanged when the resolver throws', async () => {
    const registry = getProtocolRegistry();
    const standardPort = {
      register: (schema: ToolSchema, loader: ToolLoader) => registry.register(schema, loader),
      unregister: (name: string) => registry.unregister(name),
      has: (name: string) => registry.has(name),
      getSchemas: () => registry.getSchemas(),
      resolve: (name: string) => registry.resolve(name),
    };
    setProtocolToolRegistryPort({
      ...standardPort,
      getSchemas: () => { throw new Error('registry port exploded'); },
    });
    let result: ToolExecutionResult | undefined;
    try {
      resolverState.execute.mockResolvedValue({ success: true, result: 'still-runs' });
      const executor = createExecutor();
      result = await executor.execute('Write', { file_path: 'a.md', content: 'a' }, {
        turnTrace: trace, currentToolCallId: 'call-d',
      });
    } finally {
      setProtocolToolRegistryPort(standardPort);
    }
    expect(result).toMatchObject({ success: true, result: 'still-runs' });
    expect(mismatchEvents()).toHaveLength(1);
    expect(mismatchEvents()[0]?.data).toEqual({
      toolCallId: 'call-d',
      toolName: 'Write',
      staticDomains: ['resolver-error'],
      runtimeLockKey: `file:${canonicalWorkspace}/a.md`,
    });
  });
});
