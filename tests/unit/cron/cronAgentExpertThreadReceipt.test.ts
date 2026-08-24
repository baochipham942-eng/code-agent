import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobAction, CronJobDefinition, Message } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  expertThreadId: null as string | null,
  persistExpertMarker: true,
  assistantText: '今天巡检完成，重点结论是没有发现异常。',
  runError: null as Error | null,
  created: [] as Array<Record<string, unknown>>,
  receipts: [] as Array<{ sessionId: string; message: Message }>,
  broadcasts: [] as unknown[][],
}));

const sessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => 'foreground-session'),
  setCurrentSession: vi.fn(),
  getSession: vi.fn(async () => null),
  createSession: vi.fn(async (options: Record<string, unknown>) => {
    state.created.push(options);
    return {
      id: options.readOnly ? 'cron-session' : 'created-expert-thread',
      title: options.title as string,
      modelConfig: options.modelConfig,
      workingDirectory: options.workingDirectory,
      metadata: options.metadata,
      createdAt: 1,
      updatedAt: 1,
    };
  }),
  patchSessionMetadata: vi.fn(async () => {
    if (state.persistExpertMarker) state.expertThreadId = 'created-expert-thread';
    return state.persistExpertMarker;
  }),
  findLatestExpertThreadSession: vi.fn(async () => (
    state.expertThreadId ? { id: state.expertThreadId } : null
  )),
  addMessageToSession: vi.fn(async (sessionId: string, message: Message) => {
    state.receipts.push({ sessionId, message });
  }),
}));

const orchestrator = vi.hoisted(() => ({
  setExecutionTopology: vi.fn(),
  sendMessage: vi.fn(async () => {
    if (state.runError) throw state.runError;
    return { completed: true };
  }),
  getMessages: vi.fn(() => [{
    id: 'assistant-final',
    role: 'assistant' as const,
    content: state.assistantText,
    timestamp: 1,
  }]),
}));

const taskManager = vi.hoisted(() => ({
  getOrCreateCurrentOrchestrator: vi.fn(() => orchestrator),
  setWorkingDirectory: vi.fn(),
  cleanup: vi.fn(),
  setCurrentSessionId: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({
    getSettings: () => ({ model: { provider: 'openai', model: 'gpt-5.4' } }),
  }),
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ model: { provider: 'openai', model: 'gpt-5.4' } }),
    getApiKey: () => '',
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => null,
  }),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => taskManager,
}));

vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({
  buildCronAgentRunOptions: async (roleId?: string) => roleId
    ? { mode: 'normal', agentOverrideId: roleId, turnSystemContext: ['role context'] }
    : undefined,
}));

vi.mock('../../../src/host/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform')>(),
  broadcastToRenderer: (...args: unknown[]) => state.broadcasts.push(args),
}));

vi.mock('../../../src/host/services/surfaceExecution/UserBrowserLinkService', () => ({
  getUserBrowserLinkService: () => ({ end: vi.fn(async () => undefined) }),
}));

vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', () => ({
  getManagedBrowserProviderAdapter: () => ({
    activateConversationResumeState: vi.fn(),
    clearConversationResumeState: vi.fn(async () => undefined),
  }),
}));

import { CronService } from '../../../src/host/cron/cronService';

function agentJob(roleId?: string): CronJobDefinition {
  return {
    id: 'job-daily-review',
    name: '每日项目巡检',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: '巡检项目并汇报结论',
      roleId,
    },
    enabled: true,
    runsOn: 'local',
    createdAt: 1,
    updatedAt: 1,
  };
}

async function executeAgentAction(definition: CronJobDefinition) {
  return (new CronService() as unknown as {
    executeAction: (
      definition: CronJobDefinition,
      action: CronJobAction,
      timeout?: number,
      executionId?: string,
    ) => Promise<unknown>;
  }).executeAction(definition, definition.action, undefined, 'execution-1');
}

beforeEach(() => {
  state.expertThreadId = null;
  state.persistExpertMarker = true;
  state.assistantText = '今天巡检完成，重点结论是没有发现异常。';
  state.runError = null;
  state.created = [];
  state.receipts = [];
  state.broadcasts = [];
  vi.clearAllMocks();
});

describe('named cron agent expert-thread receipt', () => {
  it('appends a successful receipt to the existing expert thread and points to the independent cron session', async () => {
    state.expertThreadId = 'existing-expert-thread';

    await expect(executeAgentAction(agentJob('牧之'))).resolves.toMatchObject({
      sessionId: 'cron-session',
    });

    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ readOnly: true, type: 'schedule' });
    expect(sessionManager.findLatestExpertThreadSession).toHaveBeenCalledOnce();
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({
      sessionId: 'existing-expert-thread',
      message: {
        id: 'cron-expert-receipt:execution-1',
        role: 'assistant',
        source: 'automation',
        content: expect.stringMatching(/每日项目巡检[\s\S]*结果：成功[\s\S]*没有发现异常[\s\S]*neo:\/\/thread\/cron-session/),
        metadata: {
          automation: {
            event: 'completed',
            resultSessionId: 'cron-session',
            sourceSessionId: 'existing-expert-thread',
          },
        },
      },
    });
    expect(state.broadcasts).toHaveLength(1);
  });

  it('creates one marked, non-activating expert thread when none exists, then writes the receipt there', async () => {
    await executeAgentAction(agentJob('牧之'));

    expect(state.created).toHaveLength(2);
    expect(state.created[1]).toMatchObject({
      title: '牧之',
      workingDirectory: undefined,
    });
    expect(sessionManager.patchSessionMetadata).toHaveBeenCalledOnce();
    expect(sessionManager.patchSessionMetadata).toHaveBeenCalledWith('created-expert-thread', {
      expertThread: { roleId: '牧之', setAt: expect.any(Number) },
    });
    expect(sessionManager.findLatestExpertThreadSession).toHaveBeenCalledTimes(2);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0].sessionId).toBe('created-expert-thread');
    expect(sessionManager.setCurrentSession).not.toHaveBeenCalled();
    expect(taskManager.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('writes a failed receipt with the partial assistant conclusion, then preserves the cron failure', async () => {
    state.expertThreadId = 'existing-expert-thread';
    state.assistantText = '已经检查到第二步，发现依赖服务不可用。';
    state.runError = new Error('provider unavailable');

    await expect(executeAgentAction(agentJob('牧之'))).rejects.toThrow('provider unavailable');

    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0].message.content).toMatch(/结果：失败（provider unavailable）/);
    expect(state.receipts[0].message.content).toContain('发现依赖服务不可用');
    expect(state.receipts[0].message.metadata?.automation).toMatchObject({
      event: 'failed',
      status: 'failed',
      resultSessionId: 'cron-session',
    });
  });

  it('bounds a long assistant conclusion before writing it into the expert thread', async () => {
    state.expertThreadId = 'existing-expert-thread';
    state.assistantText = `${'结'.repeat(1_300)}尾部不应保留`;

    await executeAgentAction(agentJob('牧之'));

    const content = state.receipts[0].message.content;
    const summary = content.split('这次的结论：\n')[1].split('\n\n[查看')[0];
    expect(Array.from(summary)).toHaveLength(1_201);
    expect(summary).toMatch(/结…$/);
    expect(summary).not.toContain('尾部不应保留');
  });

  it('does not query, create, or write an expert thread for an agent cron without roleId', async () => {
    await executeAgentAction(agentJob());

    expect(state.created).toHaveLength(1);
    expect(sessionManager.findLatestExpertThreadSession).not.toHaveBeenCalled();
    expect(sessionManager.patchSessionMetadata).not.toHaveBeenCalled();
    expect(sessionManager.addMessageToSession).not.toHaveBeenCalled();
  });

  it('warns when a new thread marker is not queryable without losing the successful cron result', async () => {
    state.persistExpertMarker = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(executeAgentAction(agentJob('牧之'))).resolves.toMatchObject({
      sessionId: 'cron-session',
    });

    expect(state.receipts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to append named-agent cron receipt; cron result preserved'),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
