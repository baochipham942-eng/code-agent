import { beforeEach, describe, expect, it, vi } from 'vitest';

// N-SANDBOX-ESCALATE-APPROVAL-LEDGER：工具体内 ask（canUseTool 内联审批，如 bash 的
// sandbox_escalate_once）也要落权限账本——外层 ask 由权限闸记账（#1664），内层此前是空白，
// 事后没人说得清一次沙箱扩权是谁批的。这里从 executor.execute → context.requestPermission
// 整条真链路验证：每条内层 ask 恰好一条账本行，批准来源区分真人/机器，deniedPath 随 trace 落库。
const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(),
  appendToolExecutionBegin: vi.fn(),
  appendToolExecutionComplete: vi.fn(),
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

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendPermissionDecision: ledgerState.appendPermissionDecision,
    appendToolExecutionBegin: ledgerState.appendToolExecutionBegin,
    appendToolExecutionComplete: ledgerState.appendToolExecutionComplete,
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolContext } from '../../../src/host/tools/types';

/** 复刻 bash.ts 沙盒扩权 ask 经 shadowAdapter 翻译后到达 context.requestPermission 的形状。 */
const SANDBOX_ESCALATE_REQUEST = {
  type: 'command',
  tool: 'bash',
  forceConfirm: true,
  dangerLevel: 'warning',
  reason: '沙盒拦截了这一步：它想写入文件 /tmp/denied-target.txt。允许仅这一次写入这个文件并重跑？',
  details: {
    command: 'printf x > /tmp/denied-target.txt',
    deniedPath: '/tmp/denied-target.txt',
    action: 'sandbox_escalate_once',
  },
} as const;

/** 工具体：发起一次内层 ask，并把拿到的布尔结果原样带回，供断言窄契约没变。 */
function toolBodyAsksOnce(resultRef: { approved?: unknown }) {
  return async (_name: string, _params: unknown, context: ToolContext) => {
    resultRef.approved = await context.requestPermission(SANDBOX_ESCALATE_REQUEST);
    return { success: true, result: 'inner-ask-done' };
  };
}

describe('ToolExecutor 工具体内 ask → 权限账本（N-SANDBOX-ESCALATE-APPROVAL-LEDGER）', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    ledgerState.appendPermissionDecision.mockReset();
    ledgerState.appendToolExecutionBegin.mockReset();
    ledgerState.appendToolExecutionComplete.mockReset();
    // requiresPermission: false → 外层权限闸不参与，账本行只能来自内层 ask 的包装器。
    resolverState.getDefinition.mockReturnValue({
      name: 'probe_tool',
      description: 'inner ask probe',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'read',
    });
  });

  function innerAskRows(): Array<Record<string, unknown>> {
    return ledgerState.appendPermissionDecision.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.historyOutcome === 'ask-approved' || entry.historyOutcome === 'ask-denied');
  }

  it.each([
    ['机器来源 dev-auto-approve（devModeAutoApprove 放行）', { approved: true, approvalSource: 'dev-auto-approve' } as const],
    ['真人来源 user（审批卡上点了允许）', { approved: true, approvalSource: 'user' } as const],
  ])('内层批准落一条账：%s；trace 带 deniedPath/action，工具拿到 boolean true', async (_label, askResult) => {
    const seen: { approved?: unknown } = {};
    resolverState.execute.mockImplementation(toolBodyAsksOnce(seen));
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(askResult),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('probe_tool', {}, {
      sessionId: 'session-inner-ask-approve',
      currentToolCallId: 'call-inner-ask-approve',
    });

    expect(result.success).toBe(true);
    expect(seen.approved).toBe(true);
    expect(innerAskRows()).toHaveLength(1);
    expect(innerAskRows()[0]).toMatchObject({
      sessionId: 'session-inner-ask-approve',
      origin: 'desktop',
      toolName: 'bash',
      finalOutcome: 'allow',
      historyOutcome: 'ask-approved',
      reason: askResult.approvalSource,
      summary: 'printf x > /tmp/denied-target.txt',
    });
    const step = (innerAskRows()[0].trace as { steps: Array<Record<string, unknown>> }).steps[0];
    expect(step).toMatchObject({ layer: 'plan_approval', rule: 'sandbox_escalate_once', result: 'allow' });
    expect(step.reason).toMatchObject({
      metadata: { deniedPath: '/tmp/denied-target.txt', action: 'sandbox_escalate_once' },
    });
  });

  it('裸 boolean 批准：来源不自报 → 记 unspecified，不冒名 user', async () => {
    const seen: { approved?: unknown } = {};
    resolverState.execute.mockImplementation(toolBodyAsksOnce(seen));
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/workbench',
    });

    await executor.execute('probe_tool', {}, { sessionId: 'session-inner-ask-bare-true' });

    expect(innerAskRows()).toHaveLength(1);
    expect(innerAskRows()[0]).toMatchObject({ historyOutcome: 'ask-approved', reason: 'unspecified' });
  });

  it('内层拒绝落一条账：denialSource 进 reason，finalOutcome=deny，工具拿到 boolean false', async () => {
    const seen: { approved?: unknown } = {};
    resolverState.execute.mockImplementation(toolBodyAsksOnce(seen));
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue({ approved: false, denialSource: 'timeout' }),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('probe_tool', {}, {
      sessionId: 'session-inner-ask-deny',
      currentToolCallId: 'call-inner-ask-deny',
    });

    expect(seen.approved).toBe(false);
    expect(result.success).toBe(true);
    expect(innerAskRows()).toHaveLength(1);
    expect(innerAskRows()[0]).toMatchObject({
      sessionId: 'session-inner-ask-deny',
      toolName: 'bash',
      finalOutcome: 'deny',
      historyOutcome: 'ask-denied',
      reason: 'timeout',
    });
    const step = (innerAskRows()[0].trace as { steps: Array<Record<string, unknown>> }).steps[0];
    expect(step).toMatchObject({ rule: 'sandbox_escalate_once', result: 'deny' });
    expect(step.reason).toMatchObject({
      metadata: { deniedPath: '/tmp/denied-target.txt', action: 'sandbox_escalate_once' },
    });
  });

  it('审批处理器抛错：不落内层账（行为同改动前：工具失败，不新增 fail-open）', async () => {
    const seen: { approved?: unknown; threw?: boolean } = {};
    resolverState.execute.mockImplementation(async (_name: string, _params: unknown, context: ToolContext) => {
      try {
        seen.approved = await context.requestPermission(SANDBOX_ESCALATE_REQUEST);
      } catch {
        seen.threw = true;
        throw new Error('approval channel exploded');
      }
      return { success: true, result: 'unreachable' };
    });
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockRejectedValue(new Error('approval channel exploded')),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('probe_tool', {}, { sessionId: 'session-inner-ask-throws' });

    expect(seen.threw).toBe(true);
    expect(result.success).toBe(false);
    // 外层闸没参与（requiresPermission: false），内层 ask 又是抛错而非裁决 → 一条账都不该有。
    expect(ledgerState.appendPermissionDecision).not.toHaveBeenCalled();
  });

  it('外层 ask 仍恰好一条账本行：内层包装器不重复记账（无双重计数）', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'Write',
      description: 'write test tool',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content'],
      },
      requiresPermission: true,
      permissionLevel: 'write',
    });
    resolverState.execute.mockResolvedValue({ success: true, result: 'outer-ask-done' });
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' }),
      forcePermissionHandler: true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Write', {
      file_path: '/tmp/workbench/outer-ask-probe.txt',
      content: 'probe',
    }, { sessionId: 'session-outer-ask-only' });

    expect(result.success).toBe(true);
    // 工具体没发起任何内层 ask → 全程只有外层权限闸那一条 ask-approved。
    expect(ledgerState.appendPermissionDecision).toHaveBeenCalledTimes(1);
    expect(ledgerState.appendPermissionDecision.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-outer-ask-only',
      historyOutcome: 'ask-approved',
      reason: 'user',
    });
  });
});
