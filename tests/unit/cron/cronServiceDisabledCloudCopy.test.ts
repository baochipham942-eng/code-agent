// ============================================================================
// 停用云端副本的真实服务测试（N-ROLE-ROUTINE-RESTATE-FU1-FU1）：
// copy-to-cloud 一律存 enabled:false 的副本。真 CronService + 真 CronCloudRuntime
// （云端未配置）下——
//   (a) 创建停用副本：不尝试注册云端，零执行记录（列表不再出现「latest: failed」）；
//   (b) 此刻启用：才第一次尝试注册，恰好落一条 failed 执行记录（用户刚按了启用，
//       失败出现在这一刻，与用户的动作对得上）；
//   (c) 已注册（map 里有 cloudJobId）的停用任务被更新：服务仍把更新推给
//       cloudRuntime.updateJob（推停用态）。
// cronService.test.ts 已 1400+ 行不再增长，新用例独立成文件。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  savedRows: [] as unknown[][],
  lastRunAt: new Map<string, number>(),
  sessionIds: new Set<string>(),
}));

const sessionState = vi.hoisted(() => ({
  messages: new Map<string, Array<import('../../../src/shared/contract').Message>>(),
  broadcasts: [] as unknown[],
}));

const channelState = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_accountId: string, _chatId: string, _text: string): Promise<{ success: boolean; messageId?: string; error?: string }> => ({ success: true, messageId: 'om_stub' })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM cron_jobs') ? dbState.cronRows : []),
        get: (jobId: string) => (
          sql.includes('MAX(started_at)')
            ? { last_run_at: dbState.lastRunAt.get(jobId) ?? null }
            : undefined
        ),
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 0 };
        },
      }),
    }),
    getSession: (sessionId: string) => (dbState.sessionIds.has(sessionId) ? { id: sessionId } : null),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    // 刻意不含 cronCloud：云端执行地址/令牌未配置（真实 CronApiClient.requireConfig 会抛）。
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAccount: () => undefined,
    getAllAccounts: () => [],
    sendMessage: channelState.sendMessage,
    on: channelState.on,
    removeListener: channelState.removeListener,
  }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: async (sessionId: string, message: import('../../../src/shared/contract').Message) => {
      const messages = sessionState.messages.get(sessionId) ?? [];
      messages.push(message);
      sessionState.messages.set(sessionId, messages);
    },
    getMessages: async (sessionId: string) => sessionState.messages.get(sessionId) ?? [],
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: (...args: unknown[]) => sessionState.broadcasts.push(args),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      setExecutionTopology: () => undefined,
      sendMessage: vi.fn(async () => undefined),
      getMessages: () => [],
    }),
    setWorkingDirectory: () => undefined,
    cleanup: () => undefined,
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async () => null,
    createSession: vi.fn(async () => ({ id: 'cron-agent-session-disabled-copy' })),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

const artifactRefreshState = vi.hoisted(() => ({
  begin: vi.fn((_definition: unknown): unknown => undefined),
  finish: vi.fn(async (_state: unknown, _outcome: unknown): Promise<void> => undefined),
  cwd: vi.fn((_definition: unknown, fallback: string | undefined) => fallback),
}));

vi.mock('../../../src/host/cron/artifactStandingRefresh', () => ({
  beginArtifactRefresh: artifactRefreshState.begin,
  finishArtifactRefresh: artifactRefreshState.finish,
  cronAgentWorkingDirectory: artifactRefreshState.cwd,
}));

import { CronService } from '../../../src/host/cron/cronService';
import type { CronCloudRuntime } from '../../../src/host/cron/cronCloudRuntime';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';

/** 角色绑定 agent 任务（copy-to-cloud 副本的真实形状：runsOn=cloud、enabled=false）。 */
function disabledCloudCopy() {
  return {
    name: '牧之晨间简报 (云端)',
    runsOn: 'cloud' as const,
    enabled: false,
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
    action: { type: 'agent' as const, agentType: 'default' as const, prompt: '汇总今天的日程并给一段晨间简报', roleId: 'role-muzhi' },
  };
}

/** saveCronExecution 的 run 参数形如 [execId, jobId, sessionId, status, …]（job 行的 row[1] 是任务名，不会撞 jobId）。 */
function persistedExecutionsFor(jobId: string) {
  return dbState.savedRows.filter((row) => row[1] === jobId);
}

function realCloudRuntime(service: CronService): CronCloudRuntime {
  return (service as unknown as { cloudRuntime: CronCloudRuntime }).cloudRuntime;
}

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
  dbState.lastRunAt.clear();
  dbState.sessionIds.clear();
  sessionState.messages.clear();
  sessionState.broadcasts = [];
  shutdownEventBus();
});

describe('CronService 停用云端副本（真实 CronCloudRuntime · 云端未配置）', () => {
  it('(a) 创建停用云端副本：不注册云端，内存与落库的执行记录都为零', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());

    expect(job.enabled).toBe(false);
    expect(job.runsOn).toBe('cloud');
    // 内存执行历史为空
    expect(service.getJobExecutions(job.id)).toEqual([]);
    // 落库侧也没有任何执行行（旧实现注册即失败，会假写一条 status='failed'）
    expect(persistedExecutionsFor(job.id)).toEqual([]);
    await service.shutdown();
  });

  it('(b) 云端仍未配置时启用副本：此刻才第一次尝试注册，恰好一条 failed 执行记录', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());

    const enabled = await service.updateJob(job.id, { enabled: true });
    expect(enabled?.enabled).toBe(true);

    const executions = service.getJobExecutions(job.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      jobId: job.id,
      runsOn: 'cloud',
      status: 'failed',
      duration: 0,
    });
    expect(executions[0]?.error).toContain('云端计划任务服务暂时不可用');
    // 落库侧恰好一条 failed 执行行
    expect(persistedExecutionsFor(job.id)).toHaveLength(1);
    await service.shutdown();
  });

  it('(c) 已注册的停用任务被更新：服务仍调用 cloudRuntime.updateJob 推停用态', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());
    // 模拟「创建时已注册成功」：map 条目上补 remote 指针
    const active = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(active).toBeTruthy();
    active!.cloudJobId = 'remote-registered-1';

    const updateSpy = vi.spyOn(realCloudRuntime(service), 'updateJob');
    const updated = await service.updateJob(job.id, { name: '停用态改名' });

    expect(updated?.enabled).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: job.id,
      name: '停用态改名',
      enabled: false,
    }));
    await service.shutdown();
  });
});
