// ADR-072 K1C：遥测轮来源字段 turn_source 端到端（contract → collector → storage
// DDL/迁移 → parser → upload row）。委托轮记 'delegation'，普通轮 NULL。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyTestTelemetrySchema } from '../../utils/telemetrySchema';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import type { TelemetryTurn } from '../../../src/shared/contract/telemetry';

const storageMocks = vi.hoisted(() => ({
  storage: {
    dbOverride: null,
    getSession: vi.fn(() => null),
    insertSession: vi.fn(),
    updateSession: vi.fn(),
    insertTurn: vi.fn(),
    batchInsert: vi.fn(),
    pruneRawPayloads: vi.fn(),
    insertDiagnosticBundle: vi.fn(),
    getToolUsageStats: vi.fn(() => []),
    getToolCallsBySession: vi.fn(() => []),
    dispose: vi.fn(),
  },
}));

vi.mock('../../../src/host/telemetry/telemetryStorage', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/telemetry/telemetryStorage')>(
    '../../../src/host/telemetry/telemetryStorage',
  );
  return {
    ...actual,
    getTelemetryStorage: () => storageMocks.storage,
  };
});

import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { rowToTurn } from '../../../src/host/telemetry/telemetryStorageParsers';
import { buildTelemetryTurnUploadRow } from '../../../src/host/telemetry/telemetryUploadRow';
import { applyTelemetryTurnsMigrations } from '../../../src/host/services/core/database/migrations';

function turnFixture(overrides: Partial<TelemetryTurn> = {}): TelemetryTurn {
  return {
    id: 'turn-src-1',
    sessionId: 'session-turn-source',
    turnNumber: 1,
    startTime: 1_000,
    endTime: 2_000,
    durationMs: 1_000,
    userPrompt: '把这份对比表补完',
    userPromptTokens: 8,
    hasAttachments: false,
    attachmentCount: 0,
    agentMode: 'normal',
    effortLevel: 'high',
    modelCalls: [],
    toolCalls: [],
    assistantResponse: 'done',
    assistantResponseTokens: 4,
    totalInputTokens: 10,
    totalOutputTokens: 4,
    events: [],
    intent: { primary: 'code_generation', confidence: 0.9, method: 'rule', keywords: [] },
    outcome: {
      status: 'success',
      confidence: 0.9,
      method: 'rule',
      signals: {
        toolSuccessRate: 1, toolCallCount: 0, retryCount: 0, errorCount: 0,
        errorRecovered: 0, compactionTriggered: false, circuitBreakerTripped: false, nudgesInjected: 0,
      },
    },
    compactionOccurred: false,
    iterationCount: 1,
    turnType: 'user',
    ...overrides,
  };
}

describe('telemetry turn_source（ADR-072 K1C）', () => {
  describe('collector：startTurn 收 turnSource，落库带出', () => {
    let collector: TelemetryCollector | null = null;

    afterEach(async () => {
      await collector?.dispose();
      collector = null;
    });

    function startSessionAndTurn(turnSource?: 'delegation'): void {
      collector = new TelemetryCollector();
      collector.startSession('session-turn-source', {
        title: 'turn source',
        modelProvider: 'test',
        modelName: 'test-model',
        workingDirectory: '/tmp/workbench',
      });
      collector.startTurn('session-turn-source', 'turn-src-1', 1, '把这份对比表补完', 'main', undefined, turnSource);
    }

    it('委托轮 startTurn(…, turnSource) → endTurn 落库的 turn 带 turnSource=delegation', () => {
      startSessionAndTurn('delegation');
      collector!.endTurn('session-turn-source', 'turn-src-1', 'done', undefined, undefined);
      expect(storageMocks.storage.insertTurn).toHaveBeenCalledWith(expect.objectContaining({
        id: 'turn-src-1',
        turnSource: 'delegation',
      }));
    });

    it('普通轮不设 turnSource（落库 NULL，不是空串）', () => {
      startSessionAndTurn(undefined);
      collector!.endTurn('session-turn-source', 'turn-src-1', 'done', undefined, undefined);
      const turn = storageMocks.storage.insertTurn.mock.calls.at(-1)![0] as TelemetryTurn;
      expect('turnSource' in turn && turn.turnSource !== undefined).toBe(false);
    });

    it('adapter.onTurnStart 第 5 参透传 turnSource（conversationRuntime → collector）', () => {
      collector = new TelemetryCollector();
      collector.startSession('session-turn-source', {
        title: 'adapter passthrough',
        modelProvider: 'test',
        modelName: 'test-model',
        workingDirectory: '/tmp/workbench',
      });
      const adapter = collector.createAdapter('session-turn-source', 'main');
      adapter.onTurnStart('turn-src-1', 1, '委托正文', undefined, 'delegation');
      adapter.onTurnEnd('turn-src-1', 'done');
      expect(storageMocks.storage.insertTurn).toHaveBeenCalledWith(expect.objectContaining({
        id: 'turn-src-1',
        turnSource: 'delegation',
      }));
    });
  });

  describe('storage：turn_source 列端到端', () => {
    let sqlite: BetterSqlite3.Database;
    let database: ReturnType<typeof getDatabase>;
    let originalGetDb: typeof database.getDb;
    let storage: TelemetryStorage;

    beforeEach(() => {
      sqlite = new Database(':memory:');
      applyTestTelemetrySchema(sqlite);
      database = getDatabase();
      originalGetDb = database.getDb.bind(database);
      vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
      database.getDb = () => sqlite as never;
      storage = new TelemetryStorage();
    });

    afterEach(() => {
      database.getDb = originalGetDb;
      vi.restoreAllMocks();
      sqlite.close();
    });

    it('insertTurn 写 turn_source，rowToTurn 读回；普通轮 NULL/undefined', () => {
      storage.insertTurn(turnFixture({ turnSource: 'delegation' }));
      storage.insertTurn(turnFixture({ id: 'turn-src-plain', turnSource: undefined }));

      const delegatedRow = sqlite
        .prepare('SELECT turn_source FROM telemetry_turns WHERE id = ?')
        .get('turn-src-1') as { turn_source: string | null };
      const plainRow = sqlite
        .prepare('SELECT turn_source FROM telemetry_turns WHERE id = ?')
        .get('turn-src-plain') as { turn_source: string | null };
      expect(delegatedRow.turn_source).toBe('delegation');
      expect(plainRow.turn_source).toBeNull();

      const parsed = sqlite
        .prepare('SELECT * FROM telemetry_turns WHERE id = ?')
        .get('turn-src-1') as Record<string, unknown>;
      expect(rowToTurn(parsed).turnSource).toBe('delegation');
      const parsedPlain = sqlite
        .prepare('SELECT * FROM telemetry_turns WHERE id = ?')
        .get('turn-src-plain') as Record<string, unknown>;
      expect(rowToTurn(parsedPlain).turnSource).toBeUndefined();
    });

    it('存量库（无 turn_source 列）经 turns 迁移补列，老行读回 NULL', () => {
      const legacy = new Database(':memory:');
      // 旧 DDL：turn_source 加入前的形状（telemetryDdlDriftGuard 钉住的新形状不含它）
      legacy.exec(`
        CREATE TABLE telemetry_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_number INTEGER,
          start_time INTEGER,
          end_time INTEGER,
          duration_ms INTEGER,
          user_prompt TEXT,
          agent_mode TEXT,
          effort_level TEXT,
          assistant_response TEXT,
          total_input_tokens INTEGER,
          total_output_tokens INTEGER,
          intent_primary TEXT,
          intent_confidence REAL,
          intent_method TEXT,
          outcome_status TEXT,
          outcome_confidence REAL,
          outcome_method TEXT,
          compaction_occurred INTEGER,
          iteration_count INTEGER,
          turn_type TEXT,
          parent_turn_id TEXT
        );
      `);
      legacy.prepare(`INSERT INTO telemetry_turns (id, session_id, turn_number) VALUES ('legacy-1', 's', 1)`).run();
      applyTelemetryTurnsMigrations(legacy, { info: () => {}, warn: () => {}, error: () => {} } as never);
      const columns = (legacy.prepare('PRAGMA table_info(telemetry_turns)').all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toContain('turn_source');
      const legacyRow = legacy
        .prepare('SELECT turn_source FROM telemetry_turns WHERE id = ?')
        .get('legacy-1') as { turn_source: string | null };
      expect(legacyRow.turn_source).toBeNull();
      legacy.close();
    });
  });

  describe('upload row：turn_source 随上传行输出', () => {
    it('委托轮输出 turn_source=delegation；普通轮输出 null', () => {
      expect(buildTelemetryTurnUploadRow(turnFixture({ turnSource: 'delegation' }), 's', 'u', '/home/leo'))
        .toMatchObject({ id: 'turn-src-1', turn_source: 'delegation' });
      expect(buildTelemetryTurnUploadRow(turnFixture(), 's', 'u', '/home/leo'))
        .toMatchObject({ id: 'turn-src-1', turn_source: null });
    });
  });
});
