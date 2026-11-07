import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));
// 真BudgetService + 真scoped钩子（不 mock scopedCostLimit）：走 budgetService.recordUsage
// → recordScopedUsage/recordScopedCost 的生产记账路径，只把数据库换成内存 SQLite。
import { BudgetService, type TokenUsage } from '../../../src/host/services/core/budgetService';
import { createCronRunCostMeterForExecution } from '../../../src/host/cron/cronRunCostMeter';
import {
  createCronExecutionCostWriter,
  markInterruptedCronExecutions,
  saveCronExecution,
  saveCronJob,
} from '../../../src/host/cron/cronPersistence';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const NOW = Date.UTC(2026, 10, 4, 8, 0, 0);

function localJob(): Parameters<typeof saveCronJob>[0] {
  return {
    id: 'job-incr-1',
    name: 'incremental cost job',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'agent', agentType: 'default', prompt: 'check' },
    runsOn: 'local',
    enabled: true,
    maxRetries: 0,
    retryDelay: 5_000,
    timeout: 60_000,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runningExecution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'exec-incr-1',
    jobId: 'job-incr-1',
    runsOn: 'local',
    status: 'running',
    scheduledAt: NOW,
    startedAt: NOW,
    retryAttempt: 0,
    ...overrides,
  };
}

/** 计价回落 default（$1/$3 per 1M）：10k in + 1k out = $0.013。 */
function providerUsage(sessionId: string, inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    model: 'cost-increment-test-model',
    provider: 'cost-increment-test-provider',
    timestamp: NOW,
    sessionId,
    source: 'provider',
  };
}

function readExecutionRow(executionId: string): { status: string; cost_usd: number | null } {
  const row = databaseState.db!.prepare(
    'SELECT status, cost_usd FROM cron_executions WHERE id = ?',
  ).get(executionId) as { status: string; cost_usd: number | null };
  expect(row).toBeDefined();
  return row;
}

/** 数增量 UPDATE 落库次数（节流证明用）。 */
function countIncrementWrites(db: BetterSqlite3.Database): () => number {
  const original = db.prepare.bind(db);
  let writes = 0;
  db.prepare = ((sql: string) => {
    if (typeof sql === 'string' && sql.includes('UPDATE cron_executions') && sql.includes('cost_usd')) {
      writes += 1;
    }
    return original(sql);
  }) as typeof db.prepare;
  return () => writes;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('cron execution incremental cost persistence (N-CRON-RUN-LEDGER-VISIBLE-FU1)', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        runs_on TEXT NOT NULL,
        max_run_budget REAL,
        max_runs INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        min_interval_seconds INTEGER NOT NULL DEFAULT 60,
        result_channel TEXT,
        cloud_job_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER,
        retry_delay INTEGER,
        timeout INTEGER,
        tags TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cron_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration INTEGER,
        result TEXT,
        error TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        trigger_json TEXT,
        cost_usd REAL
      );
    `);
    databaseState.db = db;
  });

  afterEach(() => {
    databaseState.db?.close();
    databaseState.db = null;
  });

  it('①进程死掉（run 未收尾）→ markInterrupted 后行里留着已发生的真实成本', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution();
    await saveCronExecution(execution); // executeJob 开跑时先落 running 行
    // 与生产同款接线：入口（cronAgentAction / role-wake）都走这个工厂挂增量窄写。
    const meter = createCronRunCostMeterForExecution(undefined, execution.id);
    const budget = new BudgetService({ enabled: false });
    await meter.run(async () => {
      budget.recordUsage(providerUsage('s1', 10_000, 1_000)); // $0.013，立即首写
      budget.recordUsage(providerUsage('s1', 5_000, 1_000)); // $0.008，节流窗内走尾随写
    });
    // 不做收尾整行写（进程死在这里），等尾随写落完再模拟下次启动的 interrupted 标记。
    await sleep(1_200);
    await markInterruptedCronExecutions();
    const row = readExecutionRow(execution.id);
    expect(row.status).toBe('interrupted');
    expect(row.cost_usd).not.toBeNull();
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(row.cost_usd).toBeCloseTo(meter.getCostUsd(), 6);
    expect(row.cost_usd).toBeCloseTo(0.021, 6);
  });

  it('突发调用被节流：窗内只留一笔，尾随写把最后的累计补齐', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution({ id: 'exec-incr-burst' });
    await saveCronExecution(execution);
    const writes = countIncrementWrites(databaseState.db!);
    const writer = createCronExecutionCostWriter(execution.id, { throttleMs: 80 });
    // 突发 5 笔：第一笔立即写，其余四笔进尾随。
    writer(0.001);
    writer(0.002);
    writer(0.003);
    writer(0.004);
    writer(0.005);
    expect(writes()).toBe(1);
    expect(readExecutionRow(execution.id).cost_usd).toBeCloseTo(0.001, 6);
    await sleep(250);
    expect(writes()).toBe(2); // 只有一次尾随补写
    expect(readExecutionRow(execution.id).cost_usd).toBeCloseTo(0.005, 6);
  });

  it('行离开 running 后增量写不再生效：收尾整行写赢', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution({ id: 'exec-incr-done' });
    await saveCronExecution(execution);
    const writer = createCronExecutionCostWriter(execution.id, { throttleMs: 0 });
    writer(0.01);
    expect(readExecutionRow(execution.id).cost_usd).toBeCloseTo(0.01, 6);
    // finally 收尾：整行写入终态与最终成本。
    execution.status = 'completed';
    execution.cost = 0.03;
    await saveCronExecution(execution);
    writer(0.02); // 迟到的增量写不许覆盖终态
    expect(readExecutionRow(execution.id)).toMatchObject({ status: 'completed', cost_usd: 0.03 });
  });

  it('迟到的尾随写在行已收尾后是 no-op', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution({ id: 'exec-incr-late' });
    await saveCronExecution(execution);
    const writer = createCronExecutionCostWriter(execution.id, { throttleMs: 60 });
    writer(0.01); // 立即写
    writer(0.02); // 排尾随
    execution.status = 'completed';
    execution.cost = 0.03;
    await saveCronExecution(execution);
    await sleep(200); // 尾随定时器这时才触发
    expect(readExecutionRow(execution.id)).toMatchObject({ status: 'completed', cost_usd: 0.03 });
  });

  it('重试链中途被杀：后一趟计量器增量累加，不冲销前一趟已花的钱', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution({ id: 'exec-incr-retry' });
    await saveCronExecution(execution);
    // 第一趟尝试（有自己的计量器/写入器），死在收尾前。
    const attemptOne = createCronExecutionCostWriter(execution.id, { throttleMs: 0 });
    attemptOne(0.01);
    // 第二趟尝试：新的计量器从 0 计，增量累进同一行。
    const attemptTwo = createCronExecutionCostWriter(execution.id, { throttleMs: 0 });
    attemptTwo(0.02);
    await markInterruptedCronExecutions();
    const row = readExecutionRow(execution.id);
    expect(row.status).toBe('interrupted');
    expect(row.cost_usd).toBeCloseTo(0.03, 6);
  });

  it('无 cost 的行（shell 任务等）不被增量写碰到', async () => {
    await saveCronJob(localJob());
    const execution = runningExecution({ id: 'exec-incr-shell' });
    await saveCronExecution(execution);
    const writer = createCronExecutionCostWriter(execution.id, { throttleMs: 0 });
    writer(Number.NaN);
    writer(0);
    writer(-1);
    expect(readExecutionRow(execution.id).cost_usd).toBeNull();
  });
});
