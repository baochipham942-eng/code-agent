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
import { getPolicyEngine, resetPolicyEngine } from '../../src/host/permissions/policyEngine';
import { getPermissionModeManager, resetPermissionModeManager } from '../../src/host/permissions/modes';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../src/host/tools/types';
import { createRunContext } from '../../src/host/runtime/runContext';

describe('ToolExecutor GuardFabric topology wiring', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resetGuardFabric();
    resetPolicyEngine();
    resetPermissionModeManager();
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

  function makeExecutor(requestPermission = vi.fn(async (_request: PermissionRequestData) => true)): ToolExecutor {
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

  it('does not add a topology approval for PascalCase Bash in async_agent; unattended profile owns the decision', async () => {
    defineBash();
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission as any);

    const result = await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: 's1', executionTopology: 'async_agent' } as any,
    );

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('native runContext 的 session identity 驱动 unattended 档，不回退 UI default', async () => {
    defineWrite();
    const sessionId = 'cron-native-run-session';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const requestPermission = vi.fn(async () => true);
    const runContext = createRunContext({
      runId: 'cron-native-run',
      sessionId,
      workspace: '/tmp/workbench',
    });
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: runContext.cwd,
      runContext,
      executionTopology: 'async_agent',
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/native.txt', content: 'hello' },
      { runId: 'cron-native-run', executionTopology: 'async_agent' },
    );

    expect(result.success).toBe(true);
    expect(classificationState.resolveToolPermissionClassification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPermissionMode: 'unattended' }),
    );
    // 本文件把 classifier mock 成固定 ask；真实 auto-approve 语义由 unattendedClamp 锁定。
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(resolverState.execute).toHaveBeenCalledOnce();
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

  it('permissions.allow 的 Tool(path) 规则在 ToolExecutor 主链真正预授权', async () => {
    defineWrite();
    getPolicyEngine().loadUserRules({ allow: ['Write(/tmp/workbench/**)'] });
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/allowed.txt', content: 'hello' },
      { sessionId: 's-user-allow' },
    );

    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledOnce();
  });

  it('permissions.ask 压过无人值守档的普通免审，仍交给有限审批终态', async () => {
    defineWrite();
    getPolicyEngine().loadUserRules({ ask: ['Write(/tmp/workbench/**)'] });
    getPermissionModeManager().markUnattendedSession('s-user-ask');
    const requestPermission = vi.fn(async (request: { forceConfirm?: boolean }) => request.forceConfirm === true);
    const executor = makeExecutor(requestPermission as any);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/ask.txt', content: 'hello' },
      { sessionId: 's-user-ask' },
    );

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({ forceConfirm: true }));
    expect(result.success).toBe(true);
  });

  it('permissions.deny 在主链先于 classifier 与审批生效', async () => {
    defineWrite();
    getPolicyEngine().loadUserRules({ deny: ['Write(/tmp/workbench/**)'] });
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission);

    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/denied.txt', content: 'hello' },
      { sessionId: 's-user-deny' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied by user permission rule');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('does not force confirmation for non-topology verdicts (sources 与主权限链重复评估，gate 只认 topology 规则)', async () => {
    defineWrite();
    const requestPermission = vi.fn(async (_request: { forceConfirm?: boolean }) => true);
    const executor = makeExecutor(requestPermission);

    // write/teammate 没有 topology 规则；sources 的 default-ask/'rules' ask 不得穿透为 forceConfirm，
    // 否则任何非 main 拓扑的每次工具调用都会被强制弹确认（2026-07-13 激活批收窄）。
    const result = await executor.execute(
      'Write',
      { file_path: '/tmp/workbench/a.txt', content: 'hello' },
      { sessionId: 's1', executionTopology: 'teammate' } as any,
    );

    expect(result.success).toBe(true);
    const permissionCalls = requestPermission.mock.calls;
    for (const [request] of permissionCalls) {
      expect(request.forceConfirm).not.toBe(true);
    }
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('setExecutionTopology 事后标注不再把 cron 的安全 Bash 强制改成 ask', async () => {
    defineBash();
    const requestPermission = vi.fn(async () => true);
    const executor = makeExecutor(requestPermission as any);

    executor.setExecutionTopology('async_agent');
    const result = await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: 's1' },
    );

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
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
