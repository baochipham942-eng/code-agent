// N-CRON-UNATTENDED-BASH-PARK-STUCK-REST1 ④：cron 会话审批 30 分钟无人批准 → run 照常 completed，结果带 unattendedApprovalDenials。
// 下面沿用 RunState 测试脚手架：
// 真 CronService.triggerJob + 真 SQLite(:memory:) + 真 OrchestratorPermissionIsland 停车/批准；
// 只有「模型调用」被脚本化（agent 动作体：请求 Bash 审批 → 批准后跑命令 → 返回）。
// 在 停车 / 批准 / 完成 三个时刻抓同一条 execution 的三个视图：
//   cron_executions 行（loadRecentCronExecutions）、getJobExecutions、getRecentExecutions IPC 处理器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { AppSettings } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
  orchestrator: null as unknown,
  handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db }),
}));
vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: unknown) => Promise<unknown>) => state.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));
vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));
// 只把「模型」和会话/orchestrator 工厂脚本化：真 executeCronAgentAction + 真 CronService + 真 island。
vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: async () => ({ id: 'cron-degrade-session', workingDirectory: undefined }),
}));
vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({
  buildCronAgentRunOptions: async () => ({}),
}));
vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => state.orchestrator,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import { getCronService } from '../../../src/host/cron/cronService';
import { loadRecentCronExecutions } from '../../../src/host/cron/cronPersistence';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

const SCHEMA = `
  CREATE TABLE cron_jobs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    schedule_type TEXT NOT NULL, schedule TEXT NOT NULL, action TEXT NOT NULL,
    runs_on TEXT NOT NULL DEFAULT 'local', max_run_budget REAL, max_runs INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0, min_interval_seconds INTEGER NOT NULL DEFAULT 60,
    result_channel TEXT, cloud_job_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    max_retries INTEGER DEFAULT 0, retry_delay INTEGER DEFAULT 5000, timeout INTEGER DEFAULT 60000,
    tags TEXT, metadata TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE cron_executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, duration INTEGER,
    result TEXT, error TEXT, retry_attempt INTEGER NOT NULL DEFAULT 0, exit_code INTEGER,
    trigger_json TEXT, cost_usd REAL,
    FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
  );
`;


beforeEach(() => {
  resetPermissionModeManager();
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys = ON');
  state.db.exec(SCHEMA);
});

afterEach(() => {
  state.db?.close();
  state.db = null;
  resetPermissionModeManager();
});


describe('停车审批降级拒绝：run 以 completed 收尾', () => {
  it('30 分钟无人批准 → 执行行 completed，结果带 unattendedApprovalDenials，job 不被停用', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sessionId = 'cron-degrade-session';
    getPermissionModeManager().markUnattendedSession(sessionId);
    getPermissionModeManager().markUnattendedApprovalDegrade(sessionId);
    const repo = { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository;
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });
    let toolResultSeenByModel = '';
    let messages: Array<{ role: string; content: string }> = [];
    state.orchestrator = {
      setExecutionTopology: vi.fn(),
      getMessages: () => messages,
      sendMessage: async () => {
        const verdict = await island.requestPermission({
          type: 'command', tool: 'Bash', details: { command: 'node refresh-wechat.js' }, sessionId,
        });
        toolResultSeenByModel = verdict.message ?? '';
        messages = [{ role: 'assistant', content: '微信：未读取：微信（需要你批准）；其余来源已汇总。' }];
      },
    };

    const service = getCronService();
    const job = await service.createJob({
      name: '晨报降级',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 12, unit: 'hours' },
      action: { type: 'agent', agentType: 'default', prompt: '读两个来源' },
      enabled: true,
    });
    const settled = service.triggerJob(job.id);
    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE);
    vi.useRealTimers();
    const execution = await settled;

    expect(execution?.status).toBe('completed');
    expect(toolResultSeenByModel).toContain('UNATTENDED_APPROVAL_TIMEOUT');
    const row = loadRecentCronExecutions(5)[0];
    console.log(`[EXECUTION ROW] ${JSON.stringify({ status: row.status, error: row.error, result: row.result })}`);
    expect(row.status).toBe('completed');
    expect(row.error ?? null).toBeNull();
    expect((row.result as { unattendedApprovalDenials?: Array<{ tool: string; code: string }> }).unattendedApprovalDenials)
      .toEqual([expect.objectContaining({ tool: 'Bash', code: 'UNATTENDED_APPROVAL_TIMEOUT' })]);
    expect(service.getJob(job.id)?.enabled).toBe(true);
  });
});
