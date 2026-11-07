import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { CloudCronScheduler } from '../../../src/host/services/cloudRun/cloudCronScheduler';
import type { CloudRunRecord } from '../../../src/host/services/core/repositories/CloudRunRepository';
import type { CronScheduleConfig } from '../../../src/shared/contract/cron';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

const ACCOUNT = 'acct_scheduler';
// 2023-11-14T22:13:20.000Z：分钟边界取整可预期（22:14:00 = TICK+40s）。
const TICK = 1_700_000_000_000;
const NEXT_MINUTE = Date.UTC(2023, 10, 14, 22, 14, 0);

interface TestLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

function stubLogger(): TestLogger {
  const quiet = (_message: string, ..._args: unknown[]) => {};
  return { info: vi.fn(quiet), warn: vi.fn(quiet), error: vi.fn(quiet) };
}

function openDb(file: string): BetterSqlite3.Database {
  const db = new Database(file);
  applySchema(db, logger);
  return db;
}

describe('CloudCronScheduler (ADR-087 S4)', () => {
  let db: BetterSqlite3.Database;
  let tick: number;
  let logs: TestLogger;

  beforeEach(() => {
    db = openDb(':memory:');
    tick = TICK;
    logs = stubLogger();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const clock = () => tick;
  const account = () => ACCOUNT;

  function makeLedger(): CloudRunLedger {
    return createCloudRunLedger({ db, clock, accountResolver: account });
  }

  function makeScheduler(overrides: {
    ledger?: CloudRunLedger;
    executeRun?: (record: CloudRunRecord) => Promise<void>;
    accountResolver?: () => string | null;
  } = {}): CloudCronScheduler {
    const ledger = overrides.ledger ?? makeLedger();
    return new CloudCronScheduler({
      db,
      getLedger: () => ledger,
      accountResolver: overrides.accountResolver ?? account,
      clock,
      ...(overrides.executeRun ? { executeRun: overrides.executeRun } : {}),
      logger: logs,
    });
  }

  function cloudRunRows(): Record<string, unknown>[] {
    return db.prepare('SELECT * FROM cloud_runs ORDER BY created_at ASC').all() as Record<string, unknown>[];
  }

  function scheduleRow(jobId: string): Record<string, unknown> {
    return db
      .prepare('SELECT * FROM cloud_cron_schedules WHERE account_id = ? AND job_id = ?')
      .get(ACCOUNT, jobId) as Record<string, unknown>;
  }

  describe('① 到点先 admit 再执行', () => {
    it('执行体只在 admit(trigger:cron) 之后被调，且只收 running 行；幂等键按设计拼', () => {
      const ledger = makeLedger();
      const executor = vi.fn(async (_record: CloudRunRecord) => {});
      const scheduler = makeScheduler({ ledger, executeRun: executor });
      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_due',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{"kind":"cron-payload"}',
      });

      const admitSpy = vi.spyOn(ledger, 'admit');
      const result = scheduler.tick();

      expect(admitSpy).toHaveBeenCalledTimes(1);
      expect(admitSpy.mock.calls[0][0]).toMatchObject({
        sessionId: 'cloud-cron:job_due',
        trigger: 'cron',
        clientMessageId: `cron:job_due:${TICK}`,
      });
      expect(executor).toHaveBeenCalledTimes(1);
      // 断言调用顺序：admit 先于执行体
      expect(admitSpy.mock.invocationCallOrder[0]).toBeLessThan(executor.mock.invocationCallOrder[0]);
      expect(result).toMatchObject({ admitted: 1, executed: 1, skippedAccounts: 0, failed: 0 });

      const rows = cloudRunRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        account_id: ACCOUNT,
        session_id: 'cloud-cron:job_due',
        trigger: 'cron',
        state: 'running',
        client_message_id: `cron:job_due:${TICK}`,
      });
      const firstExecutorCall = executor.mock.calls[0];
      expect(firstExecutorCall?.[0]?.runId).toBe(String(rows[0].run_id));
    });

    it('无已验证账户时整趟空转：不 admit、不执行', () => {
      const executor = vi.fn(async () => {});
      const ledger = makeLedger();
      const scheduler = makeScheduler({ ledger, executeRun: executor, accountResolver: () => null });
      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_noacct',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{}',
      });
      const admitSpy = vi.spyOn(ledger, 'admit');
      expect(scheduler.tick()).toMatchObject({ admitted: 0, executed: 0 });
      expect(admitSpy).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
    });

    it('他账户的到期行跳过并 warn，不 admit', () => {
      const executor = vi.fn(async () => {});
      const ledger = makeLedger();
      const scheduler = makeScheduler({ ledger, executeRun: executor });
      scheduler.registerSchedule({
        accountId: 'acct_other',
        jobId: 'job_foreign',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{}',
      });
      const admitSpy = vi.spyOn(ledger, 'admit');
      const result = scheduler.tick();
      expect(result).toMatchObject({ admitted: 0, executed: 0, skippedAccounts: 1 });
      expect(admitSpy).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
      expect(cloudRunRows()).toHaveLength(0);
      expect(logs.warn).toHaveBeenCalledWith(
        '[CloudCron] Skip due schedule owned by another account',
        expect.objectContaining({ jobId: 'job_foreign', ownerAccount: 'acct_other' }),
      );
    });
  });

  describe('② 同一槽只跑一次', () => {
    it('普通第二次 tick（at 已停用）与崩溃重放（next_run_at 拨回已 admit 的槽）都只落一行、只执行一次', () => {
      const executor = vi.fn(async () => {});
      const ledger = makeLedger();
      const scheduler = makeScheduler({ ledger, executeRun: executor });
      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_once',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{"kind":"cron-payload"}',
      });

      // 第一趟：触发一次
      scheduler.tick();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(cloudRunRows()).toHaveLength(1);
      // at 到点触发后即停用
      expect(scheduleRow('job_once')).toMatchObject({ enabled: 0, next_run_at: null, last_slot: TICK });

      // 普通第二次 tick：无到期行，零动作
      expect(scheduler.tick()).toMatchObject({ admitted: 0, executed: 0 });
      expect(executor).toHaveBeenCalledTimes(1);

      // 崩溃重放：模拟 admit 之后、next_run_at 推进之前进程死掉
      db.prepare('UPDATE cloud_cron_schedules SET next_run_at = ?, enabled = 1 WHERE account_id = ? AND job_id = ?')
        .run(TICK, ACCOUNT, 'job_once');
      const admitSpy = vi.spyOn(ledger, 'admit');
      const replay = scheduler.tick();
      expect(admitSpy).toHaveBeenCalledTimes(1);
      expect(admitSpy.mock.calls[0][0]).toMatchObject({ clientMessageId: `cron:job_once:${TICK}` });
      // 同一槽重放命中 duplicate：不执行、不落第二行
      expect(replay).toMatchObject({ admitted: 0, executed: 0 });
      expect(executor).toHaveBeenCalledTimes(1);
      expect(cloudRunRows()).toHaveLength(1);
    });

    it('every 调度崩溃重放同样幂等；推进后 next_run_at = now 之后第一次出现', () => {
      const executor = vi.fn(async () => {});
      const ledger = makeLedger();
      const scheduler = makeScheduler({ ledger, executeRun: executor });
      const registered = scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_every',
        schedule: { type: 'every', interval: 1, unit: 'minutes' },
        requestJson: '{}',
      });
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;
      // 注册时取严格晚于 now 的第一次出现：22:14:00
      expect(registered.record.nextRunAt).toBe(NEXT_MINUTE);

      tick = NEXT_MINUTE;
      scheduler.tick();
      expect(executor).toHaveBeenCalledTimes(1);

      // 崩溃重放：拨回已 admit 的槽
      db.prepare('UPDATE cloud_cron_schedules SET next_run_at = ? WHERE account_id = ? AND job_id = ?')
        .run(NEXT_MINUTE, ACCOUNT, 'job_every');
      scheduler.tick();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(cloudRunRows()).toHaveLength(1);
      // 推进结果：严格晚于 now（22:14:00）的第一次出现 = 22:15:00
      expect(scheduleRow('job_every')).toMatchObject({
        enabled: 1,
        next_run_at: Date.UTC(2023, 10, 14, 22, 15, 0),
        last_slot: NEXT_MINUTE,
      });
    });

    it('missed slots 合并成一次 run：停机三个间隔后 tick 只触发一次并直接跳到未来槽', () => {
      const executor = vi.fn(async () => {});
      const scheduler = makeScheduler({ executeRun: executor });
      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_missed',
        schedule: { type: 'every', interval: 1, unit: 'minutes' },
        requestJson: '{}',
      });
      // 停机到 22:16:20：22:14/22:15/22:16 三个槽都过了
      tick = Date.UTC(2023, 10, 14, 22, 16, 20);
      const result = scheduler.tick();
      expect(result).toMatchObject({ admitted: 1, executed: 1 });
      expect(executor).toHaveBeenCalledTimes(1);
      expect(cloudRunRows()).toHaveLength(1);
      // 只补一次，之后直接跳到严格晚于 now 的第一次出现（22:17:00）
      expect(scheduleRow('job_missed')).toMatchObject({
        next_run_at: Date.UTC(2023, 10, 14, 22, 17, 0),
        last_slot: NEXT_MINUTE,
      });
    });
  });

  describe('④ event 调度一概拒绝；at/every/cron 接受', () => {
    const eventShapes: { name: string; schedule: CronScheduleConfig }[] = [
      {
        name: 'channel 源',
        schedule: { type: 'event', source: 'channel', accountId: 'chan_1', eventName: 'message' },
      },
      {
        name: 'connector mail 源',
        schedule: { type: 'event', source: 'connector', connector: 'mail', accountId: 'mail_1', eventName: 'message' },
      },
      {
        name: 'webhook 源',
        schedule: { type: 'event', source: 'webhook', eventName: 'message' },
      },
    ];

    it.each(eventShapes)('拒绝 $name：稳定码 + 英文文案 + 零行落库', ({ schedule }) => {
      const scheduler = makeScheduler();
      const result = scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_event',
        schedule,
        requestJson: '{}',
      });
      expect(result).toMatchObject({ ok: false, code: 'CLOUD_CRON_EVENT_SCHEDULE_UNSUPPORTED' });
      if (!result.ok) {
        expect(result.message).toMatch(/channel.*mail.*webhook/);
        expect(result.message).toMatch(/this computer/);
      }
      const count = db.prepare('SELECT COUNT(*) AS total FROM cloud_cron_schedules').get() as { total: number };
      expect(count.total).toBe(0);
    });

    it('at/every/cron 都接受并落行；坏声明（非法 datetime / 非法 interval / 非法表达式）报错不落行', () => {
      const scheduler = makeScheduler();
      const at = scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_at',
        schedule: { type: 'at', datetime: TICK + 5_000 },
        requestJson: '{}',
      });
      const every = scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_every',
        schedule: { type: 'every', interval: 5, unit: 'minutes' },
        requestJson: '{}',
      });
      const cron = scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_cron',
        schedule: { type: 'cron', expression: '0 */5 * * * *' },
        requestJson: '{}',
      });
      expect(at.ok).toBe(true);
      expect(every.ok).toBe(true);
      expect(cron.ok).toBe(true);
      const count = db.prepare('SELECT COUNT(*) AS total FROM cloud_cron_schedules').get() as { total: number };
      expect(count.total).toBe(3);

      expect(() =>
        scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_bad_at',
          schedule: { type: 'at', datetime: 'not-a-date' },
          requestJson: '{}',
        }),
      ).toThrow(/Invalid datetime/);
      expect(() =>
        scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_bad_every',
          schedule: { type: 'every', interval: 0, unit: 'minutes' },
          requestJson: '{}',
        }),
      ).toThrow(/Invalid interval/);
      expect(() =>
        scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_bad_cron',
          schedule: { type: 'cron', expression: 'not a cron' },
          requestJson: '{}',
        }),
      ).toThrow(/Invalid schedule for cloud cron job job_bad_cron/);
      expect((db.prepare('SELECT COUNT(*) AS total FROM cloud_cron_schedules').get() as { total: number }).total).toBe(3);
    });
  });

  describe('⑤ 持久化与停用', () => {
    it('真 sqlite 文件库 close/reopen 保留 next_run_at；停用行永不触发；at 只触发一次', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cron-scheduler-'));
      const file = path.join(dir, 'schedules.db');
      try {
        // 在文件库上组装（beforeEach 的 :memory: 库与本例无关）
        const db1 = openDb(file);
        const ledger1 = createCloudRunLedger({ db: db1, clock, accountResolver: account });
        const scheduler = new CloudCronScheduler({
          db: db1,
          getLedger: () => ledger1,
          accountResolver: account,
          clock,
          logger: logs,
        });
        const executor = vi.fn(async () => {});
        const atRegistered = scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_at_once',
          schedule: { type: 'at', datetime: TICK + 1_000 },
          requestJson: '{"kind":"cron-payload"}',
        });
        const everyRegistered = scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_every_persist',
          schedule: { type: 'every', interval: 1, unit: 'minutes' },
          requestJson: '{"kind":"cron-payload"}',
        });
        scheduler.registerSchedule({
          accountId: ACCOUNT,
          jobId: 'job_disabled',
          schedule: { type: 'at', datetime: TICK + 1_000 },
          requestJson: '{}',
          enabled: false,
        });
        expect(atRegistered.ok).toBe(true);
        expect(everyRegistered.ok).toBe(true);
        db1.close();

        // 重启 = 重开文件库、重放 schema、新调度器/新账本
        const db2 = openDb(file);
        const ledger2 = createCloudRunLedger({ db: db2, clock, accountResolver: account });
        const reopened = new CloudCronScheduler({
          db: db2,
          getLedger: () => ledger2,
          accountResolver: account,
          clock,
          executeRun: executor,
          logger: logs,
        });
        // next_run_at 原样保留
        const reopenedAt = db2
          .prepare('SELECT next_run_at FROM cloud_cron_schedules WHERE job_id = ?')
          .get('job_at_once') as { next_run_at: number };
        const reopenedEvery = db2
          .prepare('SELECT next_run_at FROM cloud_cron_schedules WHERE job_id = ?')
          .get('job_every_persist') as { next_run_at: number };
        expect(reopenedAt.next_run_at).toBe(TICK + 1_000);
        expect(reopenedEvery.next_run_at).toBe(NEXT_MINUTE);

        // at 到点触发一次
        tick = TICK + 1_000;
        reopened.tick();
        expect(executor).toHaveBeenCalledTimes(1);

        // at 停用后永不再触发；every 未到点；disabled 行永不触发
        tick = TICK + 30_000;
        reopened.tick();
        reopened.tick();
        expect(executor).toHaveBeenCalledTimes(1);

        // every 到点触发一次（同一执行体，共两次）
        tick = NEXT_MINUTE;
        reopened.tick();
        expect(executor).toHaveBeenCalledTimes(2);
        const runs = db2.prepare('SELECT * FROM cloud_runs').all() as Record<string, unknown>[];
        expect(runs).toHaveLength(2);
        expect(new Set(runs.map((row) => String(row.session_id)))).toEqual(
          new Set(['cloud-cron:job_at_once', 'cloud-cron:job_every_persist']),
        );
        // disabled 行从头到尾没进过 cloud_runs
        expect(runs.some((row) => String(row.session_id).includes('job_disabled'))).toBe(false);
        db2.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('缺省执行体 fail-closed', () => {
    it('未注入执行体：admit 后立即 settle failed + 留痕，不执行任何东西', () => {
      const scheduler = makeScheduler();
      const result = scheduler.tick(); // 无到期行
      expect(result).toMatchObject({ admitted: 0, executed: 0 });

      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_failclosed',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{"kind":"cron-payload"}',
      });
      const fired = scheduler.tick();
      expect(fired).toMatchObject({ admitted: 1, executed: 1 });
      const rows = cloudRunRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ trigger: 'cron', state: 'failed' });
      expect(logs.error).toHaveBeenCalledWith(
        '[CloudCron] No cron executor configured; settling cloud run as failed (ADR-087 S4 fail-closed)',
        expect.objectContaining({ runId: String(rows[0].run_id) }),
      );
    });

    it('执行体 reject 时 settle failed（可靠终态），调度本身不崩', async () => {
      const executor = vi.fn(async () => {
        throw new Error('openclaw unreachable');
      });
      const scheduler = makeScheduler({ executeRun: executor });
      scheduler.registerSchedule({
        accountId: ACCOUNT,
        jobId: 'job_reject',
        schedule: { type: 'at', datetime: TICK },
        requestJson: '{}',
      });
      expect(() => scheduler.tick()).not.toThrow();
      await vi.waitFor(() => {
        expect(cloudRunRows()[0]).toMatchObject({ state: 'failed' });
      });
      expect(logs.error).toHaveBeenCalledWith(
        '[CloudCron] Cron executor rejected; settling cloud run failed',
        expect.objectContaining({ runId: expect.any(String) }),
      );
    });
  });
});
