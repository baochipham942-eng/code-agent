// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — 启动回填幂等
// 只读 sessions.title 写 telemetry_sessions.title：非默认标题且与遥测不一致才写
// （过 guardTelemetryText），已一致的行不动，sessions 侧仍是占位的行也不动。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 全局 mock 了 better-sqlite3；本文件要真实 SQLite 行为
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import { guardTelemetryText } from '../../../src/host/telemetry/telemetryStorageParsers';
import { backfillTelemetrySessionTitles } from '../../../src/host/telemetry/telemetrySessionTitleBackfill';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function insertTelemetry(db: Database.Database, id: string, title: string): void {
  db.prepare(
    'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, title, 'deepseek', 'deepseek-chat', '/ws', 1, 'completed');
}

function insertChat(db: Database.Database, id: string, title: string): void {
  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
    VALUES (?, ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
  `).run(id, title);
}

function storedTitle(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT title FROM telemetry_sessions WHERE id = ?').get(id) as { title: string | null } | undefined;
  return row?.title ?? null;
}

describe('backfillTelemetrySessionTitles 启动回填', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, LOGGER);
    applyTelemetrySchema(db, LOGGER);
  });

  it('遥测占位 + sessions 真标题 → 回填为脱敏后的值；重跑幂等（已一致不动）', () => {
    insertTelemetry(db, 's1', 'CLI Session');
    insertChat(db, 's1', '帮我修登录页 sk-proj-abcdefghij1234567890');

    const first = backfillTelemetrySessionTitles(db);
    expect(first).toBe(1);
    const expected = guardTelemetryText('帮我修登录页 sk-proj-abcdefghij1234567890', 2_000);
    expect(expected).not.toBe('帮我修登录页 sk-proj-abcdefghij1234567890');
    expect(storedTitle(db, 's1')).toBe(expected);

    // 幂等：全一致时不再写任何行
    expect(backfillTelemetrySessionTitles(db)).toBe(0);
    expect(storedTitle(db, 's1')).toBe(expected);
  });

  it('sessions 侧仍是占位命名的行不动（别拿 New Chat 砸掉遥测里的首条消息快照）', () => {
    insertTelemetry(db, 'keep-1', '第一条消息的前 80 字快照');
    insertChat(db, 'keep-1', 'New Chat');
    insertTelemetry(db, 'keep-2', 'CLI Session');
    insertChat(db, 'keep-2', 'CLI Session 2026/9/7 上午10:00:00');
    insertTelemetry(db, 'keep-3', '另一条快照');
    insertChat(db, 'keep-3', '新对话');

    expect(backfillTelemetrySessionTitles(db)).toBe(0);
    expect(storedTitle(db, 'keep-1')).toBe('第一条消息的前 80 字快照');
    expect(storedTitle(db, 'keep-2')).toBe('CLI Session');
    expect(storedTitle(db, 'keep-3')).toBe('另一条快照');
  });

  it('sessions 行不存在（会话已删/CLI 纯遥测）的行不动', () => {
    insertTelemetry(db, 'orphan', 'CLI Session');

    expect(backfillTelemetrySessionTitles(db)).toBe(0);
    expect(storedTitle(db, 'orphan')).toBe('CLI Session');
  });
});
