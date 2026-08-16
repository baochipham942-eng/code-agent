import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { ContentCache } from '../../../src/host/telemetry/contentCache';

describe('ContentCache', () => {
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

  it('deduplicates canonical message content by hash', () => {
    const cache = new ContentCache();
    cache.ensureTable();
    expect(cache.store('hash-1', '{"role":"system","content":"one"}')).toBe(true);
    expect(cache.store('hash-1', '{"role":"system","content":"two"}')).toBe(true);
    expect(cache.get('hash-1')).toBe('{"role":"system","content":"one"}');
  });
});
