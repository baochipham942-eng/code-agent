import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type {
  CronJobDefinition,
  CronJobExecution,
} from '../../../src/shared/contract/cron';
import { applySchema } from '../../../src/host/services/core/database/schema';
import type { Logger } from '../../../src/host/services/core/database/schemaHelpers';
import { applySessionAutomationsNullableSourceMigration } from '../../../src/host/services/core/database/migrations/sessionAutomations';

const dbState = vi.hoisted(() => ({
  db: null as import('better-sqlite3').Database | null,
}));

const service = {
  recordCreated: vi.fn(),
  upsert: vi.fn(),
  getBySourceRef: vi.fn(),
  recordEvent: vi.fn(),
};

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => service,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => dbState.db }),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession: vi.fn() }),
}));

import {
  readCronSourceSessionId,
  getCronAutomationType,
  buildCronAutomationConfig,
  formatCronScheduleLabel,
  recordCronAutomationCreated,
  syncCronAutomationFromJob,
  recordCronAutomationArchived,
  recordCronAutomationExecution,
} from '../../../src/host/cron/cronAutomationBridge';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

const def = (over: Partial<CronJobDefinition> = {}): CronJobDefinition => ({
  id: 'job-1',
  name: 'My Job',
  scheduleType: 'every',
  schedule: { type: 'every', interval: 5, unit: 'minutes' },
  action: { type: 'shell', command: 'echo hi' },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const identityRuntime = (d: CronJobDefinition) => d;

beforeEach(() => {
  service.recordCreated.mockReset();
  service.upsert.mockReset();
  service.getBySourceRef.mockReset();
  service.recordEvent.mockReset();
  service.getBySourceRef.mockReturnValue(null);
  service.recordCreated.mockResolvedValue(undefined);
  service.recordEvent.mockResolvedValue(undefined);
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  applySchema(dbState.db, {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger);
});

afterEach(() => {
  dbState.db?.close();
  dbState.db = null;
});

describe('session_automations migration', () => {
  it('rebuilds the old NOT NULL source column as nullable without losing rows or indexes', () => {
    const migrationDb = new Database(':memory:');
    migrationDb.pragma('foreign_keys = ON');
    migrationDb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE session_automations (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        cadence_label TEXT,
        next_run_at INTEGER,
        last_run_at INTEGER,
        source_ref_id TEXT,
        result_session_id TEXT,
        config_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (result_session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_session_automations_source
        ON session_automations(source_session_id, status, next_run_at);
      CREATE INDEX idx_session_automations_ref
        ON session_automations(type, source_ref_id);
      INSERT INTO sessions (id) VALUES ('source-session');
      INSERT INTO session_automations (
        id, source_session_id, type, status, title, source_ref_id, created_at, updated_at
      ) VALUES (
        'cron:existing', 'source-session', 'cron', 'active', 'existing', 'existing', 1, 1
      );
    `);
    migrationDb.pragma('foreign_keys = OFF');
    migrationDb.prepare(`
      INSERT INTO session_automations (
        id, source_session_id, type, status, title, source_ref_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('cron:legacy-panel', '', 'cron', 'active', 'legacy panel', 'legacy-panel', 1, 1);
    migrationDb.pragma('foreign_keys = ON');

    applySessionAutomationsNullableSourceMigration(migrationDb);

    const sourceColumn = (migrationDb.pragma('table_info(session_automations)') as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === 'source_session_id');
    const indexes = migrationDb.pragma('index_list(session_automations)') as Array<{ name: string }>;
    expect(sourceColumn?.notnull).toBe(0);
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_session_automations_source',
      'idx_session_automations_ref',
    ]));
    expect(migrationDb.prepare('SELECT source_session_id FROM session_automations WHERE id = ?')
      .get('cron:existing')).toEqual({ source_session_id: 'source-session' });
    expect(migrationDb.prepare('SELECT source_session_id FROM session_automations WHERE id = ?')
      .get('cron:legacy-panel')).toEqual({ source_session_id: null });
    expect(() => migrationDb.prepare(`
      INSERT INTO session_automations (
        id, source_session_id, type, status, title, source_ref_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('cron:panel', null, 'cron', 'active', 'panel', 'panel', 2, 2)).not.toThrow();
    migrationDb.close();
  });
});

describe('readCronSourceSessionId', () => {
  it('prefers metadata.sourceSessionId', () => {
    expect(readCronSourceSessionId(def({ metadata: { sourceSessionId: 'sess-meta' } }))).toBe('sess-meta');
  });

  it('falls back to an agent action context source', () => {
    expect(
      readCronSourceSessionId(
        def({ action: { type: 'agent', agentType: 'a', prompt: 'p', context: { sourceSessionId: 'sess-ctx' } } })
      )
    ).toBe('sess-ctx');
  });

  it('returns undefined when neither source is present or blank', () => {
    expect(readCronSourceSessionId(def())).toBeUndefined();
    expect(readCronSourceSessionId(def({ metadata: { sourceSessionId: '   ' } }))).toBeUndefined();
  });
});

describe('getCronAutomationType', () => {
  it('is heartbeat for an agent action flagged as a heartbeat task', () => {
    expect(
      getCronAutomationType(
        def({ action: { type: 'agent', agentType: 'a', prompt: 'p', context: { heartbeatTask: true } } })
      )
    ).toBe('heartbeat');
  });

  it('is cron otherwise', () => {
    expect(getCronAutomationType(def())).toBe('cron');
    expect(
      getCronAutomationType(def({ action: { type: 'agent', agentType: 'a', prompt: 'p' } }))
    ).toBe('cron');
  });
});

describe('buildCronAutomationConfig', () => {
  it('defaults createdVia to "cron" and omits absent optional fields', () => {
    const config = buildCronAutomationConfig(def());
    expect(config.createdVia).toBe('cron');
    expect(config.scheduleType).toBe('every');
    expect(config.actionType).toBe('shell');
    expect(config).not.toHaveProperty('handoffPrompt');
    expect(config).not.toHaveProperty('nextStage');
  });

  it('carries through handoffPrompt and a non-empty nextStage', () => {
    const config = buildCronAutomationConfig(
      def({
        metadata: {
          createdVia: 'heartbeat',
          handoffPrompt: '  do next  ',
          nextStage: { prompt: ' go ', goal: '', title: '  ' },
        },
      })
    );
    expect(config.createdVia).toBe('heartbeat');
    expect(config.handoffPrompt).toBe('do next');
    expect(config.nextStage).toEqual({ prompt: 'go' });
  });

  it('drops a nextStage with only blank fields', () => {
    const config = buildCronAutomationConfig(def({ metadata: { nextStage: { prompt: '  ', goal: '' } } }));
    expect(config).not.toHaveProperty('nextStage');
  });
});

describe('formatCronScheduleLabel', () => {
  it('formats interval schedules with localized units', () => {
    expect(formatCronScheduleLabel({ type: 'every', interval: 3, unit: 'hours' })).toBe('每 3 小时');
  });

  it('formats a valid one-time datetime and falls back for an invalid one', () => {
    const numeric = formatCronScheduleLabel({ type: 'at', datetime: Date.UTC(2026, 0, 2, 3, 4) });
    expect(numeric).toMatch(/\d/);
    expect(formatCronScheduleLabel({ type: 'at', datetime: 'not-a-date' })).toBe('一次性');
  });

  it('formats cron expressions with optional timezone', () => {
    expect(formatCronScheduleLabel({ type: 'cron', expression: '0 9 * * *' })).toBe('0 9 * * *');
    expect(
      formatCronScheduleLabel({ type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' })
    ).toBe('0 9 * * * · Asia/Shanghai');
  });
});

describe('recordCronAutomationCreated', () => {
  it('records with null sourceSessionId when no source session (panel-created)', async () => {
    await recordCronAutomationCreated(def(), identityRuntime);
    expect(service.recordCreated).toHaveBeenCalledTimes(1);
    expect(service.recordCreated.mock.calls[0][0].sourceSessionId).toBeNull();
  });

  it('records creation with a composed id and enabled status', async () => {
    await recordCronAutomationCreated(
      def({ metadata: { sourceSessionId: 'sess' }, enabled: false }),
      identityRuntime
    );
    expect(service.recordCreated).toHaveBeenCalledTimes(1);
    const arg = service.recordCreated.mock.calls[0][0];
    expect(arg.id).toBe('cron:job-1');
    expect(arg.sourceSessionId).toBe('sess');
    expect(arg.status).toBe('paused');
    expect(arg.cadenceLabel).toBe('每 5 分钟');
  });

  it('swallows service errors', async () => {
    service.recordCreated.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordCronAutomationCreated(def({ metadata: { sourceSessionId: 'sess' } }), identityRuntime)
    ).resolves.toBeUndefined();
  });
});

describe('syncCronAutomationFromJob', () => {
  it('upserts the full automation contract, including the resolved nextRunAt', () => {
    // A resolver that injects runtime scheduling state — the upsert must carry it.
    const resolveRuntime = (d: CronJobDefinition) => ({ ...d, nextRunAt: 999_000 });
    syncCronAutomationFromJob(
      def({ id: 'job-9', name: 'Nightly', enabled: false, metadata: { sourceSessionId: 'sess' } }),
      resolveRuntime
    );
    expect(service.upsert).toHaveBeenCalledTimes(1);
    expect(service.upsert.mock.calls[0][0]).toMatchObject({
      id: 'cron:job-9',
      sourceSessionId: 'sess',
      type: 'cron',
      status: 'paused', // enabled: false
      title: 'Nightly',
      cadenceLabel: '每 5 分钟',
      nextRunAt: 999_000,
      sourceRefId: 'job-9',
      config: { createdVia: 'cron', scheduleType: 'every', actionType: 'shell' },
    });
  });

  it('syncs with null sourceSessionId when no source session (panel-created)', () => {
    syncCronAutomationFromJob(def(), identityRuntime);
    expect(service.upsert).toHaveBeenCalledTimes(1);
    expect(service.upsert.mock.calls[0][0].sourceSessionId).toBeNull();
  });
});

describe('recordCronAutomationArchived', () => {
  it('seeds a record when none exists then emits a cancelled event', async () => {
    service.getBySourceRef.mockReturnValue(null);
    await recordCronAutomationArchived(def({ metadata: { sourceSessionId: 'sess' } }));
    expect(service.upsert).toHaveBeenCalledTimes(1);
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
    expect(service.recordEvent.mock.calls[0][0]).toMatchObject({ event: 'cancelled', status: 'cancelled' });
  });

  it('skips the seed upsert when a record already exists', async () => {
    service.getBySourceRef.mockReturnValue({ id: 'existing' });
    await recordCronAutomationArchived(def({ metadata: { sourceSessionId: 'sess' } }));
    expect(service.upsert).not.toHaveBeenCalled();
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
  });
});

describe('recordCronAutomationExecution', () => {
  const exec = (over: Partial<CronJobExecution> = {}): CronJobExecution => ({
    id: 'exec-1',
    jobId: 'job-1',
    status: 'completed',
    scheduledAt: 0,
    retryAttempt: 0,
    ...over,
  });

  it('maps a completed execution to a completed event, kept active for recurring jobs', async () => {
    await recordCronAutomationExecution(
      def({ metadata: { sourceSessionId: 'sess' }, scheduleType: 'every' }),
      exec({ status: 'completed' }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.event).toBe('completed');
    expect(arg.status).toBe('completed');
    expect(arg.recordStatus).toBe('active'); // recurring → stays active
  });

  it('maps a skipped result to a skipped event', async () => {
    await recordCronAutomationExecution(
      def({ metadata: { sourceSessionId: 'sess' } }),
      exec({ status: 'completed', result: { skipped: true } }),
      identityRuntime
    );
    expect(service.recordEvent.mock.calls[0][0]).toMatchObject({ event: 'skipped', status: 'skipped' });
  });

  it('maps a failed execution and uses the event status for one-time jobs', async () => {
    // One-time job: scheduleType AND schedule must both be 'at' (no contract drift),
    // so the seeded upsert carries the real one-time cadence label.
    service.getBySourceRef.mockReturnValue(null);
    await recordCronAutomationExecution(
      def({
        metadata: { sourceSessionId: 'sess' },
        scheduleType: 'at',
        schedule: { type: 'at', datetime: Date.UTC(2026, 0, 2, 3, 4) },
        enabled: true,
      }),
      exec({ status: 'failed', error: 'boom' }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.event).toBe('failed');
    expect(arg.recordStatus).toBe('failed'); // one-time job → not kept active
    expect(arg.error).toBe('boom');
    // The seed upsert reflects the one-time schedule, not a recurring one.
    expect(service.upsert.mock.calls[0][0].cadenceLabel).not.toContain('每');
  });

  it('成功的 recurring agent 运行：记录保持 active 并打 pendingReview 标记（A4 待过目）', async () => {
    await recordCronAutomationExecution(
      def({
        metadata: { sourceSessionId: 'sess' },
        scheduleType: 'every',
        action: { type: 'agent', agentType: 'default', prompt: 'do it' },
      }),
      exec({ status: 'completed', sessionId: 'result-sess', completedAt: 1234 }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.recordStatus).toBe('active');
    expect(arg.configPatch).toEqual({ pendingReview: { resultSessionId: 'result-sess', at: 1234 } });
  });

  it('成功的一次性 agent 运行：记录状态落 pending_review', async () => {
    await recordCronAutomationExecution(
      def({
        metadata: { sourceSessionId: 'sess' },
        scheduleType: 'at',
        schedule: { type: 'at', datetime: Date.UTC(2026, 0, 2, 3, 4) },
        action: { type: 'agent', agentType: 'default', prompt: 'do it' },
      }),
      exec({ status: 'completed', sessionId: 'result-sess' }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.event).toBe('completed');
    expect(arg.recordStatus).toBe('pending_review');
    expect(arg.configPatch?.pendingReview?.resultSessionId).toBe('result-sess');
  });

  it('面板创建（无源会话）的任务在 FK 开启时落库并进入待过目', async () => {
    const automationService = new SessionAutomationService();
    service.recordCreated.mockImplementation(automationService.recordCreated.bind(automationService));
    service.upsert.mockImplementation(automationService.upsert.bind(automationService));
    service.getBySourceRef.mockImplementation(automationService.getBySourceRef.bind(automationService));
    service.recordEvent.mockImplementation(automationService.recordEvent.bind(automationService));

    dbState.db?.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('result-sess', 'Result', 'test', 'test', 1, 1);
    expect(() => automationService.upsert({
      id: 'cron:invalid-source',
      sourceSessionId: 'missing-session',
      type: 'cron',
      status: 'active',
      title: 'invalid',
    })).toThrow(/FOREIGN KEY constraint failed/);

    const panelDefinition = def({
      // 无 metadata.sourceSessionId、无 agent context：面板/CronSimpleCreate 创建形态
      scheduleType: 'every',
      action: { type: 'agent', agentType: 'default', prompt: 'do it' },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(recordCronAutomationCreated(panelDefinition, identityRuntime)).resolves.toBeUndefined();
    await expect(recordCronAutomationExecution(
      panelDefinition,
      exec({ status: 'completed', sessionId: 'result-sess', completedAt: 99 }),
      identityRuntime,
    )).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    expect(automationService.getBySourceRef('cron', 'job-1')).toMatchObject({
      sourceSessionId: null,
      status: 'active',
      config: { pendingReview: { resultSessionId: 'result-sess', at: 99 } },
    });
    expect(automationService.listPendingReview()).toHaveLength(1);
  });

  it('shell 运行与无结果会话的运行不进待过目', async () => {
    await recordCronAutomationExecution(
      def({ metadata: { sourceSessionId: 'sess' }, scheduleType: 'every' }),
      exec({ status: 'completed', sessionId: 'result-sess' }),
      identityRuntime
    );
    expect(service.recordEvent.mock.calls[0][0].configPatch).toBeUndefined();

    service.recordEvent.mockClear();
    await recordCronAutomationExecution(
      def({
        metadata: { sourceSessionId: 'sess' },
        scheduleType: 'every',
        action: { type: 'agent', agentType: 'default', prompt: 'do it' },
      }),
      exec({ status: 'completed', sessionId: undefined }),
      identityRuntime
    );
    expect(service.recordEvent.mock.calls[0][0].configPatch).toBeUndefined();
  });

  it('records execution with null sourceSessionId when no source session (panel-created)', async () => {
    await recordCronAutomationExecution(def(), exec(), identityRuntime);
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
  });
});
