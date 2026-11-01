import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
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

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { enterObserveModeForCronRun } = await import('../../../src/host/cron/cronObserveMode');
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { CronEventDecisionInput, CronEventDecisionStore } from '../../../src/host/cron/cronEventDecisionLedger';

// ============================================================================
// N-TRIGGER-OBSERVE-MODE ②：观察档事件运行里的对外副作用工具调用在宿主执行路径
// （ToolExecutor，审批之前）被拦下：假工具执行器零调用、审批回调零调用、台账一条 would_act。
// ============================================================================

function eventJob(actionMode: 'observe' | 'auto'): CronJobDefinition {
  return {
    id: 'job-observe',
    name: 'watch inbox',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: 'reply to customers' },
    runsOn: 'local',
    maxRunBudget: 0.5,
    enabled: true,
    actionMode,
    createdAt: 1,
    updatedAt: 1,
  };
}

function memoryStore() {
  const rows: CronEventDecisionInput[] = [];
  const store: CronEventDecisionStore = {
    record: (batch) => { rows.push(...batch); },
    countActionsForRun: () => 0,
  };
  return { rows, store };
}

describe('ToolExecutor observe-mode interception (N-TRIGGER-OBSERVE-MODE ②)', () => {
  const definitions = new Map([
    ['mail_send', {
      name: 'mail_send',
      description: 'send email test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['mcp__lark__im_v1_message_create', {
      name: 'mcp__lark__im_v1_message_create',
      description: 'lark send message test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
    ['Read', {
      name: 'Read',
      description: 'read test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'read',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'sent' });
  });

  it('observe: mail_send is never executed and never asks approval; one would_act with tool/target/summary', async () => {
    const { rows, store } = memoryStore();
    const leave = enterObserveModeForCronRun(eventJob('observe'), 'cron-session-obs', 'run-1', store);
    try {
      const requestPermission = vi.fn(async (_req: unknown) => true);
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      executor.setAuditEnabled(false);

      const result = await executor.execute(
        'mail_send',
        { to: ['client@example.com'], subject: 'Re: invoice', body: 'We will refund you today.' },
        { sessionId: 'cron-session-obs' },
      );

      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(requestPermission).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toContain('recorded, not executed (observe mode)');
      expect(result.metadata).toMatchObject({ code: 'OBSERVE_MODE_RECORDED', executionStarted: false });
      expect(rows).toEqual([expect.objectContaining({
        jobId: 'job-observe',
        kind: 'action',
        decision: 'would_act',
        runId: 'run-1',
        tool: 'mail_send',
        target: 'client@example.com',
        summary: 'Re: invoice — We will refund you today.',
      })]);
    } finally {
      leave();
    }
  });

  it('observe: an IM MCP send is intercepted the same way; read-only tools still run', async () => {
    const { rows, store } = memoryStore();
    const leave = enterObserveModeForCronRun(eventJob('observe'), 'cron-session-obs-2', 'run-2', store);
    try {
      const requestPermission = vi.fn(async (_req: unknown) => true);
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      executor.setAuditEnabled(false);

      const sent = await executor.execute(
        'mcp__lark__im_v1_message_create',
        { params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_group', content: '{"text":"hi all"}' } },
        { sessionId: 'cron-session-obs-2' },
      );
      expect(sent.output).toContain('recorded, not executed (observe mode)');
      expect(rows[0]).toMatchObject({ tool: 'mcp__lark__im_v1_message_create', target: 'chat_id:oc_group' });

      await executor.execute('Read', { file_path: '/tmp/workbench/a.txt' }, { sessionId: 'cron-session-obs-2' });
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
      expect(resolverState.execute.mock.calls[0][0]).toBe('Read');
      expect(rows).toHaveLength(1);
    } finally {
      leave();
    }
  });

  it('auto and unregistered sessions keep the existing approval path (observe only adds a deny)', async () => {
    const { rows, store } = memoryStore();
    const leaveAuto = enterObserveModeForCronRun(eventJob('auto'), 'cron-session-auto', 'run-3', store);
    try {
      const requestPermission = vi.fn(async (_req: unknown) => false);
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      executor.setAuditEnabled(false);

      const autoResult = await executor.execute('mail_send', { to: ['a@b.com'], subject: 'x' }, { sessionId: 'cron-session-auto' });
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(autoResult.success).toBe(false);
      expect(rows).toEqual([]);
    } finally {
      leaveAuto();
    }
    const left = enterObserveModeForCronRun(eventJob('observe'), 'cron-session-left', 'run-4', store);
    left();
    const requestPermission = vi.fn(async (_req: unknown) => true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);
    await executor.execute('mail_send', { to: ['a@b.com'], subject: 'x' }, { sessionId: 'cron-session-left' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([]);
  });
});
