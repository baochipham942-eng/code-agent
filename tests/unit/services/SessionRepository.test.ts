// ============================================================================
// SessionRepository Tests (Sprint 3 Performance Optimization)
// ============================================================================
// Tests the Sprint 3 optimizations:
// - updateSession with COALESCE SQL (partial field updates)
// - saveTodos with transaction wrapping
// - saveTodos with empty array
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// We need to unmock better-sqlite3 for this test since we need a real DB
// But the global setup.ts mocks it. We'll create our own mock DB that
// properly simulates SQL behavior for the scenarios we need to test.

import { SessionRepository } from '../../../src/main/services/core/repositories/SessionRepository';

// Helper: create a minimal mock DB that supports the operations we test
function createMockDb() {
  const preparedStatements: Map<string, { sql: string }> = new Map();
  const runResults: Array<{ sql: string; params: unknown[] }> = [];
  let transactionFn: Function | null = null;

  const mockStmt = (sql: string) => ({
    run: vi.fn((...params: unknown[]) => {
      runResults.push({ sql, params });
      return { changes: 1 };
    }),
    get: vi.fn((..._params: unknown[]) => {
      // For getSession queries
      if (sql.includes('SELECT s.*')) {
        return {
          id: 'test-session-1',
          title: 'Test Session',
          generation_id: 'gen-1',
          model_provider: 'deepseek',
          model_name: 'deepseek-chat',
          working_directory: '/test',
          created_at: 1000,
          updated_at: 2000,
          message_count: 0,
          workspace: null,
          status: 'idle',
          last_token_usage: null,
          is_deleted: 0,
        };
      }
      return undefined;
    }),
    all: vi.fn(() => []),
  });

  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = mockStmt(sql);
      preparedStatements.set(sql, { sql });
      return stmt;
    }),
    exec: vi.fn(),
    transaction: vi.fn((fn: Function) => {
      transactionFn = fn;
      // Return a callable wrapper that executes the transaction fn
      return (...args: unknown[]) => fn(...args);
    }),
    // Test helpers
    _getRunResults: () => runResults,
    _clearRunResults: () => runResults.length = 0,
    _getTransactionFn: () => transactionFn,
    _getPreparedStatements: () => preparedStatements,
  };

  return db;
}

describe('SessionRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: SessionRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new SessionRepository(mockDb as any);
    mockDb._clearRunResults();
  });

  // --------------------------------------------------------------------------
  // updateSession with COALESCE (Sprint 3 optimization)
  // --------------------------------------------------------------------------
  describe('updateSession with COALESCE', () => {
    it('should use COALESCE SQL pattern', () => {
      repo.updateSession('test-session-1', { title: 'New Title' });

      // Verify prepare was called with COALESCE SQL
      const prepareCalls = mockDb.prepare.mock.calls;
      const updateCall = prepareCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('COALESCE')
      );
      expect(updateCall).toBeDefined();
    });

    it('should pass title when provided, null for unset fields', () => {
      repo.updateSession('test-session-1', { title: 'New Title' });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // First param should be the title
      expect(updateResult!.params[0]).toBe('New Title');
      // generationId not provided → should be null (COALESCE keeps existing)
      expect(updateResult!.params[1]).toBeNull();
    });

    it('should pass provider and model when modelConfig is provided', () => {
      repo.updateSession('test-session-1', {
        modelConfig: { provider: 'openai' as any, model: 'gpt-4' },
      });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // title not provided → null
      expect(updateResult!.params[0]).toBeNull();
      // provider
      expect(updateResult!.params[2]).toBe('openai');
      // model
      expect(updateResult!.params[3]).toBe('gpt-4');
    });

    it('should handle partial update with only status', () => {
      repo.updateSession('test-session-1', { status: 'active' as any });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // title, generationId, provider, model should all be null
      expect(updateResult!.params[0]).toBeNull(); // title
      expect(updateResult!.params[1]).toBeNull(); // generationId
      expect(updateResult!.params[2]).toBeNull(); // provider
      expect(updateResult!.params[3]).toBeNull(); // model
    });

    it('should serialize lastTokenUsage as JSON when provided', () => {
      const tokenUsage = { inputTokens: 100, outputTokens: 50 };
      repo.updateSession('test-session-1', {
        lastTokenUsage: tokenUsage as any,
      });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // lastTokenUsage param should be JSON string
      const lastTokenParam = updateResult!.params[8];
      expect(typeof lastTokenParam).toBe('string');
      expect(JSON.parse(lastTokenParam as string)).toEqual(tokenUsage);
    });

    it('should pass null for lastTokenUsage when not provided (COALESCE keeps existing)', () => {
      repo.updateSession('test-session-1', { title: 'Updated' });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // lastTokenUsage not provided → null (COALESCE keeps existing value)
      expect(updateResult!.params[8]).toBeNull();
    });

    it('should throw when session not found (changes === 0)', () => {
      // Override run to return changes: 0
      mockDb.prepare = vi.fn((sql: string) => ({
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
      }));
      repo = new SessionRepository(mockDb as any);

      expect(() => {
        repo.updateSession('non-existent', { title: 'Test' });
      }).toThrow('Session not found: non-existent');
    });

    it('should pass sessionId as the last parameter', () => {
      repo.updateSession('my-session-id', { title: 'Test' });

      const results = mockDb._getRunResults();
      const updateResult = results.find((r) => r.sql.includes('COALESCE'));
      expect(updateResult).toBeDefined();

      // Last param should be the sessionId
      const lastParam = updateResult!.params[updateResult!.params.length - 1];
      expect(lastParam).toBe('my-session-id');
    });
  });

  // --------------------------------------------------------------------------
  // saveTodos with transaction (Sprint 3 optimization)
  // --------------------------------------------------------------------------
  describe('saveTodos with transaction', () => {
    it('should use db.transaction for batch operations', () => {
      repo.saveTodos('test-session-1', [
        { content: 'Todo 1', status: 'pending' as any, activeForm: 'checkbox' },
        { content: 'Todo 2', status: 'done' as any, activeForm: 'checkbox' },
      ]);

      // Verify transaction was called
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it('should delete existing todos then insert new ones', () => {
      repo.saveTodos('test-session-1', [
        { content: 'New Todo', status: 'pending' as any, activeForm: 'checkbox' },
      ]);

      // Check that prepare was called with DELETE and INSERT
      const prepareCalls = mockDb.prepare.mock.calls.map((c) => c[0] as string);
      const hasDelete = prepareCalls.some((sql) => sql.includes('DELETE FROM todos'));
      const hasInsert = prepareCalls.some((sql) => sql.includes('INSERT INTO todos'));
      expect(hasDelete).toBe(true);
      expect(hasInsert).toBe(true);
    });

    it('should insert each todo with correct parameters', () => {
      const todos = [
        { content: 'First todo', status: 'pending' as any, activeForm: 'list' },
        { content: 'Second todo', status: 'done' as any, activeForm: 'checkbox' },
        { content: 'Third todo', status: 'in-progress' as any, activeForm: 'kanban' },
      ];

      repo.saveTodos('test-session-1', todos);

      // Check the run results for INSERT statements
      const results = mockDb._getRunResults();
      const insertResults = results.filter((r) => r.sql.includes('INSERT INTO todos'));
      expect(insertResults.length).toBe(3);

      // Verify content of each insert
      expect(insertResults[0].params[1]).toBe('First todo');
      expect(insertResults[1].params[1]).toBe('Second todo');
      expect(insertResults[2].params[1]).toBe('Third todo');
    });

    it('should handle empty todos array (only delete, no insert)', () => {
      repo.saveTodos('test-session-1', []);

      // Transaction should still be called
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);

      // Should have DELETE but no INSERT run results
      const results = mockDb._getRunResults();
      const deleteResults = results.filter((r) => r.sql.includes('DELETE FROM todos'));
      const insertResults = results.filter((r) => r.sql.includes('INSERT INTO todos'));
      expect(deleteResults.length).toBe(1);
      expect(insertResults.length).toBe(0);
    });

    it('should pass sessionId for DELETE', () => {
      repo.saveTodos('session-abc', []);

      const results = mockDb._getRunResults();
      const deleteResult = results.find((r) => r.sql.includes('DELETE FROM todos'));
      expect(deleteResult).toBeDefined();
      expect(deleteResult!.params[0]).toBe('session-abc');
    });
  });

  // --------------------------------------------------------------------------
  // getTodos
  // --------------------------------------------------------------------------
  describe('getTodos', () => {
    it('should query todos by sessionId', () => {
      // Override prepare to return mock todo rows
      mockDb.prepare = vi.fn((sql: string) => ({
        run: vi.fn(() => ({ changes: 1 })),
        get: vi.fn(() => undefined),
        all: vi.fn(() => {
          if (sql.includes('SELECT content, status, active_form FROM todos')) {
            return [
              { content: 'Todo 1', status: 'pending', active_form: 'checkbox' },
              { content: 'Todo 2', status: 'done', active_form: 'list' },
            ];
          }
          return [];
        }),
      }));
      repo = new SessionRepository(mockDb as any);

      const todos = repo.getTodos('test-session');
      expect(todos).toHaveLength(2);
      expect(todos[0].content).toBe('Todo 1');
      expect(todos[0].status).toBe('pending');
      expect(todos[0].activeForm).toBe('checkbox');
      expect(todos[1].content).toBe('Todo 2');
      expect(todos[1].status).toBe('done');
    });

    it('should return empty array when no todos exist', () => {
      const todos = repo.getTodos('empty-session');
      expect(todos).toEqual([]);
    });
  });
});
