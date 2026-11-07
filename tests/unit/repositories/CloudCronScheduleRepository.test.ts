import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { CloudCronScheduleRepository } from '../../../src/host/services/core/repositories/CloudCronScheduleRepository';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

const TICK = 1_700_000_000_000;

function upsertInput(jobId: string, overrides: Partial<Parameters<CloudCronScheduleRepository['upsertSchedule']>[0]> = {}) {
  return {
    accountId: 'acct_a',
    jobId,
    scheduleJson: JSON.stringify({ type: 'every', interval: 1, unit: 'minutes' }),
    requestJson: '{"prompt":"hi"}',
    enabled: true,
    nextRunAt: TICK + 60_000,
    now: TICK,
    ...overrides,
  };
}

describe('CloudCronScheduleRepository (ADR-087 S4)', () => {
  let db: BetterSqlite3.Database;
  let repo: CloudCronScheduleRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger);
    repo = new CloudCronScheduleRepository(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function scheduleCount(): number {
    return Number((db.prepare('SELECT COUNT(*) AS total FROM cloud_cron_schedules').get() as { total: number }).total);
  }

  it('upsert 新建一行，时间戳全部来自参数', () => {
    const record = repo.upsertSchedule(upsertInput('job_1'));
    expect(record).toMatchObject({
      accountId: 'acct_a',
      jobId: 'job_1',
      enabled: true,
      nextRunAt: TICK + 60_000,
      lastSlot: null,
      createdAt: TICK,
      updatedAt: TICK,
    });
    expect(scheduleCount()).toBe(1);
  });

  it('同 (account_id, job_id) 重报即覆盖并重置 last_slot，created_at 不动；不同账户各行', () => {
    const first = repo.upsertSchedule(upsertInput('job_1'));
    repo.advanceSchedule({ accountId: 'acct_a', jobId: 'job_1', nextRunAt: null, enabled: false, lastSlot: TICK, now: TICK + 5 });
    const second = repo.upsertSchedule(upsertInput('job_1', { nextRunAt: TICK + 120_000, now: TICK + 10 }));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(TICK + 10);
    expect(second.nextRunAt).toBe(TICK + 120_000);
    expect(second.lastSlot).toBeNull();
    expect(scheduleCount()).toBe(1);

    repo.upsertSchedule(upsertInput('job_1', { accountId: 'acct_b', nextRunAt: TICK, now: TICK + 20 }));
    expect(scheduleCount()).toBe(2);
    expect(repo.getSchedule('acct_b', 'job_1')?.nextRunAt).toBe(TICK);
    expect(repo.getSchedule('acct_a', 'nope')).toBeNull();
  });

  it('listDue 只回 enabled 且到期的行，按 next_run_at 升序（同刻按 job_id 定序）', () => {
    repo.upsertSchedule(upsertInput('job_late', { nextRunAt: TICK + 300 }));
    repo.upsertSchedule(upsertInput('job_early', { nextRunAt: TICK + 100 }));
    repo.upsertSchedule(upsertInput('job_future', { nextRunAt: TICK + 999_999 }));
    repo.upsertSchedule(upsertInput('job_disabled', { enabled: false, nextRunAt: TICK + 100 }));
    repo.upsertSchedule(upsertInput('job_null', { nextRunAt: null }));
    repo.upsertSchedule(upsertInput('job_mid', { nextRunAt: TICK + 100 }));

    const due = repo.listDueSchedules(TICK + 500);
    expect(due.map((row) => row.jobId)).toEqual(['job_early', 'job_mid', 'job_late']);
    expect(repo.listDueSchedules(TICK + 99)).toEqual([]);
  });

  it('advanceSchedule 落 next_run_at / enabled / last_slot（无未来出现即停用）', () => {
    repo.upsertSchedule(upsertInput('job_adv'));
    repo.advanceSchedule({
      accountId: 'acct_a',
      jobId: 'job_adv',
      nextRunAt: null,
      enabled: false,
      lastSlot: TICK + 60_000,
      now: TICK + 61_000,
    });
    const advanced = repo.getSchedule('acct_a', 'job_adv');
    expect(advanced).toMatchObject({
      nextRunAt: null,
      enabled: false,
      lastSlot: TICK + 60_000,
      updatedAt: TICK + 61_000,
    });
    // 停用后不再出现在到期扫描里
    expect(repo.listDueSchedules(TICK + 999_999)).toEqual([]);
  });

  it('PK 冲突的行不改账户：account_id 由 PK 保护（同 job 不同账户共存）', () => {
    repo.upsertSchedule(upsertInput('job_pk', { accountId: 'acct_a', nextRunAt: TICK }));
    repo.upsertSchedule(upsertInput('job_pk', { accountId: 'acct_b', nextRunAt: TICK }));
    // 改写 acct_a 的行不会碰到 acct_b 的行
    repo.advanceSchedule({ accountId: 'acct_a', jobId: 'job_pk', nextRunAt: null, enabled: false, lastSlot: TICK, now: TICK });
    expect(repo.getSchedule('acct_b', 'job_pk')?.enabled).toBe(true);
    expect(repo.getSchedule('acct_a', 'job_pk')?.enabled).toBe(false);
  });
});
