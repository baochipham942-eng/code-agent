#!/usr/bin/env npx tsx
// ============================================================================
// Session Test Script - Test session management without Electron
// ============================================================================

/**
 * This script tests session management using an in-memory SQLite database.
 * It bypasses Electron dependencies by directly testing the database layer.
 *
 * Usage: npx tsx scripts/test-session.ts
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

// ----------------------------------------------------------------------------
// Types (copied from shared/types.ts to avoid import issues)
// ----------------------------------------------------------------------------

type GenerationId = 'gen1' | 'gen2' | 'gen3' | 'gen4';
type ModelProvider = 'deepseek' | 'claude' | 'openai' | 'groq' | 'local' | 'zhipu' | 'qwen' | 'moonshot' | 'perplexity';

interface Session {
  id: string;
  title: string;
  generationId: GenerationId;
  modelConfig: {
    provider: ModelProvider;
    model: string;
  };
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: any[];
  toolResults?: any[];
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface StoredSession extends Session {
  messageCount: number;
}

// ----------------------------------------------------------------------------
// Test Database Service (standalone, no electron)
// ----------------------------------------------------------------------------

class TestDatabaseService {
  private db: Database.Database;
  private dbPath: string;

  constructor(testDir: string) {
    this.dbPath = path.join(testDir, 'test-session.db');

    // Ensure directory exists
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
  }

  private createTables(): void {
    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        working_directory TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Todos table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        active_form TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
    `);
  }

  // Session operations
  createSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.generationId,
      session.modelConfig.provider,
      session.modelConfig.model,
      session.workingDirectory || null,
      session.createdAt,
      session.updatedAt
    );
  }

  getSession(sessionId: string): StoredSession | null {
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.id = ?
      GROUP BY s.id
    `);
    const row = stmt.get(sessionId) as any;
    if (!row) return null;
    return this.rowToSession(row);
  }

  listSessions(limit: number = 50): StoredSession[] {
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map(row => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, generation_id = ?, model_provider = ?, model_name = ?,
          working_directory = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      updates.title ?? session.title,
      updates.generationId ?? session.generationId,
      updates.modelConfig?.provider ?? session.modelConfig.provider,
      updates.modelConfig?.model ?? session.modelConfig.model,
      updates.workingDirectory ?? session.workingDirectory,
      Date.now(),
      sessionId
    );
  }

  deleteSession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(sessionId);
  }

  private rowToSession(row: any): StoredSession {
    return {
      id: row.id,
      title: row.title,
      generationId: row.generation_id as GenerationId,
      modelConfig: {
        provider: row.model_provider as ModelProvider,
        model: row.model_name,
      },
      workingDirectory: row.working_directory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count || 0,
    };
  }

  // Message operations
  addMessage(sessionId: string, message: Message): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null
    );
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  getMessages(sessionId: string): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];
    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
    }));
  }

  // Todo operations
  saveTodos(sessionId: string, todos: TodoItem[]): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);
    const stmt = this.db.prepare(`
      INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const todo of todos) {
      stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
    }
  }

  getTodos(sessionId: string): TodoItem[] {
    const stmt = this.db.prepare(`
      SELECT content, status, active_form FROM todos WHERE session_id = ? ORDER BY id ASC
    `);
    const rows = stmt.all(sessionId) as any[];
    return rows.map(row => ({
      content: row.content,
      status: row.status,
      activeForm: row.active_form,
    }));
  }

  // Stats
  getStats() {
    const sessionCount = (this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c;
    const messageCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
    const todoCount = (this.db.prepare('SELECT COUNT(*) as c FROM todos').get() as any).c;
    return { sessionCount, messageCount, todoCount };
  }

  close(): void {
    this.db.close();
  }

  cleanup(): void {
    this.close();
    if (fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath);
    }
    // Also remove WAL files
    const walPath = this.dbPath + '-wal';
    const shmPath = this.dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  }
}

// ----------------------------------------------------------------------------
// Test Runner
// ----------------------------------------------------------------------------

async function runSessionTests(): Promise<void> {
  console.log('\n========================================');
  console.log('Session Management Test');
  console.log('========================================\n');

  const testDir = path.join(process.cwd(), '.test-data');
  const db = new TestDatabaseService(testDir);
  let passed = 0;
  let failed = 0;

  const test = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  };

  try {
    // Test 1: Create session
    console.log('1. Session CRUD Operations:');

    const session1: Session = {
      id: `session_${Date.now()}_test1`,
      title: 'Test Session 1',
      generationId: 'gen3',
      modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
      workingDirectory: '/tmp/test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    test('Create session', () => {
      db.createSession(session1);
    });

    test('Get session', () => {
      const retrieved = db.getSession(session1.id);
      if (!retrieved) throw new Error('Session not found');
      if (retrieved.title !== session1.title) throw new Error('Title mismatch');
      if (retrieved.generationId !== session1.generationId) throw new Error('Generation mismatch');
    });

    test('Update session', () => {
      db.updateSession(session1.id, { title: 'Updated Title' });
      const retrieved = db.getSession(session1.id);
      if (retrieved?.title !== 'Updated Title') throw new Error('Update failed');
    });

    test('List sessions', () => {
      const sessions = db.listSessions();
      if (sessions.length === 0) throw new Error('No sessions found');
      if (!sessions.find(s => s.id === session1.id)) throw new Error('Session not in list');
    });

    // Test 2: Message operations
    console.log('\n2. Message Operations:');

    const msg1: Message = {
      id: `msg_${Date.now()}_1`,
      role: 'user',
      content: 'Hello, world!',
      timestamp: Date.now(),
    };

    const msg2: Message = {
      id: `msg_${Date.now()}_2`,
      role: 'assistant',
      content: 'Hi there!',
      timestamp: Date.now() + 1,
      toolCalls: [{ id: 'tc1', name: 'test_tool', arguments: { arg1: 'value1' } }],
    };

    test('Add user message', () => {
      db.addMessage(session1.id, msg1);
    });

    test('Add assistant message with tool calls', () => {
      db.addMessage(session1.id, msg2);
    });

    test('Get messages', () => {
      const messages = db.getMessages(session1.id);
      if (messages.length !== 2) throw new Error(`Expected 2 messages, got ${messages.length}`);
      if (messages[0].content !== msg1.content) throw new Error('Message content mismatch');
      if (!messages[1].toolCalls) throw new Error('Tool calls not preserved');
    });

    test('Session message count updated', () => {
      const session = db.getSession(session1.id);
      if (session?.messageCount !== 2) throw new Error(`Expected messageCount 2, got ${session?.messageCount}`);
    });

    // Test 3: Todo operations
    console.log('\n3. Todo Operations:');

    const todos: TodoItem[] = [
      { content: 'Task 1', status: 'pending', activeForm: 'Working on Task 1' },
      { content: 'Task 2', status: 'in_progress', activeForm: 'Processing Task 2' },
      { content: 'Task 3', status: 'completed', activeForm: 'Completed Task 3' },
    ];

    test('Save todos', () => {
      db.saveTodos(session1.id, todos);
    });

    test('Get todos', () => {
      const retrieved = db.getTodos(session1.id);
      if (retrieved.length !== 3) throw new Error(`Expected 3 todos, got ${retrieved.length}`);
      if (retrieved[1].status !== 'in_progress') throw new Error('Todo status mismatch');
    });

    test('Update todos (replace all)', () => {
      const newTodos: TodoItem[] = [
        { content: 'New Task', status: 'pending', activeForm: 'New task form' },
      ];
      db.saveTodos(session1.id, newTodos);
      const retrieved = db.getTodos(session1.id);
      if (retrieved.length !== 1) throw new Error('Todos not replaced');
    });

    // Test 4: Multiple sessions
    console.log('\n4. Multiple Sessions:');

    const session2: Session = {
      id: `session_${Date.now()}_test2`,
      title: 'Test Session 2',
      generationId: 'gen4',
      modelConfig: { provider: 'claude', model: 'claude-3-5-sonnet' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    test('Create second session', () => {
      db.createSession(session2);
    });

    test('Sessions are independent', () => {
      db.addMessage(session2.id, {
        id: `msg_s2_${Date.now()}`,
        role: 'user',
        content: 'Message for session 2',
        timestamp: Date.now(),
      });
      const msgs1 = db.getMessages(session1.id);
      const msgs2 = db.getMessages(session2.id);
      if (msgs2.length !== 1) throw new Error('Session 2 should have 1 message');
      if (msgs1.length !== 2) throw new Error('Session 1 should still have 2 messages');
    });

    // Test 5: Delete session (cascade)
    console.log('\n5. Delete Operations:');

    test('Delete session cascades messages', () => {
      db.deleteSession(session1.id);
      const msgs = db.getMessages(session1.id);
      if (msgs.length !== 0) throw new Error('Messages should be deleted with session');
    });

    test('Delete session cascades todos', () => {
      const retrievedTodos = db.getTodos(session1.id);
      if (retrievedTodos.length !== 0) throw new Error('Todos should be deleted with session');
    });

    test('Deleted session not found', () => {
      const session = db.getSession(session1.id);
      if (session) throw new Error('Session should be deleted');
    });

    // Test 6: Stats
    console.log('\n6. Statistics:');

    test('Get stats', () => {
      const stats = db.getStats();
      console.log(`    Sessions: ${stats.sessionCount}, Messages: ${stats.messageCount}, Todos: ${stats.todoCount}`);
      if (stats.sessionCount !== 1) throw new Error('Expected 1 session after deletion');
    });

    // Cleanup
    console.log('\n7. Cleanup:');
    test('Cleanup test data', () => {
      db.cleanup();
    });

    // Summary
    console.log('\n========================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('========================================\n');

    if (failed > 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error('Fatal error:', error);
    db.cleanup();
    process.exit(1);
  }
}

// Run tests
runSessionTests();
