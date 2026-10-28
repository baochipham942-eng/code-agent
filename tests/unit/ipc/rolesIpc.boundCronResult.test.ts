// ============================================================================
// listBoundCronJobs 读真实临时 SQLite 与真实 CronService：
// 最近一条执行的时间、状态、短错误，以及别的角色不会混进来。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => Database,
}));

const databaseState = vi.hoisted(() => ({
  service: null as import('../../../src/host/services/core/databaseService').DatabaseService | null,
}));

vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/databaseService')>();
  return {
    ...actual,
    getDatabase: () => {
      if (!databaseState.service) throw new Error('test database is not ready');
      return databaseState.service;
    },
  };
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { getCronService } from '../../../src/host/cron/cronService';
import { saveCronExecution } from '../../../src/host/cron/cronPersistence';
import { registerRolesHandlers } from '../../../src/host/ipc/roles.ipc';
import type { RoleBoundCronJob } from '../../../src/shared/contract/roleAssets';

const ROLE_ID = '竞品观察员';
const OTHER_ROLE_ID = '另一个角色';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function bindHandler(): Handler {
  let registered: Handler | undefined;
  registerRolesHandlers({
    handle: (_channel: string, handler: Handler) => {
      registered = handler;
    },
  } as unknown as Parameters<typeof registerRolesHandlers>[0]);
  if (!registered) throw new Error('roles handler was not registered');
  return registered;
}

describe('listBoundCronJobs reads the newest execution from the real database', () => {
  const dirs: string[] = [];
  const jobIds: string[] = [];
  let database: DatabaseService | null = null;

  afterEach(async () => {
    const service = getCronService();
    for (const id of jobIds.splice(0)) {
      await service.deleteJob(id);
    }
    database?.close();
    database = null;
    databaseState.service = null;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns next run, last run, last status, and a short last error for the requested role only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-bound-cron-'));
    dirs.push(dir);
    database = new DatabaseService(dir);
    await database.initialize();
    databaseState.service = database;

    const service = getCronService();
    const failed = await service.createJob({
      name: '晨报',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      action: { type: 'agent', agentType: 'general', prompt: '看竞品', roleId: ROLE_ID },
      enabled: true,
    });
    const neverRun = await service.createJob({
      name: '周报',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 10 * * 1', timezone: 'UTC' },
      action: { type: 'agent', agentType: 'general', prompt: '写周报', roleId: ROLE_ID },
      enabled: true,
    });
    const other = await service.createJob({
      name: '别人的晨报',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 11 * * *', timezone: 'UTC' },
      action: { type: 'agent', agentType: 'general', prompt: '别的角色', roleId: OTHER_ROLE_ID },
      enabled: true,
    });
    jobIds.push(failed.id, neverRun.id, other.id);

    const reason = `站点打不开${'甲'.repeat(140)}`;
    await saveCronExecution({
      id: 'exec-older-ok',
      jobId: failed.id,
      status: 'completed',
      scheduledAt: 1_000,
      startedAt: 1_100,
      completedAt: 1_200,
      retryAttempt: 0,
    });
    await saveCronExecution({
      id: 'exec-newer-failed',
      jobId: failed.id,
      status: 'failed',
      scheduledAt: 5_000,
      startedAt: 5_100,
      completedAt: 5_200,
      error: `${reason}\n    at Object.fetch (src/host/cron/runner.ts:10:5)`,
      retryAttempt: 1,
    });

    const handler = bindHandler();
    const res = await handler(null, { action: 'listBoundCronJobs', payload: { roleId: ROLE_ID } }) as IPCResponse<RoleBoundCronJob[]>;
    expect(res.success).toBe(true);
    const rows = res.data ?? [];
    expect(rows.map((job) => job.id).sort()).toEqual([failed.id, neverRun.id].sort());

    const listed = new Map(service.listJobs().map((job) => [job.id, job.nextRunAt]));
    const failedRow = rows.find((job) => job.id === failed.id);
    const neverRow = rows.find((job) => job.id === neverRun.id);
    expect(failedRow).toMatchObject({
      actionType: 'agent',
      nextRunAt: listed.get(failed.id),
      lastRunAt: 5_200,
      lastStatus: 'failed',
      lastError: `${reason.slice(0, 119)}…`,
    });
    expect(failedRow?.lastError).not.toContain('Object.fetch');
    expect(failedRow?.nextRunAt).toEqual(expect.any(Number));
    expect(neverRow).toMatchObject({
      actionType: 'agent',
      nextRunAt: listed.get(neverRun.id),
    });
    expect(neverRow?.lastRunAt).toBeUndefined();
    expect(neverRow?.lastStatus).toBeUndefined();
    expect(neverRow?.lastError).toBeUndefined();
    expect(neverRow?.nextRunAt).toEqual(expect.any(Number));
  }, 60_000);
});
