// N-FIX-NOTIFY-NEEDS-INPUT-FOREGROUND-BANNER-FU1-RUNSTATE（host 侧复现）：
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
  agentBody: null as null | ((executionId?: string) => Promise<unknown>),
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
// 模型调用脚本化：agent 动作体由测试注入，其余 cronService 控制流全部是真的。
vi.mock('../../../src/host/cron/cronAgentAction', () => ({
  executeCronAgentAction: (_host: unknown, _def: unknown, _action: unknown, executionId?: string) =>
    state.agentBody!(executionId),
}));

import { getCronService } from '../../../src/host/cron/cronService';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { loadRecentCronExecutions } from '../../../src/host/cron/cronPersistence';
import { registerCronHandlers } from '../../../src/host/ipc/cron.ipc';
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
  state.handlers.clear();
  registerCronHandlers();
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys = ON');
  state.db.exec(SCHEMA);
});

afterEach(() => {
  state.db?.close();
  state.db = null;
  resetPermissionModeManager();
});

describe('停车审批 → 批准 → 命令完成：三个 host 视图里的运行状态', () => {
  it('完成后 cron_executions 行 / getJobExecutions / getRecentExecutions IPC 都是 completed', async () => {
    const sessionId = 'cron-parked-runstate';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const events: Array<{ type: string; data?: { id?: string } }> = [];
    const repo = { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository;
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: (event) => events.push(event as never),
      injectedPendingApprovalRepo: repo,
    });

    let commandRan = false;
    state.agentBody = async () => {
      const verdict = await island.requestPermission({
        type: 'command',
        tool: 'Bash',
        details: { command: 'echo BG-PARKED-888' },
        sessionId,
      });
      if (!verdict.approved) throw new Error('denied');
      commandRan = true;
      return { output: 'BG-PARKED-888' };
    };

    const service = getCronService();
    const job = await service.createJob({
      name: '停车审批测试',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 12, unit: 'hours' },
      action: { type: 'agent', agentType: 'default', prompt: 'echo BG-PARKED-888' },
      enabled: true,
    });

    const views = async (label: string) => {
      const rowsRaw = loadRecentCronExecutions(5).map((e) => `${e.id}:${e.status}`);
      const jobExec = service.getJobExecutions(job.id, 5).map((e) => `${e.id}:${e.status}`);
      const ipc = await state.handlers.get(IPC_DOMAINS.CRON)!(null, { action: 'getRecentExecutions', payload: { limit: 5 } }) as {
        data: Array<{ id: string; status: string }>;
      };
      const snap = {
        db_row: rowsRaw,
        getJobExecutions: jobExec,
        ipc_getRecentExecutions: ipc.data.map((e) => `${e.id}:${e.status}`),
      };
      // 取证输出：证据档里引用这几行原文
      console.log(`[VIEWS ${label}] ${JSON.stringify(snap)}`);
      return snap;
    };

    const settled = service.triggerJob(job.id);
    for (let i = 0; i < 50 && events.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(events[0]?.type).toBe('permission_request');

    const parked = await views('parked');
    expect(parked.db_row[0]).toMatch(/:running$/);

    const requestId = events[0].data!.id!;
    expect(island.resolveParkedApproval(requestId, 'allow')).toBe(true);
    const approved = await views('approved-immediately');
    // 批准刚落下的瞬间命令还没跑完时允许仍是 running；下面等 triggerJob 返回再判终态。
    expect(approved.db_row.length).toBe(1);

    const execution = await settled;
    expect(commandRan).toBe(true);
    expect(execution?.status).toBe('completed');

    const finished = await views('finished');
    expect(finished.db_row[0]).toMatch(/:completed$/);
    expect(finished.getJobExecutions[0]).toMatch(/:completed$/);
    expect(finished.ipc_getRecentExecutions[0]).toMatch(/:completed$/);
  });
});
