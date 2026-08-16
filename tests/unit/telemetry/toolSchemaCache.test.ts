import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { ToolSchemaCache } from '../../../src/host/telemetry/toolSchemaCache';

describe('ToolSchemaCache', () => {
  let sqlite: import('better-sqlite3').Database;
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    sqlite.close();
  });

  it('stores the exact JSON once per hash', () => {
    const cache = new ToolSchemaCache();
    cache.ensureTable();
    cache.store('sha-1', '[{"name":"Read"}]');
    cache.store('sha-1', '[{"name":"changed"}]');

    expect(cache.get('sha-1')).toBe('[{"name":"Read"}]');
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM tool_schema_cache').get() as { n: number }).n).toBe(1);
  });
});
