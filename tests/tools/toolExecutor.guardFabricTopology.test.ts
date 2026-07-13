import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const classificationState = vi.hoisted(() => ({
  resolveToolPermissionClassification: vi.fn(),
}));

vi.mock('../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../src/host/tools/toolPermissionClassification', async () => {
  const actual = await vi.importActual<typeof import('../../src/host/tools/toolPermissionClassification')>(
    '../../src/host/tools/toolPermissionClassification',
  );
  return {
    ...actual,
    resolveToolPermissionClassification: classificationState.resolveToolPermissionClassification,
  };
});

vi.mock('../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../src/host/services/infra/logger', () => ({
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

import { resetDecisionHistory, getDecisionHistory } from '../../src/host/security/decisionHistory';
import { getGuardFabric, resetGuardFabric } from '../../src/host/permissions';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';

describe('ToolExecutor GuardFabric topology wiring', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resetGuardFabric();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    classificationState.resolveToolPermissionClassification.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
    classificationState.resolveToolPermissionClassification.mockResolvedValue({
      decision: 'ask',
      reason: 'test classifier ask',
      confidence: 0.5,
      cached: false,
      traceStep: {
        layer: 'permission_classifier',
        rule: 'test-ask',
        result: 'ask',
        reason: 'test classifier ask',
        durationMs: 0,
        timestamp: Date.now(),
      },
    });
  });

  function makeExecutor(requestPermission = vi.fn(async () => true)): ToolExecutor {
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function defineBash(): void {
    resolverState.getDefinition.mockImplementation((name: string) => {
      if (name !== 'Bash' && name !== 'bash') return undefined;
      return {
        name: 'Bash',
        description: 'Execute shell command',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
        requiresPermission: true,
        permissionLevel: 'execute',
      };
    });
  }

  function defineWrite(): void {
    resolverState.getDefinition.mockImplementation((name: string) => {
      if (name !== 'Write' && name !== 'write') return undefined;
      return {
        name: 'Write',
        description: 'Write file',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['file_path', 'content'],
        },
        requiresPermission: true,
        permissionLevel: 'write',
      };
    });
  }

  function defineAgentSpawn(): void {
    resolverState.getDefinition.mockImplementation((name: string) => {
      if (name !== 'AgentSpawn' && name !== 'spawn_agent') return undefined;
      return {
        name: 'AgentSpawn',
        description: 'Spawn teammate agent',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
          },
          required: ['prompt'],
        },
        requiresPermission: true,
        permissionLevel: 'execute',
      };
    });
  }

  it('denies PascalCase Bash in async_agent topology before requestPermission', async () => {
    defineBash();
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: 's1', executionTopology: 'async_agent' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('topology rule');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();

    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'Bash',
      outcome: 'policy-deny',
      reason: expect.stringContaining('async_agent'),
    });
    expect(entry.decisionTrace).toMatchObject({
      finalOutcome: 'deny',
      steps: [
        expect.objectContaining({
          layer: 'guard_fabric',
          rule: 'topology: bash/async_agent',
          result: 'deny',
        }),
      ],
    });
  });

  it('denies AgentSpawn in teammate topology before requestPermission', async () => {
    defineAgentSpawn();
    getGuardFabric().removeSource('rules');
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'AgentSpawn',
      { prompt: 'start another teammate' },
      { sessionId: 's1', executionTopology: 'teammate' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('topology rule');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();

    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'AgentSpawn',
      outcome: 'policy-deny',
      reason: expect.stringContaining('teammate'),
    });
    expect(entry.decisionTrace).toMatchObject({
      finalOutcome: 'deny',
      steps: [
        expect.objectContaining({
          layer: 'guard_fabric',
          rule: 'topology: spawn_agent/teammate',
          result: 'deny',
        }),
      ],
    });
  });

  it('leaves default-main Bash safe-command behavior unchanged without explicit topology', async () => {
    defineBash();
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute('Bash', { command: 'git status' }, { sessionId: 's1' });

    expect(result).toMatchObject({ success: true, output: 'ok' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('leaves default-main Write approval behavior unchanged without explicit topology', async () => {
    defineWrite();
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/a.txt', content: 'hello' },
      { sessionId: 's1' },
    );

    expect(result).toMatchObject({ success: true, output: 'ok' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('forces explicit confirmation for GuardFabric ask in teammate topology', async () => {
    defineWrite();
    getGuardFabric().removeSource('rules');
    const requestPermission = vi.fn(async (request) => request.forceConfirm !== true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/a.txt', content: 'hello' },
      { sessionId: 's1', executionTopology: 'teammate' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied by user');
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'Write',
      forceConfirm: true,
    }));
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('skips GuardFabric evaluation and keeps the existing chain in main topology', async () => {
    defineBash();
    const evaluate = vi.spyOn(getGuardFabric(), 'evaluate').mockImplementation(() => {
      throw new Error('guard boom');
    });
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute('Bash', { command: 'git status' }, { sessionId: 's1' });

    expect(result).toMatchObject({ success: true, output: 'ok' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when GuardFabric fails in async_agent topology', async () => {
    defineBash();
    vi.spyOn(getGuardFabric(), 'evaluate').mockImplementation(() => {
      throw new Error('guard boom');
    });
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: 's1', executionTopology: 'async_agent' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('GuardFabric evaluation failed');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
