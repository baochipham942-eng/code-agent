// ============================================================================
// N-CRON-URGENCY-CLEAR-PERSIST（FB-441）：agent 任务清空「紧急判据」(urgencyCriteria)
// 后保存，清掉必须真清——updateJob 对 action 是整段替换，旧 action 里的判据不许
// 复活；updateJob 返回值、落库的 action 列原文、重读（normalizeCronJobRow，即
// 重启加载路径）三处都不再有可用判据。配套：清空判据后的运行按「无判据」规则
// 照常通知（N-CRON-URGENCY-NOTIFY）——can_wait 结果不再被安静，判据门复用既有
// 导出谓词 cronAgentRunHasAlert / cronNotifyQuietRound（真实链路在
// cronAgentAction.ts 的 hasAlert/notifyQuietRound 两行），不新造判据。
// mock 面与 cronServiceJobsChanged.test.ts 同款（DB/configService/sessionAutomation
// 替身），DB 换成真 better-sqlite3 内存库以核对 action 列原文与重读行。
// ============================================================================

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

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => ({}) }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));

import { CronService } from '../../../src/host/cron/cronService';
import { cronAgentRunHasAlert, normalizeCronJobRow } from '../../../src/host/cron/cronNormalizers';
import { cronNotifyQuietRound } from '../../../src/host/cron/cronFailurePolicy';
import type { AgentAction, CronJobAction } from '../../../src/shared/contract/cron';

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
      max_runs INTEGER CHECK (max_runs IS NULL OR max_runs >= 1),
      run_count INTEGER NOT NULL,
      min_interval_seconds INTEGER NOT NULL,
      result_channel TEXT,
      cloud_job_id TEXT,
      enabled INTEGER NOT NULL,
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
      status TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );
  `);
  databaseState.db = db;
});

afterEach(() => {
  databaseState.db?.close();
  databaseState.db = null;
});

/** 带判据的 agent 任务（编辑器里「紧急判据」输入框有值的形态）。 */
function agentJobWithCriteria() {
  return {
    name: '晨间分诊',
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
    action: {
      type: 'agent' as const,
      agentType: 'default',
      prompt: '汇总未读邮件和消息',
      context: {},
      urgencyCriteria: '只有老板的邮件算紧急',
    },
    runsOn: 'local' as const,
    enabled: true,
  };
}

/** 编辑器清空判据后经 JSON 传输的实际 updates：trim 后为空 → undefined → 丢键。 */
function clearedCriteriaWire() {
  return JSON.parse(JSON.stringify({
    action: { type: 'agent', agentType: 'default', prompt: '汇总未读邮件和消息', context: {} },
  }));
}

/** CronJobAction 联合收窄到 agent 变体（生产链路 executeAction 的分支同款，
 *  谓词入参也是 AgentAction）。收窄本身即断言：清空判据不许顺带改掉动作类型。 */
function asAgentAction(action: CronJobAction | undefined): AgentAction {
  if (!action || action.type !== 'agent') {
    throw new Error(`expected agent action after save/reload, got type=${action?.type}`);
  }
  return action;
}

describe('N-CRON-URGENCY-CLEAR-PERSIST 清空紧急判据的持久化', () => {
  it('清空判据保存后：返回值、action 列原文、重读行三处都没有可用的 urgencyCriteria', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJobWithCriteria());
    expect(job.action).toMatchObject({ urgencyCriteria: '只有老板的邮件算紧急' });

    const updated = await service.updateJob(job.id, clearedCriteriaWire());
    // ① 返回值：清掉的键没有以旧值、空串等任何形态回来。
    expect(asAgentAction(updated?.action).urgencyCriteria).toBeUndefined();

    // ② 落库的 action 列原文：键整个不存在（FB-441 复查的就是这列）。
    const row = databaseState.db!
      .prepare('SELECT * FROM cron_jobs WHERE id = ?')
      .get(job.id) as Record<string, unknown>;
    const savedAction = JSON.parse(row.action as string) as Record<string, unknown>;
    expect(savedAction).toMatchObject({ type: 'agent', agentType: 'default' });
    expect('urgencyCriteria' in savedAction).toBe(false);

    // ③ 重启重读（initialize 从 DB 加载走的 normalizeCronJobRow）：判据仍为无。
    const reloaded = normalizeCronJobRow(row);
    expect(reloaded?.action).toMatchObject({ type: 'agent', agentType: 'default', prompt: '汇总未读邮件和消息' });
    expect(asAgentAction(reloaded?.action).urgencyCriteria).toBeUndefined();
    await service.shutdown();
  });

  it('清空判据后的运行：can_wait 结果仍照常通知（无判据规则，N-CRON-URGENCY-NOTIFY）', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJobWithCriteria());
    await service.updateJob(job.id, clearedCriteriaWire());
    const row = databaseState.db!
      .prepare('SELECT * FROM cron_jobs WHERE id = ?')
      .get(job.id) as Record<string, unknown>;
    const reloadedAction = asAgentAction(normalizeCronJobRow(row)!.action);

    // 对照组（证明谓词会咬）：判据还在时，同一段 can_wait 正文被安静。
    const canWaitText = 'urgency: can_wait\n今天没有需要今天处理的要紧事。';
    expect(cronAgentRunHasAlert(asAgentAction(job.action), { isExternalWatch: false, finalAssistantText: canWaitText })).toBe(false);
    expect(cronNotifyQuietRound(asAgentAction(job.action), false, job.id)).toBe(true);

    // 清空后（重读出的 action）：无判据任务恒有警报、永不安静——正常通知路径。
    // 两行与 cronAgentAction.ts 成功轮的 hasAlert / notifyQuietRound 计算同构。
    const hasAlert = cronAgentRunHasAlert(reloadedAction, { isExternalWatch: false, finalAssistantText: canWaitText });
    expect(hasAlert).toBe(true);
    expect(cronNotifyQuietRound(reloadedAction, hasAlert, job.id)).toBe(false);
    await service.shutdown();
  });
});
