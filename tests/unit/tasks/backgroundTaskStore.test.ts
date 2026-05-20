import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { BackgroundTaskLedger } from '../../../src/main/tasks/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../src/main/tasks/backgroundTaskStore';

describe('SqliteBackgroundTaskStore', () => {
  let tempDir: string | null = null;
  let db: import('better-sqlite3').Database | null = null;

  afterEach(async () => {
    db?.close();
    db = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function createDbPath(): Promise<string> {
    tempDir = await mkdtemp(path.join(tmpdir(), 'code-agent-background-task-store-'));
    return path.join(tempDir, 'tasks.db');
  }

  it('reads shell and PTY terminal tasks back from a file-backed SQLite adapter', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);

    const store = new SqliteBackgroundTaskStore(db);
    const ledger = new BackgroundTaskLedger({ store });
    ledger.upsertTask({
      id: 'shell:shell-1',
      kind: 'shell',
      sessionId: 'session-shell',
      source: 'shell',
      title: 'npm test',
      status: 'completed',
      createdAt: 100,
      updatedAt: 200,
      startedAt: 100,
      completedAt: 200,
      durationMs: 100,
    });
    ledger.addOutputRef({
      id: 'shell:shell-1:log',
      taskId: 'shell:shell-1',
      type: 'log',
      path: '/tmp/shell-1.log',
      createdAt: 100,
    });
    ledger.upsertTask({
      id: 'pty:pty-1',
      kind: 'pty',
      sessionId: 'session-pty',
      source: 'pty',
      title: 'bash -lc npm run dev',
      status: 'failed',
      createdAt: 300,
      updatedAt: 450,
      startedAt: 300,
      completedAt: 450,
      durationMs: 150,
      failure: {
        message: 'Process exited with code 1',
        exitCode: 1,
        category: 'command_failed',
      },
    });
    db.close();
    db = null;

    db = new Database(dbPath);
    const restartedStore = new SqliteBackgroundTaskStore(db);
    const restartedLedger = new BackgroundTaskLedger({ store: restartedStore });

    expect(restartedStore.listBySession('session-shell').map((task) => task.id)).toEqual(['shell:shell-1']);
    expect(restartedLedger.getTask('shell:shell-1')).toMatchObject({
      id: 'shell:shell-1',
      kind: 'shell',
      source: 'shell',
      sessionId: 'session-shell',
      status: 'completed',
      completedAt: 200,
      outputRefs: [
        expect.objectContaining({
          id: 'shell:shell-1:log',
          path: '/tmp/shell-1.log',
        }),
      ],
    });
    expect(restartedLedger.listTasks({ source: 'pty' })).toEqual([
      expect.objectContaining({
        id: 'pty:pty-1',
        kind: 'pty',
        source: 'pty',
        status: 'failed',
        failure: expect.objectContaining({ exitCode: 1 }),
      }),
    ]);
  });

  it('projects terminal cron executions as background tasks without running cron', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cron_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration INTEGER,
        result TEXT,
        error TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO cron_jobs
        (id, name, schedule_type, schedule, action, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'job-1',
      'Nightly build',
      'cron',
      JSON.stringify({ type: 'cron', expression: '0 2 * * *' }),
      JSON.stringify({ type: 'shell', command: 'npm run build', cwd: '/repo' }),
      1,
      10,
      20,
    );
    db.prepare(`
      INSERT INTO cron_executions
        (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'exec-1',
      'job-1',
      'session-cron',
      'failed',
      1_000,
      1_100,
      1_900,
      800,
      JSON.stringify({ stdout: '', stderr: 'boom' }),
      'boom',
      0,
      1,
    );

    const ledger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
    });

    expect(ledger.getTask('cron:exec-1')).toMatchObject({
      id: 'cron:exec-1',
      kind: 'cron',
      source: 'cron',
      title: 'Nightly build',
      sessionId: 'session-cron',
      command: 'npm run build',
      cwd: '/repo',
      status: 'failed',
      completedAt: 1_900,
      failure: {
        message: 'boom',
        exitCode: 1,
        category: 'cron_failed',
      },
      metadata: expect.objectContaining({
        jobId: 'job-1',
        executionId: 'exec-1',
        actionType: 'shell',
      }),
    });
    expect(ledger.listTasks({ source: 'cron' }).map((task) => task.id)).toEqual(['cron:exec-1']);
  });

  it('drains queued notifications from a file-backed SQLite adapter after restart', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);

    const ledger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
      now: () => 500,
    });
    ledger.upsertTask({
      id: 'shell:notice-1',
      kind: 'shell',
      sessionId: 'session-notice',
      source: 'shell',
      title: 'npm run build',
      status: 'running',
      createdAt: 100,
      updatedAt: 150,
    });
    ledger.queueNotification({
      id: 'notification-1',
      taskId: 'shell:notice-1',
      sessionId: 'session-notice',
      type: 'task_completed',
      message: 'Build finished',
      createdAt: 200,
    });
    db.close();
    db = null;

    db = new Database(dbPath);
    const restartedLedger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
      now: () => 600,
    });

    expect(restartedLedger.drainNotifications('session-notice')).toEqual([
      expect.objectContaining({
        id: 'notification-1',
        taskId: 'shell:notice-1',
        sessionId: 'session-notice',
        type: 'task_completed',
        message: 'Build finished',
        deliveredAt: 600,
      }),
    ]);
    expect(restartedLedger.drainNotifications('session-notice')).toEqual([]);
  });
});
