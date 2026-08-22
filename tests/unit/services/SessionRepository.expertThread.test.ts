// N-NAMEDMATE 刀 1：findLatestExpertThreadSession ——「去 TA 的会话」续聊判定的宿主 SQL 查询。
// 夹具照 SessionRepository.agentEngine.test.ts：真 better-sqlite3 内存库（json_extract 必须真 SQL 执行）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { findLatestExpertThreadSession } from '../../../src/host/services/core/repositories/sessionRepositoryExpertThread';
import type { Session } from '../../../src/shared/contract/session';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      project_id TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat',
      origin TEXT,
      metadata TEXT,
      parent_session_id TEXT,
      source_run_id TEXT,
      agent_engine TEXT,
      read_only INTEGER NOT NULL DEFAULT 0,
      retry_of_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      workspace TEXT,
      workbench_provenance TEXT,
      status TEXT DEFAULT 'idle',
      memory_mode TEXT NOT NULL DEFAULT 'auto',
      suppressed_memory_entry_ids TEXT NOT NULL DEFAULT '[]',
      last_token_usage TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      git_branch TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL DEFAULT 0,
      is_meta INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'active',
      author_user_id TEXT,
      synced_at INTEGER
    );
  `);
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session',
    modelConfig: {
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro'
    } as Session['modelConfig'],
    workingDirectory: '/repo/code-agent',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function expertThreadMetadata(roleId: string): Session['metadata'] {
  return { expertThread: { roleId, setAt: 1 } };
}

describe('findLatestExpertThreadSession（sessionRepositoryExpertThread）', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('两条同 roleId 会话取 updated_at 最新的一条', () => {
    repo.createSession(makeSession({ id: 'older', metadata: expertThreadMetadata('牧之'), updatedAt: 10 }));
    repo.createSession(makeSession({ id: 'newer', metadata: expertThreadMetadata('牧之'), updatedAt: 20 }));

    expect(findLatestExpertThreadSession(db, '牧之')?.id).toBe('newer');
  });

  it('不匹配其他 roleId 的标记会话与无标记会话', () => {
    repo.createSession(makeSession({ id: 'other-role', metadata: expertThreadMetadata('青禾'), updatedAt: 30 }));
    repo.createSession(makeSession({ id: 'no-marker', updatedAt: 40 }));

    expect(findLatestExpertThreadSession(db, '牧之')).toBeNull();
  });

  it('已归档的专家 thread 不返回', () => {
    repo.createSession(makeSession({ id: 'archived', metadata: expertThreadMetadata('牧之'), updatedAt: 10 }));
    db.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'archived'").run();

    expect(findLatestExpertThreadSession(db, '牧之')).toBeNull();
  });

  it('已软删的专家 thread 不返回', () => {
    repo.createSession(makeSession({ id: 'deleted', metadata: expertThreadMetadata('牧之'), updatedAt: 10 }));
    db.prepare("UPDATE sessions SET is_deleted = 1 WHERE id = 'deleted'").run();

    expect(findLatestExpertThreadSession(db, '牧之')).toBeNull();
  });

  it('无任何匹配返回 null', () => {
    expect(findLatestExpertThreadSession(db, '牧之')).toBeNull();
  });

  it('按 owner 过滤：别的用户的专家 thread 不算数', () => {
    repo.createSession(makeSession({ id: 'mine', userId: 'user-1', metadata: expertThreadMetadata('牧之'), updatedAt: 10 }));
    repo.createSession(makeSession({ id: 'theirs', userId: 'user-2', metadata: expertThreadMetadata('牧之'), updatedAt: 20 }));

    expect(findLatestExpertThreadSession(db, '牧之', 'user-1')?.id).toBe('mine');
  });
});
