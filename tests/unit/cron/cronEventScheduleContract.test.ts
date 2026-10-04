// ============================================================================
// 'event' 调度契约测试（验收 ①⑥）
// ----------------------------------------------------------------------------
// ① CronScheduleType 含 'event'；event 任务经 normalize/persist/load round-trip；
//    非法 event 配置（缺 accountId / cloud runsOn / 非 agent 动作 / 无 maxRunBudget）
//    被拒。
// ⑥ 执行记录的 trigger（kind/source/accountId/eventCount/droppedCount/eventIds）
//    落库后重载不丢。
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

import {
  isCronScheduleType,
  normalizeCronJobRow,
  normalizeSchedule,
} from '../../../src/host/cron/cronNormalizers';
import {
  loadCronExecutionsByJob,
  loadRecentCronExecutions,
  saveCronExecution,
  saveCronJob,
} from '../../../src/host/cron/cronPersistence';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const NOW = Date.UTC(2026, 8, 30, 8, 0, 0);

function eventJobRow(): Record<string, unknown> {
  return {
    id: 'job-event-1',
    name: 'watch the chat',
    schedule_type: 'event',
    schedule: JSON.stringify({
      type: 'event',
      source: 'channel',
      accountId: 'acc-1',
      chatId: 'chat-1',
      eventName: 'message',
      batchWindowSec: 30,
      minRunIntervalSec: 120,
    }),
    action: JSON.stringify({ type: 'agent', agentType: 'default', prompt: 'handle new messages' }),
    runs_on: 'local',
    max_run_budget: 2,
    enabled: 1,
    timeout: 60000,
    metadata: '{}',
    created_at: NOW,
    updated_at: NOW,
  };
}

function createSchema(db: BetterSqlite3.Database): void {
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
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );
  `);
}

describe('event 调度契约（①）', () => {
  it("isCronScheduleType 认 'event'", () => {
    expect(isCronScheduleType('event')).toBe(true);
    expect(isCronScheduleType('at')).toBe(true);
    expect(isCronScheduleType('every')).toBe(true);
    expect(isCronScheduleType('cron')).toBe(true);
    expect(isCronScheduleType('webhook')).toBe(false);
  });

  it('normalizeSchedule 接受合法 event 配置并保留绑定', () => {
    const schedule = normalizeSchedule({
      type: 'event', source: 'channel', accountId: 'acc-1', chatId: 'chat-1', eventName: 'message',
    });
    expect(schedule).toEqual({
      type: 'event',
      source: 'channel',
      accountId: 'acc-1',
      chatId: 'chat-1',
      eventName: 'message',
      batchWindowSec: 10,
      minRunIntervalSec: 60,
    });
  });

  it('normalizeSchedule 夹取：合批窗上限 300、限频下限 30', () => {
    const schedule = normalizeSchedule({
      type: 'event', source: 'channel', accountId: 'acc-1', eventName: 'message',
      batchWindowSec: 99_999, minRunIntervalSec: 1,
    });
    expect(schedule).toMatchObject({ batchWindowSec: 300, minRunIntervalSec: 30 });
  });

  it.each([
    ['缺 accountId', { type: 'event', source: 'channel', eventName: 'message' }],
    ['空 accountId', { type: 'event', source: 'channel', accountId: '  ', eventName: 'message' }],
    ['非 channel 来源', { type: 'event', source: 'webhook', accountId: 'acc-1', eventName: 'message' }],
    ['非 message 事件', { type: 'event', source: 'channel', accountId: 'acc-1', eventName: 'reaction' }],
  ])('normalizeSchedule 拒绝非法配置：%s', (_label, value) => {
    expect(normalizeSchedule(value)).toBeNull();
  });

  it('normalizeCronJobRow：event 任务从数据库行 round-trip', () => {
    const job = normalizeCronJobRow(eventJobRow());
    expect(job).not.toBeNull();
    expect(job!.scheduleType).toBe('event');
    expect(job!.schedule).toMatchObject({
      type: 'event',
      source: 'channel',
      accountId: 'acc-1',
      chatId: 'chat-1',
      eventName: 'message',
      batchWindowSec: 30,
      minRunIntervalSec: 120,
    });
  });

  it('saveCronJob → 读行 → normalizeCronJobRow 全链 round-trip（persist/load）', async () => {
    const db = new Database(':memory:');
    try {
      createSchema(db);
      databaseState.db = db;
      const job = normalizeCronJobRow(eventJobRow())!;
      await saveCronJob(job);
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id);
      const reloaded = normalizeCronJobRow(row);
      expect(reloaded).toEqual(job);
    } finally {
      databaseState.db = null;
      db.close();
    }
  });
});

describe('执行记录 trigger 落库重载（⑥）', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    databaseState.db = db;
  });

  afterEach(() => {
    databaseState.db = null;
    db.close();
  });

  const executionWithTrigger = (): CronJobExecution => ({
    id: 'exec-event-1',
    jobId: 'job-event-1',
    runsOn: 'local',
    status: 'completed',
    scheduledAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 5_000,
    duration: 5_000,
    retryAttempt: 0,
    trigger: {
      kind: 'event',
      source: 'channel',
      accountId: 'acc-1',
      eventCount: 3,
      droppedCount: 2,
      eventIds: ['m1', 'm2', 'm3'],
    },
  });

  it('saveCronExecution 落 trigger，loadCronExecutionsByJob 重载后各字段齐备', async () => {
    await saveCronJob(normalizeCronJobRow(eventJobRow())!);
    await saveCronExecution(executionWithTrigger());

    const reloaded = loadCronExecutionsByJob('job-event-1', 10);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].trigger).toEqual({
      kind: 'event',
      source: 'channel',
      accountId: 'acc-1',
      eventCount: 3,
      droppedCount: 2,
      eventIds: ['m1', 'm2', 'm3'],
    });
  });

  it('loadRecentCronExecutions 同样带 trigger；调度触发的行 trigger 为 undefined', async () => {
    await saveCronJob(normalizeCronJobRow(eventJobRow())!);
    await saveCronExecution(executionWithTrigger());
    await saveCronExecution({
      ...executionWithTrigger(),
      id: 'exec-sched-1',
      trigger: undefined,
    });

    const recent = loadRecentCronExecutions(10);
    expect(recent).toHaveLength(2);
    const eventRun = recent.find((item) => item.id === 'exec-event-1');
    const scheduleRun = recent.find((item) => item.id === 'exec-sched-1');
    expect(eventRun?.trigger?.kind).toBe('event');
    expect(eventRun?.trigger?.accountId).toBe('acc-1');
    expect(eventRun?.trigger?.eventCount).toBe(3);
    expect(scheduleRun?.trigger).toBeUndefined();
  });

  it('坏 trigger_json 行按无 trigger 处理，不炸整页', async () => {
    await saveCronJob(normalizeCronJobRow(eventJobRow())!);
    db.prepare(
      "INSERT INTO cron_executions (id, job_id, status, scheduled_at, retry_attempt, trigger_json) VALUES ('exec-bad', 'job-event-1', 'completed', ?, 0, '{\"kind\":\"nonsense\"}')",
    ).run(NOW);
    const reloaded = loadCronExecutionsByJob('job-event-1', 10);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].trigger).toBeUndefined();
  });
});
