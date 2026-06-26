import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import type { TelemetrySession } from '../../../src/shared/contract/telemetry';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

function createTelemetrySession(id: string, userId: string | null, startTime: number): TelemetrySession {
  return {
    id,
    userId,
    title: id,
    modelProvider: 'openai',
    modelName: 'gpt-test',
    workingDirectory: '/tmp/project',
    startTime,
    turnCount: 1,
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalTokens: 2,
    estimatedCost: 0,
    totalToolCalls: 0,
    toolSuccessRate: 1,
    totalErrors: 0,
    status: 'completed',
  };
}

describe('TelemetryStorage feedback', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT
      );
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_ms INTEGER,
        turn_count INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        tool_success_rate REAL DEFAULT 0,
        total_errors INTEGER DEFAULT 0,
        session_type TEXT,
        status TEXT DEFAULT 'recording',
        agent_version TEXT,
        prompt_version TEXT,
        tool_schema_version TEXT,
        synced_at INTEGER
      );
      CREATE TABLE telemetry_feedback (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        message_id TEXT,
        rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
        comment TEXT,
        full_content TEXT,
        created_at INTEGER NOT NULL,
        synced_at INTEGER
      );
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('stores negative feedback with guarded full content and retries until synced', () => {
    const storage = new TelemetryStorage();
    storage.insertSession(createTelemetrySession('session-1', 'user-1', 100));

    const feedback = storage.recordFeedback({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'turn-1',
      rating: -1,
      fullContent: {
        assistantResponse: 'sent alice@example.com with token=secret-token from /Users/linchen/private.txt',
      },
    });

    expect(feedback?.id).toBeTruthy();
    const unsynced = storage.getUnsyncedFeedback(10, 'user-1');
    expect(unsynced).toHaveLength(1);
    expect(JSON.stringify(unsynced[0].fullContent)).not.toContain('alice@example.com');
    expect(JSON.stringify(unsynced[0].fullContent)).not.toContain('secret-token');
    expect(JSON.stringify(unsynced[0].fullContent)).not.toContain('/Users/linchen');

    storage.markFeedbackSynced([unsynced[0].id], 200);
    expect(storage.getUnsyncedFeedback(10, 'user-1')).toEqual([]);
  });

  it('scopes unsynced feedback to the active user owner', () => {
    const storage = new TelemetryStorage();
    storage.insertSession(createTelemetrySession('session-owned', 'user-1', 100));
    storage.insertSession(createTelemetrySession('session-other', 'user-2', 200));
    storage.recordFeedback({ sessionId: 'session-owned', messageId: 'm1', rating: 1 });
    storage.recordFeedback({ sessionId: 'session-other', messageId: 'm2', rating: 1 });

    expect(storage.getUnsyncedFeedback(10, 'user-1').map((item) => item.sessionId)).toEqual(['session-owned']);
  });
});
