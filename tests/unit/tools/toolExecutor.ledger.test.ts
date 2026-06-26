import { beforeEach, describe, expect, it, vi } from 'vitest';

// 验证 ADR-022 第一期接入点：recordDecision 在内存缓冲之外，还 fail-safe 地把决策追加到事件账本。
const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(),
  throwOnGet: false,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 关键：mock databaseService，让 getDatabase() 返回可观测的账本桩
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (ledgerState.throwOnGet) throw new Error('db boom');
    return { appendPermissionDecision: ledgerState.appendPermissionDecision };
  },
}));

import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

describe('ToolExecutor → 权限决策事件账本 接入', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    ledgerState.appendPermissionDecision.mockReset();
    ledgerState.throwOnGet = false;
  });

  it('auto-approve 决策 → 落账本，finalOutcome=allow 且带 trace', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true, permissionLevel: 'read',
    });
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    await executor.execute('Read', { file_path: 'README.md' }, { sessionId: 's1' });

    expect(ledgerState.appendPermissionDecision).toHaveBeenCalled();
    const arg = ledgerState.appendPermissionDecision.mock.calls.at(-1)?.[0];
    expect(arg).toMatchObject({
      toolName: 'Read',
      finalOutcome: 'allow',
      historyOutcome: 'auto-approve',
    });
    expect(typeof arg.recordedAt).toBe('number');
    expect(typeof arg.durationMs).toBe('number');
    expect(arg.trace?.finalOutcome).toBe('allow');
  });

  it('deny 决策（危险命令）→ 落账本，finalOutcome=deny 且带 trace', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'bash', description: 'shell', inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true, permissionLevel: 'execute',
    });
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    const result = await executor.execute('bash', { command: 'rm -rf *' }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    const denyCall = ledgerState.appendPermissionDecision.mock.calls
      .map((c) => c[0])
      .find((a) => a.finalOutcome === 'deny');
    expect(denyCall).toBeTruthy();
    expect(denyCall).toMatchObject({ toolName: 'bash', finalOutcome: 'deny' });
    expect(denyCall.trace?.finalOutcome).toBe('deny');
  });

  it('账本/DB 不可用（getDatabase 抛错）→ 工具执行不受影响（fail-safe）', async () => {
    ledgerState.throwOnGet = true; // 模拟 db 层异常
    resolverState.getDefinition.mockReturnValue({
      name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true, permissionLevel: 'read',
    });
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    // 不应抛异常，且工具正常返回成功
    const result = await executor.execute('Read', { file_path: 'README.md' }, { sessionId: 's1' });
    expect(result.success).toBe(true);
  });
});
