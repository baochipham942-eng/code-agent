import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SessionRepository } from '../../../src/main/services/core/repositories/SessionRepository';
import type { Message } from '../../../src/shared/contract';
import type { SessionTask } from '../../../src/shared/contract/planning';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      workbench_provenance TEXT,
      status TEXT DEFAULT 'idle',
      workspace TEXT,
      last_token_usage TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT,
      metadata TEXT,
      compaction TEXT
    );

    CREATE TABLE session_tasks (
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      active_form TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      owner TEXT,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );

    CREATE TABLE context_interventions (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'global',
      message_id TEXT NOT NULL,
      action TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id, message_id)
    );

    CREATE TABLE session_runtime_state (
      session_id TEXT PRIMARY KEY,
      compression_state_json TEXT,
      persistent_system_context_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
    VALUES ('session-1', 'Session', 'openai', 'gpt-5', 1, 1)
  `).run();
}

describe('SessionRepository runtime recovery state', () => {
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

  it('persists and reloads session tasks', () => {
    const tasks: SessionTask[] = [
      {
        id: '1',
        subject: 'Persist task',
        description: 'Task body',
        activeForm: 'Persisting task',
        status: 'in_progress',
        priority: 'high',
        owner: 'agent-a',
        blocks: ['2'],
        blockedBy: [],
        metadata: { source: 'unit' },
        createdAt: 10,
        updatedAt: 20,
      },
    ];

    repo.saveSessionTasks('session-1', tasks);

    expect(repo.getSessionTasks('session-1')).toEqual(tasks);
  });

  it('persists context interventions by session and agent', () => {
    repo.saveContextIntervention('session-1', undefined, 'msg-global', 'retain', 10);
    repo.saveContextIntervention('session-1', 'agent-a', 'msg-pin', 'pin', 20);
    repo.saveContextIntervention('session-1', 'agent-a', 'msg-drop', 'exclude', 30);
    repo.saveContextIntervention('session-1', 'agent-a', 'msg-drop', null, 40);

    expect(repo.getContextInterventions('session-1')).toEqual({
      pinned: [],
      excluded: [],
      retained: ['msg-global'],
    });
    expect(repo.getContextInterventions('session-1', 'agent-a')).toEqual({
      pinned: ['msg-pin'],
      excluded: [],
      retained: [],
    });
  });

  it('persists compression state and persistent system context together', () => {
    repo.saveSessionRuntimeState('session-1', {
      compressionStateJson: '{"commitLog":[]}',
      persistentSystemContext: ['remember this'],
    }, 100);
    repo.saveSessionRuntimeState('session-1', {
      compressionStateJson: '{"commitLog":[{"layer":"snip","operation":"snip","targetMessageIds":["m1"],"timestamp":1}]}',
    }, 200);

    expect(repo.getSessionRuntimeState('session-1')).toEqual({
      compressionStateJson: '{"commitLog":[{"layer":"snip","operation":"snip","targetMessageIds":["m1"],"timestamp":1}]}',
      persistentSystemContext: ['remember this'],
    });
  });

  it('replaces persisted messages and preserves compaction blocks', () => {
    const original: Message[] = [
      { id: 'u1', role: 'user', content: 'old', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'old answer', timestamp: 2 },
    ];
    for (const message of original) {
      repo.addMessage('session-1', message);
    }

    const compacted: Message[] = [
      {
        id: 'compact-1',
        role: 'system',
        content: 'summary',
        timestamp: 3,
        compaction: {
          type: 'compaction',
          content: 'summary',
          timestamp: 3,
          compactedMessageCount: 2,
          compactedTokenCount: 40,
        },
      },
    ];

    repo.replaceMessages('session-1', compacted, 4);

    expect(repo.getMessages('session-1')).toEqual(compacted);
  });

  it('marks crashed active sessions as interrupted or orphaned', () => {
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at, status)
      VALUES
        ('session-running', 'Running', 'openai', 'gpt-5', 1, 1, 'running'),
        ('session-paused', 'Paused', 'openai', 'gpt-5', 1, 1, 'paused'),
        ('session-queued', 'Queued', 'openai', 'gpt-5', 1, 1, 'queued'),
        ('session-idle', 'Idle', 'openai', 'gpt-5', 1, 1, 'idle')
    `).run();

    expect(repo.markCrashedActiveSessions(999)).toEqual({ interrupted: 2, orphaned: 1 });

    expect(repo.getSession('session-running')?.status).toBe('interrupted');
    expect(repo.getSession('session-paused')?.status).toBe('interrupted');
    expect(repo.getSession('session-queued')?.status).toBe('orphaned');
    expect(repo.getSession('session-idle')?.status).toBe('idle');
  });
});
