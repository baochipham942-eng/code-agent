// N-BOOT-DB-CHECKS：启动期 FTS 投影核对按需执行。
// 钉住两条路径：指纹未变 → 跳过全表计数；指纹/强制/异常/周期 → 完整核对并补齐缺行。
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => Database,
  betterSqlite3CandidatePaths: () => [],
}));

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import {
  readProjectionSchemaBeforeBoot,
  runGatedProjectionCheck,
  type GatedProjection,
} from '../../../src/host/services/core/database/projectionCheckGate';
import { repairFtsTable } from '../../../src/host/services/core/database/ftsRepair';
import { SessionFtsRepository } from '../../../src/host/services/core/repositories/SessionFtsRepository';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

const INSERT_SESSION_SQL = `INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_MESSAGE_SQL = 'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)';

function ftsHasMessage(db: BetterSqlite3.Database, table: GatedProjection, messageId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE message_id = ?`).get(messageId));
}

function recordOf(db: BetterSqlite3.Database, projection: GatedProjection) {
  return db.prepare(`
    SELECT schema_signature, opens_since_full_check
    FROM startup_projection_checks
    WHERE projection = ?
  `).get(projection) as { schema_signature: string; opens_since_full_check: number } | undefined;
}

describe('projection check gate', () => {
  const dirs: string[] = [];
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    repairFtsTable.resetStateForTests();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-projection-gate-'));
    dirs.push(dir);
    process.env.CODE_AGENT_DATA_DIR = dir;
    return dir;
  }

  async function bootWithMessages(dir: string): Promise<void> {
    const svc = new DatabaseService(dir);
    await svc.initialize();
    const db = svc.getDb()!;
    db.prepare(INSERT_SESSION_SQL).run('sess-1', 'gate', 'openai', 'gpt-5', dir, 1, 1);
    db.prepare(INSERT_MESSAGE_SQL).run('m-1', 'sess-1', 'user', 'hello projection gate', 10);
    db.prepare(INSERT_MESSAGE_SQL).run('m-2', 'sess-1', 'assistant', 'answer projection gate', 20);
    svc.close();
  }

  describe('through DatabaseService (webServer assembly path)', () => {
    it('skips both full-table counts on the next open when the fingerprint is unchanged', async () => {
      const dir = tmpDir();
      await bootWithMessages(dir);
      const messagesCheck = vi.spyOn(SessionFtsRepository.prototype, 'backfillSessionMessagesFts');
      const transcriptCheck = vi.spyOn(SessionFtsRepository.prototype, 'backfillTranscriptFts');

      const svc = new DatabaseService(dir);
      await svc.initialize();

      expect(messagesCheck).not.toHaveBeenCalled();
      expect(transcriptCheck).not.toHaveBeenCalled();
      expect(recordOf(svc.getDb()!, 'session_messages_fts')?.opens_since_full_check).toBe(1);
      expect(recordOf(svc.getDb()!, 'transcript_fts')?.opens_since_full_check).toBe(1);
      svc.close();
    }, 60_000);

    it('re-checks and backfills rows written while triggers were dropped outside the app', async () => {
      const dir = tmpDir();
      await bootWithMessages(dir);
      const outside = new Database(path.join(dir, 'code-agent.db'));
      outside.exec('DROP TRIGGER messages_ai_fts; DROP TRIGGER transcript_ai_fts;');
      outside.prepare(INSERT_MESSAGE_SQL).run('m-lost', 'sess-1', 'user', 'written without triggers', 30);
      outside.close();

      // applySchema 会把触发器按原文重建：只有「applySchema 之前」的签名能看出这段空窗
      const svc = new DatabaseService(dir);
      await svc.initialize();
      const db = svc.getDb()!;

      expect(ftsHasMessage(db, 'session_messages_fts', 'm-lost')).toBe(true);
      expect(ftsHasMessage(db, 'transcript_fts', 'm-lost')).toBe(true);
      expect(recordOf(db, 'session_messages_fts')?.opens_since_full_check).toBe(0);
      svc.close();
    }, 60_000);

    it('re-checks when the projection was emptied outside the app with triggers intact', async () => {
      const dir = tmpDir();
      await bootWithMessages(dir);
      const outside = new Database(path.join(dir, 'code-agent.db'));
      outside.exec('DELETE FROM session_messages_fts');
      outside.close();

      const svc = new DatabaseService(dir);
      await svc.initialize();

      expect(ftsHasMessage(svc.getDb()!, 'session_messages_fts', 'm-1')).toBe(true);
      expect(ftsHasMessage(svc.getDb()!, 'session_messages_fts', 'm-2')).toBe(true);
      svc.close();
    }, 60_000);
  });

  describe('gate decisions', () => {
    function openSchemaDb(): BetterSqlite3.Database {
      const db = new Database(path.join(tmpDir(), 'code-agent.db'));
      applyTestSessionSchema(db);
      db.prepare(INSERT_SESSION_SQL).run('sess-1', 'gate', 'openai', 'gpt-5', '/tmp', 1, 1);
      db.prepare(INSERT_MESSAGE_SQL).run('m-1', 'sess-1', 'user', 'hello projection gate', 10);
      return db;
    }

    function gate(db: BetterSqlite3.Database, input: { force?: boolean; before?: string | null }) {
      const check = vi.fn((onVerified: () => void) => {
        new SessionFtsRepository(db).backfillSessionMessagesFts({ onVerified });
      });
      const outcome = runGatedProjectionCheck(db, 'session_messages_fts', {
        force: input.force ?? false,
        signatureBeforeSchema: input.before === undefined ? readProjectionSchemaBeforeBoot(db) : input.before,
        now: 1,
      }, check);
      return { outcome, check };
    }

    it('checks on first open, then skips while nothing changed', () => {
      const db = openSchemaDb();
      expect(gate(db, {}).outcome).toBe('checked');
      const second = gate(db, {});
      expect(second.outcome).toBe('skipped');
      expect(second.check).not.toHaveBeenCalled();
      db.close();
    });

    it('forces a full check after startup FTS repair even with an unchanged fingerprint', () => {
      const db = openSchemaDb();
      gate(db, {});
      expect(gate(db, { force: true }).outcome).toBe('checked');
      db.close();
    });

    it('re-checks on the next open after a runtime FTS repair left the projection empty', () => {
      const db = openSchemaDb();
      gate(db, {});
      expect(gate(db, {}).outcome).toBe('skipped');
      // 运行期写路径损坏修复：重建失败 → 空表重建成功 → 回填又失败，停在 empty 降级态；
      // 随后重试写入让 FTS 至少有 1 行，DDL 指纹也不变。
      const outcome = repairFtsTable(db, 'session_messages_fts', {
        rebuild: () => { throw new Error('rebuild failed'); },
        recreateEmpty: (database) => { database.exec('DELETE FROM session_messages_fts'); },
      });
      expect(outcome).toBe('empty-recreated');
      repairFtsTable.resetStateForTests();
      expect(recordOf(db, 'session_messages_fts')).toBeUndefined();
      expect(gate(db, {}).outcome).toBe('checked');
      db.close();
    });

    it('re-checks when the schema changed during this boot (upgrade migration)', () => {
      const db = openSchemaDb();
      gate(db, {});
      const before = readProjectionSchemaBeforeBoot(db);
      db.exec('CREATE INDEX idx_messages_upgrade_probe ON messages(role)');
      expect(gate(db, { before }).outcome).toBe('checked');
      db.close();
    });

    it('does not record a pass when the check fails, so the next open checks again', () => {
      const db = openSchemaDb();
      runGatedProjectionCheck(db, 'session_messages_fts', {
        force: false,
        signatureBeforeSchema: readProjectionSchemaBeforeBoot(db),
        now: 1,
      }, () => undefined);
      expect(recordOf(db, 'session_messages_fts')).toBeUndefined();
      expect(gate(db, {}).outcome).toBe('checked');
      db.close();
    });

    it('forces a periodic full check every 20 opens', () => {
      const db = openSchemaDb();
      gate(db, {});
      const outcomes = Array.from({ length: 20 }, () => gate(db, {}).outcome);
      expect(outcomes.slice(0, 19).every((outcome) => outcome === 'skipped')).toBe(true);
      expect(outcomes[19]).toBe('checked');
      db.close();
    });
  });
});
