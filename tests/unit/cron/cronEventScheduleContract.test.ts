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
  parseCronExecutionTrigger,
} from '../../../src/host/cron/cronNormalizers';
import { validateEventScheduleConstraints } from '../../../src/shared/cronEventValidation';
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

  it('监听标记 trigger.listen 落库重载后保留（N-TRIGGER-GROUP-LISTEN ④）', async () => {
    await saveCronJob(normalizeCronJobRow(eventJobRow())!);
    await saveCronExecution({
      ...executionWithTrigger(),
      id: 'exec-listen-1',
      trigger: {
        kind: 'event',
        source: 'channel',
        accountId: 'acc-1',
        eventCount: 2,
        droppedCount: 0,
        eventIds: ['m1', 'm2'],
        listen: true,
      },
    });

    const reloaded = loadCronExecutionsByJob('job-event-1', 10);
    const listenRun = reloaded.find((item) => item.id === 'exec-listen-1');
    expect(listenRun?.trigger).toEqual({
      kind: 'event',
      source: 'channel',
      accountId: 'acc-1',
      eventCount: 2,
      droppedCount: 0,
      eventIds: ['m1', 'm2'],
      listen: true,
    });
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

describe('connector:mail 事件调度契约（N-TRIGGER-CONNECTOR-MAIL ①⑥）', () => {
  it('normalizeSchedule 接受合法 connector:mail 配置并落默认值', () => {
    const schedule = normalizeSchedule({
      type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', eventName: 'message',
    });
    expect(schedule).toEqual({
      type: 'event',
      source: 'connector',
      connector: 'mail',
      accountId: '_icloud',
      eventName: 'message',
      pollIntervalSec: 60,
      batchWindowSec: 10,
      minRunIntervalSec: 60,
    });
    // mailbox 未显式设置时保持缺省（轮询器按 DEFAULT_MAILBOX 兜底）
    expect(schedule && 'mailbox' in schedule).toBe(false);
  });

  it('normalizeSchedule 保留显式 mailbox 并夹取 pollIntervalSec（下限 30）', () => {
    const schedule = normalizeSchedule({
      type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud',
      mailbox: 'Archive', eventName: 'message', pollIntervalSec: 5,
    });
    expect(schedule).toMatchObject({ mailbox: 'Archive', pollIntervalSec: 30 });
  });

  it.each([
    ['缺 connector 名', { type: 'event', source: 'connector', accountId: '_icloud', eventName: 'message' }],
    ['未知 connector', { type: 'event', source: 'connector', connector: 'calendar', accountId: '_icloud', eventName: 'message' }],
    ['缺 accountId', { type: 'event', source: 'connector', connector: 'mail', eventName: 'message' }],
    ['非 message 事件', { type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', eventName: 'sent' }],
  ])('normalizeSchedule 拒绝非法配置：%s', (_label, value) => {
    expect(normalizeSchedule(value)).toBeNull();
  });

  it('connector:mail 任务从数据库行 round-trip（persist/load）', async () => {
    const db = new Database(':memory:');
    try {
      createSchema(db);
      databaseState.db = db;
      const row = eventJobRow();
      row.id = 'job-mail-1';
      row.schedule = JSON.stringify({
        type: 'event',
        source: 'connector',
        connector: 'mail',
        accountId: '_icloud',
        mailbox: 'INBOX',
        eventName: 'message',
        pollIntervalSec: 120,
        batchWindowSec: 30,
        minRunIntervalSec: 90,
      });
      const job = normalizeCronJobRow(row)!;
      expect(job.schedule).toMatchObject({
        type: 'event', source: 'connector', connector: 'mail',
        accountId: '_icloud', mailbox: 'INBOX', pollIntervalSec: 120,
      });
      await saveCronJob(job);
      const persisted = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id);
      expect(normalizeCronJobRow(persisted)).toEqual(job);
    } finally {
      databaseState.db = null;
      db.close();
    }
  });

  it('mail run 的 trigger（source connector + connector mail）落库重载不丢（④）', async () => {
    const db = new Database(':memory:');
    try {
      createSchema(db);
      databaseState.db = db;
      await saveCronJob(normalizeCronJobRow(eventJobRow())!);
      await saveCronExecution({
        id: 'exec-mail-1',
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
          source: 'connector',
          connector: 'mail',
          accountId: '_icloud',
          eventCount: 2,
          droppedCount: 0,
          eventIds: ['_icloud|INBOX|1', '_icloud|INBOX|2'],
        },
      });

      const reloaded = loadCronExecutionsByJob('job-event-1', 10);
      expect(reloaded[0].trigger).toEqual({
        kind: 'event',
        source: 'connector',
        connector: 'mail',
        accountId: '_icloud',
        eventCount: 2,
        droppedCount: 0,
        eventIds: ['_icloud|INBOX|1', '_icloud|INBOX|2'],
      });
    } finally {
      databaseState.db = null;
      db.close();
    }
  });
});

describe('parseCronExecutionTrigger 的 connector 源宽容度（N-TRIGGER-CONNECTOR-MAIL）', () => {
  it('source connector + connector mail 完整保留；未知 connector 值丢弃但 source 保留', () => {
    expect(parseCronExecutionTrigger(
      '{"kind":"event","source":"connector","connector":"mail","accountId":"a","eventCount":1}',
    )).toEqual({
      kind: 'event', source: 'connector', connector: 'mail', accountId: 'a', eventCount: 1,
    });
    expect(parseCronExecutionTrigger(
      '{"kind":"event","source":"connector","connector":"calendar"}',
    )).toEqual({ kind: 'event', source: 'connector' });
    // source 白名单之外的值仍然整体丢弃（坏行按无 trigger 处理）；'webhook' 自
    // N-CRON-WEBHOOK-CLOUD-HOOK 起在白名单内，单独断言见下。
    expect(parseCronExecutionTrigger('{"kind":"event","source":"carrier"}')?.source).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// webhook 源（N-CRON-WEBHOOK-CLOUD-HOOK，验收 ①）：契约/校验/normalizer。
// 行为面（帧 → run、去重、ack、untrusted 块）见 cronWebhookRelay.test.ts。
// ----------------------------------------------------------------------------

describe('webhook 事件调度契约（N-CRON-WEBHOOK-CLOUD-HOOK ①）', () => {
  it('normalizeSchedule 接受合法 webhook 配置并落默认窗口值（无 accountId 键）', () => {
    const schedule = normalizeSchedule({ type: 'event', source: 'webhook', eventName: 'message' });
    expect(schedule).toEqual({
      type: 'event',
      source: 'webhook',
      eventName: 'message',
      batchWindowSec: 10,
      minRunIntervalSec: 60,
    });
    expect(schedule && 'accountId' in schedule).toBe(false);
  });

  it('normalizeSchedule 夹取 webhook 窗口字段（合批窗上限 300、限频下限 30）', () => {
    const schedule = normalizeSchedule({
      type: 'event', source: 'webhook', eventName: 'message',
      batchWindowSec: 99_999, minRunIntervalSec: 1,
    });
    expect(schedule).toMatchObject({ batchWindowSec: 300, minRunIntervalSec: 30 });
  });

  it.each([
    ['非 message 事件', { type: 'event', source: 'webhook', eventName: 'reaction' }],
    ['webhook 带 accountId（无账号绑定，hook URL 即绑定）', { type: 'event', source: 'webhook', accountId: 'acc-1', eventName: 'message' }],
  ])('normalizeSchedule 拒绝非法配置：%s', (_label, value) => {
    expect(normalizeSchedule(value)).toBeNull();
  });

  it('webhook 任务从数据库行 round-trip（persist/load）', async () => {
    const db = new Database(':memory:');
    try {
      createSchema(db);
      databaseState.db = db;
      const row = eventJobRow();
      row.id = 'job-hook-1';
      row.schedule = JSON.stringify({
        type: 'event',
        source: 'webhook',
        eventName: 'message',
        batchWindowSec: 30,
        minRunIntervalSec: 120,
      });
      const job = normalizeCronJobRow(row)!;
      expect(job.schedule).toEqual({
        type: 'event',
        source: 'webhook',
        eventName: 'message',
        batchWindowSec: 30,
        minRunIntervalSec: 120,
      });
      await saveCronJob(job);
      const persisted = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id);
      expect(normalizeCronJobRow(persisted)).toEqual(job);
    } finally {
      databaseState.db = null;
      db.close();
    }
  });

  it('webhook run 的 trigger（source webhook、无 accountId 键）落库重载不丢', async () => {
    const db = new Database(':memory:');
    try {
      createSchema(db);
      databaseState.db = db;
      await saveCronJob(normalizeCronJobRow(eventJobRow())!);
      await saveCronExecution({
        id: 'exec-hook-1',
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
          source: 'webhook',
          eventCount: 2,
          droppedCount: 0,
          eventIds: ['d-1', 'd-2'],
        },
      });

      const reloaded = loadCronExecutionsByJob('job-event-1', 10);
      expect(reloaded[0].trigger).toEqual({
        kind: 'event',
        source: 'webhook',
        eventCount: 2,
        droppedCount: 0,
        eventIds: ['d-1', 'd-2'],
      });
    } finally {
      databaseState.db = null;
      db.close();
    }
  });

  it('parseCronExecutionTrigger 认 webhook source', () => {
    expect(parseCronExecutionTrigger(
      '{"kind":"event","source":"webhook","eventCount":1,"eventIds":["d-1"]}',
    )).toEqual({ kind: 'event', source: 'webhook', eventCount: 1, eventIds: ['d-1'] });
  });
});

describe('webhook 事件源创建护栏（N-CRON-WEBHOOK-CLOUD-HOOK ①）', () => {
  const webhookSubject = {
    schedule: { type: 'event', source: 'webhook', eventName: 'message' },
    runsOn: 'local',
    action: { type: 'agent' },
    maxRunBudget: 1,
  };

  it('合法 webhook 配置通过（runsOn local + agent 动作 + 预算 > 0）', () => {
    expect(validateEventScheduleConstraints(webhookSubject)).toBeNull();
  });

  it.each([
    ['缺预算', { ...webhookSubject, maxRunBudget: undefined }, 'requires-budget'],
    ['cloud runsOn', { ...webhookSubject, runsOn: 'cloud' }, 'requires-local'],
    ['非 agent 动作', { ...webhookSubject, action: { type: 'shell' } }, 'agent-only'],
    ['webhook 带 accountId', { ...webhookSubject, schedule: { ...webhookSubject.schedule, accountId: 'acc-1' } }, 'invalid-schedule'],
    ['非 message 事件', { ...webhookSubject, schedule: { ...webhookSubject.schedule, eventName: 'reaction' } }, 'invalid-schedule'],
  ])('拒绝：%s', (_label, subject, reason) => {
    const violation = validateEventScheduleConstraints(subject);
    expect(violation?.reason).toBe(reason);
  });

  it('channel/connector 的既有文案逐字节不变', () => {
    // channel 源：source 不在三类已知源里时仍走 channel 文案
    expect(validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'carrier' },
      runsOn: 'local',
      action: { type: 'agent' },
      maxRunBudget: 1,
    })?.message).toBe(
      "Invalid event schedule: source must be 'channel', eventName must be 'message', and accountId must be a non-empty string.",
    );
    expect(validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'channel', eventName: 'reaction', accountId: 'acc-1' },
      runsOn: 'local',
      action: { type: 'agent' },
      maxRunBudget: 1,
    })?.message).toBe(
      "Invalid event schedule: source must be 'channel', eventName must be 'message', and accountId must be a non-empty string.",
    );
    // connector 源：缺 connector 名
    expect(validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'connector', accountId: 'acc-1', eventName: 'message' },
      runsOn: 'local',
      action: { type: 'agent' },
      maxRunBudget: 1,
    })?.message).toBe(
      "Invalid event schedule: source 'connector' requires connector 'mail', eventName 'message', and accountId must be a non-empty string.",
    );
  });
});
