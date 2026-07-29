import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

type ColumnInfo = {
  name: string;
  notnull: 0 | 1;
};

describe('collaboration local schema migration', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => db.close());

  it('adds nullable cloud project and message author mappings through safeAlter', () => {
    applySchema(db, noopLogger);

    const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];

    expect(projectColumns.find((column) => column.name === 'cloud_project_id')).toMatchObject({
      notnull: 0,
    });
    expect(messageColumns.find((column) => column.name === 'author_user_id')).toMatchObject({
      notnull: 0,
    });
  });

  it('is idempotent when the schema migration runs repeatedly', () => {
    applySchema(db, noopLogger);
    applySchema(db, noopLogger);

    const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];

    expect(projectColumns.filter((column) => column.name === 'cloud_project_id')).toHaveLength(1);
    expect(messageColumns.filter((column) => column.name === 'author_user_id')).toHaveLength(1);
  });
});
