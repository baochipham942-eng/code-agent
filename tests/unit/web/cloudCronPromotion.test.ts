import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { CloudCronScheduler } from '../../../src/host/services/cloudRun/cloudCronScheduler';
import type { CloudRunRecord } from '../../../src/host/services/core/repositories/CloudRunRepository';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { CloudRunRouteRuntime } from '../../../src/web/routes/cloudRunRoutes';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

const ACCOUNT = 'acct_promote';
const TICK = 1_700_000_000_000;

describe('cloud cron promotion (ADR-087 S4)', () => {
  let db: BetterSqlite3.Database;
  let tick: number;
  let ledger: CloudRunLedger;
  let errorLog: (message: string, ...args: unknown[]) => void;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger);
    tick = TICK;
    errorLog = vi.fn((_message: string, ..._args: unknown[]) => {});
    ledger = createCloudRunLedger({ db, clock: () => tick, accountResolver: () => ACCOUNT });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function makeRuntime(overrides: { executeCronRun?: (record: CloudRunRecord) => Promise<void> } = {}): CloudRunRouteRuntime {
    return new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry: new RunRegistry(),
      execute: async () => {},
      ...(overrides.executeCronRun ? { executeCronRun: overrides.executeCronRun } : {}),
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLog, debug: vi.fn() },
    });
  }

  function fillQuota(): void {
    ledger.admit({ sessionId: 'sess_manual_1', trigger: 'manual', requestJson: '{"prompt":"m1"}' });
    ledger.admit({ sessionId: 'sess_manual_2', trigger: 'manual', requestJson: '{"prompt":"m2"}' });
  }

  function manualRunIds(): string[] {
    return (db.prepare("SELECT run_id FROM cloud_runs WHERE trigger = 'manual' ORDER BY created_at ASC").all() as { run_id: string }[])
      .map((row) => row.run_id);
  }

  function cronRunId(jobId: string): string {
    const row = db
      .prepare('SELECT run_id FROM cloud_runs WHERE session_id = ?')
      .get(`cloud-cron:${jobId}`) as { run_id: string };
    return row.run_id;
  }

  it('③ 配额满时 admit 排队不执行；槽释放提升后 cron 执行体恰好一次，行不落 failed', () => {
    fillQuota();
    expect(ledger.countInFlight(ACCOUNT)).toBe(2);

    const cronExecutor = vi.fn(async (_record: CloudRunRecord) => {});
    const runtime = makeRuntime({ executeCronRun: cronExecutor });
    runtime.ledger(); // 安装 onTransition 提升监听
    const scheduler = new CloudCronScheduler({
      db,
      getLedger: () => ledger,
      accountResolver: () => ACCOUNT,
      clock: () => tick,
      // tick 路径与提升路径共用同一执行体（生产接线即如此）
      executeRun: cronExecutor,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
    });
    // request_json 故意不是合法 AgentRunBody（无 prompt）：证明提升路径从不 parse
    scheduler.registerSchedule({
      accountId: ACCOUNT,
      jobId: 'job_quota',
      schedule: { type: 'at', datetime: TICK },
      requestJson: '{"kind":"cron-payload"}',
    });

    const result = scheduler.tick();
    expect(result).toMatchObject({ admitted: 1, executed: 0 });
    const runId = cronRunId('job_quota');
    expect(ledger.getRun(runId)?.state).toBe('queued');
    expect(ledger.countInFlight(ACCOUNT)).toBe(2); // 排队不占配额
    expect(cronExecutor).not.toHaveBeenCalled();

    // 释放一个槽：manual run 1 终态 → onTransition → 提升队列头
    ledger.transition(manualRunIds()[0], 'succeeded');

    expect(cronExecutor).toHaveBeenCalledTimes(1);
    const promoted = ledger.getRun(runId);
    expect(promoted?.state).toBe('running'); // 提升后交给执行体，没有被 settle failed
    const promotedCall = cronExecutor.mock.calls[0];
    expect(promotedCall?.[0]?.runId).toBe(runId);
    expect(ledger.countInFlight(ACCOUNT)).toBe(2);
  });

  it('未配 cron 执行体：提升的 cron 行 fail-closed（settle failed + 留痕），不进 AgentRunBody 解析路径', () => {
    fillQuota();
    const runtime = makeRuntime(); // 无 executeCronRun
    runtime.ledger();
    ledger.admit({
      sessionId: 'cloud-cron:job_failclosed',
      trigger: 'cron',
      requestJson: '{"kind":"cron-payload"}',
      clientMessageId: `cron:job_failclosed:${TICK}`,
    });
    const runId = cronRunId('job_failclosed');
    expect(ledger.getRun(runId)?.state).toBe('queued');

    ledger.transition(manualRunIds()[0], 'succeeded');

    expect(ledger.getRun(runId)?.state).toBe('failed');
    expect(errorLog).toHaveBeenCalledWith(
      '[CloudRun] Promoted cron run has no executor configured; settling failed (S4 fail-closed)',
      expect.objectContaining({ runId }),
    );
  });

  it('startup sweep 提升排队 cron 行同样走 cron 执行体（不 parse、不误 settle）', async () => {
    const cronExecutor = vi.fn(async (_record: CloudRunRecord) => {});
    const runtime = makeRuntime({ executeCronRun: cronExecutor });
    // 配额占满两格，cron 行只能排队；两格都是崩溃现场（不在 registry）
    fillQuota();
    ledger.admit({
      sessionId: 'cloud-cron:job_sweep',
      trigger: 'cron',
      requestJson: '{"kind":"cron-payload"}',
      clientMessageId: `cron:job_sweep:${TICK}`,
    });
    expect(ledger.getRun(cronRunId('job_sweep'))?.state).toBe('queued');
    // sweep 标 interrupted 放槽 → cron 行被提升 → 交 cron 执行体（而非 AgentRunBody 解析）
    await runtime.runStartupSweep();

    expect(ledger.getRun(cronRunId('job_sweep'))?.state).toBe('running');
    expect(cronExecutor).toHaveBeenCalledTimes(1);
  });
});
