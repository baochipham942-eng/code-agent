import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { ConfigRepository } from '../../../../src/host/services/core/repositories/ConfigRepository';

const RESULT = {
  toolCallId: 'tool-result',
  success: true,
  output: 'cached read',
};

function legacyArgumentsHash(toolName: string, args: Record<string, unknown>): string {
  const value = `${toolName}:${JSON.stringify(args)}`;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash &= hash;
  }
  return hash.toString(16);
}

function freshRepository() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tool_executions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  return { db, repository: new ConfigRepository(db) };
}

describe('ConfigRepository scoped tool cache', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('binds persistent cache reads to session and versioned workspace namespace', () => {
    const { db, repository } = freshRepository();
    databases.push(db);
    const args = { file_path: 'README.md' };

    repository.saveToolExecution(
      'session-a',
      null,
      'Read',
      args,
      RESULT,
      'tool-cache:v2:/workspace/a:file-v1',
      60_000,
    );

    expect(repository.getCachedToolResult(
      'session-a',
      'tool-cache:v2:/workspace/a:file-v1',
      'Read',
      args,
    )).toEqual(RESULT);
    expect(repository.getCachedToolResult(
      'session-b',
      'tool-cache:v2:/workspace/a:file-v1',
      'Read',
      args,
    )).toBeNull();

    const storedHash = db.prepare('SELECT arguments_hash FROM tool_executions').get() as { arguments_hash: string };
    expect(storedHash.arguments_hash).toMatch(/^tool-cache:v2:[a-f0-9]{64}$/);
    expect(repository.getCachedToolResult(
      'session-a',
      'tool-cache:v2:/workspace/b:file-v1',
      'Read',
      args,
    )).toBeNull();
  });

  it('never reuses a pre-v2 persisted cache row after the upgrade', () => {
    const { db, repository } = freshRepository();
    databases.push(db);
    const args = { file_path: 'README.md' };
    db.prepare(`
      INSERT INTO tool_executions
        (id, session_id, message_id, tool_name, arguments, arguments_hash, result, success, duration, created_at, expires_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(
      'legacy-row',
      'session-a',
      'Read',
      JSON.stringify(args),
      legacyArgumentsHash('Read', args),
      JSON.stringify(RESULT),
      Date.now(),
      Date.now() + 60_000,
    );

    expect(repository.getCachedToolResult(
      'session-a',
      'tool-cache:v2:/workspace/a:file-v1',
      'Read',
      args,
    )).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS count FROM tool_executions WHERE id = ?').get('legacy-row') as { count: number }).count).toBe(1);
  });

  it('uses canonical SHA-256 arguments so key order matches and legacy 32-bit collisions do not', () => {
    const { db, repository } = freshRepository();
    databases.push(db);
    const namespace = 'tool-cache:v2:/workspace/a:file-v1';
    repository.saveToolExecution(
      'session-a',
      null,
      'Read',
      { z: 2, a: 1 },
      RESULT,
      namespace,
      60_000,
    );

    expect(repository.getCachedToolResult(
      'session-a',
      namespace,
      'Read',
      { a: 1, z: 2 },
    )).toEqual(RESULT);

    repository.saveToolExecution(
      'session-a',
      null,
      'Read',
      { file_path: 'Aa' },
      RESULT,
      namespace,
      60_000,
    );
    expect(legacyArgumentsHash('Read', { file_path: 'Aa' }))
      .toBe(legacyArgumentsHash('Read', { file_path: 'BB' }));
    expect(repository.getCachedToolResult(
      'session-a',
      namespace,
      'Read',
      { file_path: 'BB' },
    )).toBeNull();
  });

  it('invalidates only versioned cache rows for the requested session', () => {
    const { db, repository } = freshRepository();
    databases.push(db);
    const namespace = 'tool-cache:v2:/workspace/a:file-v1';
    repository.saveToolExecution('session-a', null, 'Read', { path: 'a' }, RESULT, namespace, 60_000);
    repository.saveToolExecution('session-b', null, 'Read', { path: 'b' }, RESULT, namespace, 60_000);
    db.prepare(`
      INSERT INTO tool_executions
        (id, session_id, message_id, tool_name, arguments, arguments_hash, result, success, duration, created_at, expires_at)
      VALUES ('legacy-row', 'session-a', NULL, 'Read', '{}', 'legacy-hash', '{}', 1, 0, 1, NULL)
    `).run();

    expect(repository.invalidateCachedToolResults('session-a')).toBe(1);
    const remaining = db.prepare('SELECT id, session_id, arguments_hash FROM tool_executions ORDER BY id').all() as Array<{
      id: string;
      session_id: string;
      arguments_hash: string;
    }>;
    expect(remaining).toHaveLength(2);
    expect(remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-row', session_id: 'session-a', arguments_hash: 'legacy-hash' }),
      expect.objectContaining({ session_id: 'session-b' }),
    ]));
  });
});
