// N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-REALRUN-FU2 ①：agent 运行一建会话就把 session_id 落库。
// 真 CronService.triggerJob + 真 executeCronAgentAction + real file-backed SQLite；
// 只有会话创建与 orchestrator 被脚本化（sendMessage 永不返回 = 模型跑到一半进程被杀）。
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db }),
}));
vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
  ipcHost: { handle: vi.fn() },
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
vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: async (_def: unknown, _action: unknown, executionId?: string) => ({
    id: `session-of-${executionId}`, workingDirectory: undefined,
  }),
}));
vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({ buildCronAgentRunOptions: async () => ({}) }));
vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      setExecutionTopology: vi.fn(),
      sendMessage: () => new Promise(() => undefined), // 永不返回：模拟被 kill -9
      getMessages: () => [],
    }),
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

import { getCronService } from '../../../src/host/cron/cronService';
import { markInterruptedCronExecutions } from '../../../src/host/cron/cronPersistence';

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

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cron-early-session-')));
  state.db = new Database(path.join(dir, 'cron.db'));
  state.db.pragma('foreign_keys = ON');
  state.db.exec(SCHEMA);
});
afterEach(() => {
  state.db?.close();
  state.db = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('cron 执行在停车/运行中被杀前已持久化 session key', () => {
  it('① running 行 + 会话已建 + 从未完成 → markInterruptedCronExecutions 后 session_id 仍在 SQLite 文件里', async () => {
    const service = getCronService();
    const job = await service.createJob({
      name: '早存 session',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 12, unit: 'hours' },
      action: { type: 'agent', agentType: 'default', prompt: 'x' },
      enabled: true,
    });

    void service.triggerJob(job.id); // 不等：永远不会返回
    let row: { id: string; status: string; session_id: string | null } | undefined;
    for (let i = 0; i < 100; i += 1) {
      row = state.db!.prepare('SELECT id, status, session_id FROM cron_executions WHERE job_id = ?').get(job.id) as typeof row;
      if (row?.session_id) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    console.log(`[ROW before restart] ${JSON.stringify(row)}`);
    expect(row?.status).toBe('running');
    expect(row?.session_id).toBe(`session-of-${row?.id}`);

    await markInterruptedCronExecutions(); // 重启后的启动扫描
    const after = state.db!.prepare('SELECT status, session_id FROM cron_executions WHERE job_id = ?').get(job.id);
    console.log(`[ROW after restart] ${JSON.stringify(after)}`);
    expect(after).toEqual({ status: 'interrupted', session_id: `session-of-${row?.id}` });
  });
});
