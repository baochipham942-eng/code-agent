// ============================================================================
// N-TRIGGER-OBSERVE-MODE — 事件自动化「仅观察」档 + 逐事件决策台账
// ----------------------------------------------------------------------------
// ① 新建 event 自动化缺省 observe；存量记录由一次性迁移戳成 auto（迁移规则见证据档）。
// ② 观察档的通道结果回复：假通道发送器一次都不被调用，记一条 would_act（目标/摘要齐）。
//    （工具侧拦截见 tests/unit/tools/toolExecutor.observeMode.test.ts）
// ③ 5 个事件（2 acted / 1 ignored / 1 carry-limit dropped / 1 unavailable）恰好 5 条
//    记录、决策与原因正确；droppedCount 仍报 1。
// ============================================================================
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

const channelState = vi.hoisted(() => ({ sendMessage: vi.fn(), getAllAccounts: vi.fn() }));
vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({ getAllAccounts: channelState.getAllAccounts, sendMessage: channelState.sendMessage }),
}));

// 单 run 携带上限压到 3：5 个事件的批里才能出现「被携带上限丢掉」的那一条。
vi.mock('../../../src/shared/constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/shared/constants')>();
  return { ...original, CRON_EVENT_TRIGGER: { ...original.CRON_EVENT_TRIGGER, MAX_EVENTS_PER_RUN: 3 } };
});

import { applySchema } from '../../../src/host/services/core/database/schema';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { CronExecutionTrigger, CronJobDefinition } from '../../../src/shared/contract/cron';
import { saveCronJob } from '../../../src/host/cron/cronPersistence';
import { normalizeCronJobRow } from '../../../src/host/cron/cronNormalizers';
import { actionModeForNewJob, carryEventActionMode } from '../../../src/host/cron/cronEventActionModeChange';
import { deliverCronResultToChannel } from '../../../src/host/cron/cronResultDelivery';
import {
  loadCronEventDecisions,
  sqliteCronEventDecisionStore,
  type CronEventDecisionInput,
  type CronEventDecisionStore,
} from '../../../src/host/cron/cronEventDecisionLedger';
import { CronEventTrigger, type CronEventChannelSource } from '../../../src/host/cron/cronEventTrigger';
import { parseStatedEventDecisions } from '../../../src/host/cron/cronEventDecisions';
import { resolveCronEventActionMode } from '../../../src/shared/cronEventActionMode';

const NOW = Date.UTC(2026, 9, 31, 8, 0, 0);
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof applySchema>[1];

function eventJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-observe',
    name: 'watch group',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'channel', accountId: 'acc-1', chatId: 'oc_group', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: 'answer questions in this group' },
    runsOn: 'local',
    maxRunBudget: 0.5,
    enabled: true,
    resultChannel: 'feishu:oc_group',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function freshDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db, noopLogger);
  return db;
}

afterEach(() => {
  databaseState.db?.close();
  databaseState.db = null;
});

describe('① 执行档缺省值与迁移戳', () => {
  it('新建 event 自动化缺省 observe（入参里的 auto 不被采纳）；非 event 任务不带执行档', () => {
    expect(actionModeForNewJob(eventJob().schedule)).toBe('observe');
    expect(actionModeForNewJob({ type: 'cron', expression: '0 9 * * *' })).toBeUndefined();
    // 缺失字段的 event 任务按 observe 解读（fail-closed）
    expect(resolveCronEventActionMode(eventJob({ actionMode: undefined }))).toBe('observe');
    expect(resolveCronEventActionMode(eventJob({ actionMode: 'auto' }))).toBe('auto');
    expect(resolveCronEventActionMode({ schedule: { type: 'cron', expression: '* * * * *' }, actionMode: 'auto' })).toBeNull();
  });

  it('普通更新沿用原档；改绑事件源 / 从定时改成事件 → 回落 observe；离开 event → 摘掉', () => {
    const auto = eventJob({ actionMode: 'auto' });
    expect(carryEventActionMode(auto, { schedule: { ...auto.schedule, batchWindowSec: 30 } as CronJobDefinition['schedule'] })).toBe('auto');
    expect(carryEventActionMode(auto, { schedule: { ...auto.schedule, chatId: 'oc_other' } as CronJobDefinition['schedule'] })).toBe('observe');
    expect(carryEventActionMode(eventJob({ scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * *' } }), auto)).toBe('observe');
    expect(carryEventActionMode(auto, { schedule: { type: 'cron', expression: '0 9 * * *' } })).toBeUndefined();
  });

  it('迁移戳：action_mode 列首次加上时，存量 event 任务戳成 auto、定时任务保持 NULL；之后新存的 event 任务读回 observe', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER DEFAULT 0, retry_delay INTEGER DEFAULT 5000, timeout INTEGER DEFAULT 60000,
        tags TEXT, metadata TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO cron_jobs (id, name, schedule_type, schedule, action, created_at, updated_at) VALUES
        ('legacy-event', 'Legacy listener', 'event',
         '{"type":"event","source":"channel","accountId":"acc-1","eventName":"message"}',
         '{"type":"agent","agentType":"default","prompt":"reply"}', 1, 1),
        ('legacy-cron', 'Legacy cron', 'every', '{"type":"every","interval":5,"unit":"minutes"}',
         '{"type":"shell","command":"echo ok"}', 1, 1);
    `);
    applySchema(db, noopLogger);
    databaseState.db = db;

    const legacyEvent = normalizeCronJobRow(db.prepare("SELECT * FROM cron_jobs WHERE id = 'legacy-event'").get());
    const legacyCron = normalizeCronJobRow(db.prepare("SELECT * FROM cron_jobs WHERE id = 'legacy-cron'").get());
    expect(legacyEvent?.actionMode).toBe('auto');
    expect(legacyCron?.actionMode).toBeUndefined();
    expect((db.prepare("SELECT action_mode FROM cron_jobs WHERE id = 'legacy-cron'").get() as { action_mode: unknown }).action_mode).toBeNull();

    // 再跑一遍 schema（每次启动都会跑）：迁移戳只在列第一次出现时打一次，不会把新任务戳成 auto。
    await saveCronJob({ ...eventJob({ id: 'new-event', actionMode: actionModeForNewJob(eventJob().schedule) }) });
    applySchema(db, noopLogger);
    const created = normalizeCronJobRow(db.prepare("SELECT * FROM cron_jobs WHERE id = 'new-event'").get());
    expect(created?.actionMode).toBe('observe');

    // 显式切到 auto 后 round-trip 保持 auto。
    await saveCronJob({ ...eventJob({ id: 'new-event', actionMode: 'auto' }) });
    expect(normalizeCronJobRow(db.prepare("SELECT * FROM cron_jobs WHERE id = 'new-event'").get())?.actionMode).toBe('auto');
  });

  it('event 行 action_mode 为 NULL / 非法 → 读回 observe', () => {
    const db = freshDb();
    databaseState.db = db;
    db.prepare(`INSERT INTO cron_jobs (id, name, schedule_type, schedule, action, runs_on, enabled, created_at, updated_at, action_mode)
      VALUES ('nullish', 'n', 'event', ?, ?, 'local', 1, 1, 1, NULL)`).run(
      JSON.stringify(eventJob().schedule), JSON.stringify(eventJob().action),
    );
    expect(normalizeCronJobRow(db.prepare("SELECT * FROM cron_jobs WHERE id = 'nullish'").get())?.actionMode).toBe('observe');
  });
});

describe('② 观察档的通道结果回复：零发送 + 一条 would_act', () => {
  beforeEach(() => {
    channelState.sendMessage.mockReset();
    channelState.getAllAccounts.mockReset();
    channelState.getAllAccounts.mockReturnValue([{ id: 'account-uuid', name: '飞书', type: 'feishu' }]);
    channelState.sendMessage.mockResolvedValue({ success: true, messageId: 'om_1' });
  });

  it('observe：通道发送器一次都没被调用；台账记 channel_reply / 目标 / 摘要', async () => {
    const db = freshDb();
    databaseState.db = db;
    const definition = eventJob({ actionMode: 'observe' });
    await saveCronJob(definition);
    const body = '好的，周五下午三点开会，我来订会议室。'
      + '<cron_event_decision id="om_1" action="act">有人问会议时间</cron_event_decision>';

    const outcome = await deliverCronResultToChannel(definition, body, new Map(), 'run-obs-1', {
      getLatestDefinition: () => definition,
      persistAction: vi.fn(),
    });

    expect(channelState.sendMessage).not.toHaveBeenCalled();
    expect(channelState.getAllAccounts).not.toHaveBeenCalled();
    expect(outcome).toEqual({ delivered: false, observed: true });
    const rows = loadCronEventDecisions(definition.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'action',
      decision: 'would_act',
      tool: 'channel_reply',
      target: 'feishu:oc_group',
      runId: 'run-obs-1',
      // 逐事件决策标签不进「本会发出」的正文
      summary: '好的，周五下午三点开会，我来订会议室。',
    });
  });

  it('auto：照常真推（观察档拦截只对 observe 生效），推送正文剥掉逐事件决策标签', async () => {
    const db = freshDb();
    databaseState.db = db;
    const definition = eventJob({ actionMode: 'auto' });
    await saveCronJob(definition);
    await deliverCronResultToChannel(
      definition,
      '收到<cron_event_decision id="om_1" action="act">问会议时间</cron_event_decision>',
      new Map(),
      'run-auto-1',
      { getLatestDefinition: () => definition, persistAction: vi.fn() },
    );
    expect(channelState.sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group', '收到');
    expect(loadCronEventDecisions(definition.id)).toEqual([]);
  });
});

describe('③ 逐事件决策台账', () => {
  function message(id: string): ChannelMessage {
    return {
      id,
      channelId: 'feishu',
      sender: { id: 'user-1', name: '张三' },
      context: { chatId: 'oc_group', chatType: 'group' },
      content: `msg ${id}`,
      timestamp: NOW,
      ingressAuth: 'paired',
    } as ChannelMessage;
  }

  function memoryStore() {
    const rows: CronEventDecisionInput[] = [];
    const store: CronEventDecisionStore = {
      record: (batch) => { rows.push(...batch); },
      countActionsForRun: (runId) => rows.filter((row) => row.kind === 'action' && row.runId === runId).length,
    };
    return { rows, store };
  }

  it('5 个事件：2 acted、1 ignored、1 carry-limit dropped、1 unavailable → 恰好 5 条、原因正确；droppedCount 仍报 1', async () => {
    let clock = NOW;
    const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
    const advance = async (ms: number) => {
      clock += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (!timer.cleared && timer.at <= clock) { timer.cleared = true; timer.fn(); }
      }
      await new Promise((resolve) => setImmediate(resolve));
    };
    const source = new EventEmitter();
    const { rows, store } = memoryStore();
    const triggers: CronExecutionTrigger[] = [];
    const executions = [
      {
        id: 'run-1',
        status: 'completed',
        result: {
          eventDecisions: [
            { eventId: 'e1', action: 'act', reason: 'asked for the meeting time' },
            { eventId: 'e2', action: 'act', reason: 'requested the weekly report' },
            { eventId: 'e3', action: 'ignore', reason: 'small talk, nothing to do' },
          ],
        },
      },
      { id: 'run-2', status: 'failed', error: 'provider timeout after 3 retries' },
    ];
    const job = eventJob({ actionMode: 'auto' });
    const trigger = new CronEventTrigger({
      host: {
        getJobDefinitions: () => [job],
        isJobInFlight: () => false,
        executeEventJob: async (_definition, runTrigger) => {
          triggers.push(runTrigger);
          return executions.shift();
        },
      },
      channelSource: source as unknown as CronEventChannelSource,
      decisionStore: store,
      now: () => clock,
      setTimer: (fn, delayMs) => {
        const timer = { at: clock + delayMs, fn, cleared: false };
        timers.push(timer);
        return { clear: () => { timer.cleared = true; } };
      },
    });
    trigger.start();

    for (const id of ['e1', 'e2', 'e3', 'e4']) source.emit('message', 'acc-1', message(id));
    await advance(10_000);
    // 第二批：限频间隔之后才跑，这一趟 run 失败。
    source.emit('message', 'acc-1', message('e5'));
    await advance(10_000);
    await advance(60_000);
    trigger.dispose();

    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({ eventCount: 3, droppedCount: 1, eventIds: ['e1', 'e2', 'e3'] });
    expect(rows).toHaveLength(5);
    const byEvent = Object.fromEntries(rows.map((row) => [row.eventId, row]));
    expect(byEvent.e1).toMatchObject({ kind: 'event', decision: 'acted', reason: 'asked for the meeting time', runId: 'run-1' });
    expect(byEvent.e2).toMatchObject({ decision: 'acted', reason: 'requested the weekly report', runId: 'run-1' });
    expect(byEvent.e3).toMatchObject({ decision: 'ignored', reason: 'small talk, nothing to do', runId: 'run-1' });
    expect(byEvent.e4).toMatchObject({ decision: 'dropped', runId: 'run-1' });
    expect(byEvent.e4.reason).toContain('per-run carry limit (3 events)');
    expect(byEvent.e5).toMatchObject({ decision: 'unavailable', runId: 'run-2' });
    expect(byEvent.e5.reason).toBe('run failed: provider timeout after 3 retries');
  });

  it('观察档：模型说 act 的事件记 would_act（不是 acted）', async () => {
    let clock = NOW;
    let pending: (() => void) | undefined;
    const source = new EventEmitter();
    const { rows, store } = memoryStore();
    const trigger = new CronEventTrigger({
      host: {
        getJobDefinitions: () => [eventJob({ actionMode: 'observe' })],
        isJobInFlight: () => false,
        executeEventJob: async () => ({
          id: 'run-o', status: 'completed',
          result: { eventDecisions: [{ eventId: 'e1', action: 'act', reason: 'would answer the question' }] },
        }),
      },
      channelSource: source as unknown as CronEventChannelSource,
      decisionStore: store,
      now: () => clock,
      setTimer: (fn) => { pending = fn; return { clear: () => { pending = undefined; } }; },
    });
    trigger.start();
    source.emit('message', 'acc-1', message('e1'));
    clock += 10_000;
    pending?.();
    await new Promise((resolve) => setImmediate(resolve));
    trigger.dispose();
    expect(rows).toEqual([expect.objectContaining({ eventId: 'e1', decision: 'would_act', reason: 'would answer the question', runId: 'run-o' })]);
  });

  it('台账按任务有界：只保留最近 N 条', () => {
    const db = freshDb();
    databaseState.db = db;
    db.prepare(`INSERT INTO cron_jobs (id, name, schedule_type, schedule, action, runs_on, enabled, created_at, updated_at)
      VALUES ('job-observe', 'n', 'event', '{}', '{}', 'local', 1, 1, 1)`).run();
    for (let i = 0; i < 7; i += 1) {
      sqliteCronEventDecisionStore.record(
        [{ jobId: 'job-observe', kind: 'event', eventId: `e${i}`, decision: 'ignored', reason: 'r' }],
        { maxPerJob: 5, now: NOW + i },
      );
    }
    const kept = loadCronEventDecisions('job-observe');
    expect(kept.map((row) => row.eventId)).toEqual(['e6', 'e5', 'e4', 'e3', 'e2']);
  });

  it('解析模型陈述：只认合法 act/ignore 标签，理由截成一行', () => {
    const parsed = parseStatedEventDecisions([
      '<cron_event_decision id="m1" action="act">需要\n回复</cron_event_decision>',
      '<cron_event_decision id="m2" action="maybe">x</cron_event_decision>',
      '<cron_event_decision id="m3" action="IGNORE">闲聊</cron_event_decision>',
    ].join('\n'));
    expect(parsed).toEqual([
      { eventId: 'm1', action: 'act', reason: '需要 回复' },
      { eventId: 'm3', action: 'ignore', reason: '闲聊' },
    ]);
  });
});
