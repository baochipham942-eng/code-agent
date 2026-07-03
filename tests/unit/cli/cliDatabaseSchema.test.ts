// CLI schema 迁移安全回归测试（Codex audit R1-MED1）。
// 背景：messages 表的 ALTER TABLE ADD COLUMN 迁移此前裸 try/catch 吞掉所有错误——
// 若 ALTER 因锁/损坏等非「列已存在」原因失败，初始化仍视为成功，
// 首次 addMessage INSERT 会带上缺失列硬崩。锁住：只吞 duplicate column，其余上抛。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import { addColumnIfMissing, createCliTables, migrateCliSessionsTable } from '../../../src/cli/cliDatabaseSchema';

// vitest ESM 下 better-sqlite3 default import 不是构造器，走 createRequire（对齐 src/cli/database.ts）
const testRequire = Module.createRequire(import.meta.url);
const BetterSqlite3 = testRequire('better-sqlite3') as typeof import('better-sqlite3');
type BetterSqlite3Db = import('better-sqlite3').Database;

describe('CLI schema 列迁移错误处理', () => {
  let tmpDir: string;
  let db: BetterSqlite3Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-schema-'));
    db = new BetterSqlite3(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('addColumnIfMissing 吞掉 duplicate column 错误（幂等迁移）', () => {
    db.exec('CREATE TABLE t (id TEXT)');
    addColumnIfMissing(db, 'ALTER TABLE t ADD COLUMN extra TEXT');
    expect(() => addColumnIfMissing(db, 'ALTER TABLE t ADD COLUMN extra TEXT')).not.toThrow();
  });

  it('addColumnIfMissing 对非 duplicate 失败（如表不存在）上抛不吞', () => {
    expect(() => addColumnIfMissing(db, 'ALTER TABLE missing_table ADD COLUMN a TEXT')).toThrow(/no such table/i);
  });

  // Codex audit R2-MED：对称应用——sessions/compaction 迁移块同样只吞 duplicate column
  it('migrateCliSessionsTable 对非 duplicate 失败（sessions 表不存在）上抛不吞', () => {
    expect(() => migrateCliSessionsTable(db)).toThrow(/no such table/i);
  });

  it('migrateCliSessionsTable 重复执行幂等', () => {
    createCliTables(db);
    migrateCliSessionsTable(db);
    expect(() => migrateCliSessionsTable(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const required of ['status', 'workspace', 'last_token_usage', 'master_task_id']) {
      expect(names).toContain(required);
    }
  });

  it('createCliTables 重复执行幂等（老库升级不崩）', () => {
    createCliTables(db);
    expect(() => createCliTables(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const required of ['attachments', 'content_parts', 'is_meta', 'thinking', 'metadata']) {
      expect(names).toContain(required);
    }
  });
});
