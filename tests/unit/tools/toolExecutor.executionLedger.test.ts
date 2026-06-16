import { beforeEach, describe, expect, it, vi } from 'vitest';

// 验证 ADR-022 第二期接入点：工具放行后真正执行时，fail-safe 地落 begin/complete 生命周期事件。
const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(),
  appendToolExecutionBegin: vi.fn(),
  appendToolExecutionComplete: vi.fn(),
  throwOnGet: false,
}));

vi.mock('../../../src/main/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => {
    if (ledgerState.throwOnGet) throw new Error('db boom');
    return {
      appendPermissionDecision: ledgerState.appendPermissionDecision,
      appendToolExecutionBegin: ledgerState.appendToolExecutionBegin,
      appendToolExecutionComplete: ledgerState.appendToolExecutionComplete,
    };
  },
}));

import { resetDecisionHistory } from '../../../src/main/security/decisionHistory';
import { ToolExecutor } from '../../../src/main/tools/toolExecutor';

function readDef() {
  return {
    name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true, permissionLevel: 'read',
  };
}

describe('ToolExecutor → 执行生命周期事件账本 接入（第二期）', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    ledgerState.appendPermissionDecision.mockReset();
    ledgerState.appendToolExecutionBegin.mockReset();
    ledgerState.appendToolExecutionComplete.mockReset();
    ledgerState.throwOnGet = false;
  });

  it('放行执行一次工具 → 成对落 begin + complete，execution_id 一致，complete.status=success', async () => {
    resolverState.getDefinition.mockReturnValue(readDef());
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    await executor.execute('Read', { file_path: 'README.md' }, { sessionId: 's1' });

    expect(ledgerState.appendToolExecutionBegin).toHaveBeenCalledTimes(1);
    expect(ledgerState.appendToolExecutionComplete).toHaveBeenCalledTimes(1);
    const begin = ledgerState.appendToolExecutionBegin.mock.calls[0][0];
    const complete = ledgerState.appendToolExecutionComplete.mock.calls[0][0];
    expect(begin).toMatchObject({ toolName: 'Read', sessionId: 's1' });
    expect(typeof begin.executionId).toBe('string');
    expect(begin.executionId.length).toBeGreaterThan(0);
    expect(begin.params).toEqual({ file_path: 'README.md' });
    expect(typeof begin.recordedAt).toBe('number');
    // begin 与 complete 共享同一 executionId（关联键）
    expect(complete.executionId).toBe(begin.executionId);
    expect(complete.status).toBe('success');
  });

  it('begin 先于 complete 触发（崩溃发生在执行中途才能留下未闭合 begin）', async () => {
    resolverState.getDefinition.mockReturnValue(readDef());
    const order: string[] = [];
    ledgerState.appendToolExecutionBegin.mockImplementation(() => order.push('begin'));
    resolverState.execute.mockImplementation(async () => { order.push('execute'); return { success: true, result: 'ok' }; });
    ledgerState.appendToolExecutionComplete.mockImplementation(() => order.push('complete'));
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    await executor.execute('Read', { file_path: 'a' }, { sessionId: 's1' });

    expect(order).toEqual(['begin', 'execute', 'complete']);
  });

  it('工具抛异常 → 仍落 complete，status=error 且带 error 信息', async () => {
    resolverState.getDefinition.mockReturnValue(readDef());
    resolverState.execute.mockRejectedValue(new Error('disk full'));
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    const result = await executor.execute('Read', { file_path: 'a' }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    expect(ledgerState.appendToolExecutionBegin).toHaveBeenCalledTimes(1);
    expect(ledgerState.appendToolExecutionComplete).toHaveBeenCalledTimes(1);
    const complete = ledgerState.appendToolExecutionComplete.mock.calls[0][0];
    expect(complete.status).toBe('error');
    expect(complete.error).toContain('disk full');
  });

  it('工具返回 success=false 结果 → complete.status=error（执行完成但失败）', async () => {
    resolverState.getDefinition.mockReturnValue(readDef());
    resolverState.execute.mockResolvedValue({ success: false, error: 'not found' });
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    await executor.execute('Read', { file_path: 'a' }, { sessionId: 's1' });

    const complete = ledgerState.appendToolExecutionComplete.mock.calls[0][0];
    expect(complete.status).toBe('error');
  });

  it('DB 不可用（getDatabase 抛错）→ 工具执行不受影响（fail-safe）', async () => {
    ledgerState.throwOnGet = true;
    resolverState.getDefinition.mockReturnValue(readDef());
    const executor = new ToolExecutor({ requestPermission: vi.fn().mockResolvedValue(true), workingDirectory: '/tmp/workbench' });

    const result = await executor.execute('Read', { file_path: 'a' }, { sessionId: 's1' });
    expect(result.success).toBe(true);
  });
});
