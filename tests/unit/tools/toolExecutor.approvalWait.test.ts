import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { clearApprovalWait, getApprovalWaitMs } from '../../../src/host/tools/toolExecutionTelemetry';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ToolExecutor in-tool approval wait accounting', () => {
  afterEach(() => {
    clearApprovalWait('call-approval-wait');
    resolverState.definition = undefined;
    resolverState.execute.mockReset();
  });

  it('records the time a tool spends in context.requestPermission as approval wait', async () => {
    resolverState.definition = {
      name: 'probe_tool',
      description: 'approval wait probe',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'read',
    };
    resolverState.execute.mockImplementation(async (_name: string, _params: unknown, context: {
      requestPermission: (request: unknown) => Promise<boolean>;
    }) => {
      const approved = await context.requestPermission({
        type: 'command',
        tool: 'probe_tool',
        details: {},
        reason: 'probe in-tool approval wait accounting',
      });
      return { success: true, result: { toolCallId: 'call-approval-wait', success: true, output: String(approved) } };
    });
    const executor = new ToolExecutor({
      requestPermission: async () => {
        await sleep(60);
        return true;
      },
      workingDirectory: '/tmp/tool-approval-wait-test',
    });

    const run = executor.execute('probe_tool', {}, {
      sessionId: 'session-approval-wait',
      currentToolCallId: 'call-approval-wait',
    });
    // 审批挂起期间：等待时长必须开始累计（否则外层 inactivity 预算会把看卡时间算作无进展）。
    await sleep(20);
    expect(getApprovalWaitMs('call-approval-wait', Date.now())).toBeGreaterThan(0);
    await run;
    // 审批结束后：已结束的那段等待被全额封账保留。
    expect(getApprovalWaitMs('call-approval-wait', Date.now())).toBeGreaterThanOrEqual(50);
  });
});
