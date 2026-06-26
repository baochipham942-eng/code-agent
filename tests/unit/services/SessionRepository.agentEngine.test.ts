import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { AgentEngineKind, AgentEngineSessionMetadata } from '../../../src/shared/contract/agentEngine';
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

function makeEngine(kind: Extract<AgentEngineKind, 'codex_cli' | 'claude_code'>): AgentEngineSessionMetadata {
  return {
    kind,
    cwd: `/repo/code-agent/${kind}`,
    permissionProfile: 'read_only',
    origin: 'manual',
    updatedAt: kind === 'codex_cli' ? 101 : 202
  };
}

describe('SessionRepository Agent Engine metadata', () => {
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

  it('loads old sessions without agent metadata as native', () => {
    db.prepare(
      `
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES ('old-session', 'Old session', 'openai', 'gpt-5', 1, 1)
    `
    ).run();

    expect(repo.getSession('old-session')?.engine).toEqual({
      kind: 'native',
      permissionProfile: 'default',
      origin: 'manual'
    });
  });

  it.each([['codex_cli'], ['claude_code']] as const)('saves and reloads %s cwd, permission profile, and origin', (kind) => {
    const engine = makeEngine(kind);
    repo.createSession(
      makeSession({
        id: `${kind}-session`,
        engine
      })
    );

    expect(repo.getSession(`${kind}-session`)?.engine).toEqual(engine);
  });

  it('saves and reloads the session owner user id', () => {
    repo.createSession(
      makeSession({
        id: 'owned-session',
        userId: 'user-1'
      })
    );

    expect(repo.getSession('owned-session')?.userId).toBe('user-1');
  });

  it('scopes session reads and lists by owner user id', () => {
    repo.createSession(makeSession({ id: 'user-1-session', userId: 'user-1', updatedAt: 3 }));
    repo.createSession(makeSession({ id: 'user-2-session', userId: 'user-2', updatedAt: 2 }));
    repo.createSession(makeSession({ id: 'anonymous-session', userId: null, updatedAt: 1 }));

    expect(repo.listSessions(50, 0, false, 'user-1').map((session) => session.id)).toEqual(['user-1-session']);
    expect(repo.listSessions(50, 0, false, 'user-2').map((session) => session.id)).toEqual(['user-2-session']);
    expect(repo.listSessions(50, 0, false, null).map((session) => session.id)).toEqual(['anonymous-session']);

    expect(repo.getSession('user-2-session', { userId: 'user-1' })).toBeNull();
    expect(repo.getSession('anonymous-session', { userId: null })?.id).toBe('anonymous-session');
  });

  it('updates engine metadata without changing the session model provider', () => {
    repo.createSession(
      makeSession({
        id: 'engine-switch-session',
        modelConfig: {
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro'
        } as Session['modelConfig']
      })
    );

    repo.updateSession('engine-switch-session', {
      engine: makeEngine('codex_cli')
    });

    const loaded = repo.getSession('engine-switch-session');
    expect(loaded?.engine).toEqual(makeEngine('codex_cli'));
    expect(loaded?.modelConfig).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro'
    });
  });
});
