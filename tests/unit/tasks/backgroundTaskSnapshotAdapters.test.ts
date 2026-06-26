import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllBackgroundTasks: vi.fn(),
  getAllPtySessions: vi.fn(),
  onBackgroundTaskLifecycleEvent: vi.fn(() => () => {}),
  onPtySessionLifecycleEvent: vi.fn(() => () => {}),
}));

vi.unmock('better-sqlite3');

vi.mock('../../../src/main/tools/modules/shell/backgroundTaskSources', () => ({
  getAllBackgroundTasks: mocks.getAllBackgroundTasks,
  getAllPtySessions: mocks.getAllPtySessions,
  onBackgroundTaskLifecycleEvent: mocks.onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent: mocks.onPtySessionLifecycleEvent,
}));

import Database from 'better-sqlite3';
import { BackgroundTaskLedger } from '../../../src/main/tasks/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../src/main/tasks/backgroundTaskStore';
import {
  installBackgroundTaskEventAdapters,
  syncBackgroundTaskSnapshotsToLedger,
} from '../../../src/main/tasks/backgroundTaskSnapshotAdapters';

describe('backgroundTaskSnapshotAdapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
  });

  it('maps shell and pty snapshots into ledger tasks with stable log refs', () => {
    mocks.getAllBackgroundTasks.mockReturnValue([
      {
        taskId: 'shell-1',
        status: 'failed',
        command: 'npm test',
        cwd: '/repo',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        startTime: 1_000,
        endTime: 2_500,
        duration: 1_500,
        exitCode: 1,
        outputFile: '/tmp/shell-1.log',
      },
    ]);
    mocks.getAllPtySessions.mockReturnValue([
      {
        sessionId: 'pty-1',
        status: 'running',
        command: 'bash',
        args: ['-lc', 'npm run dev'],
        cwd: '/repo',
        ownerSessionId: 'session-1',
        toolCallId: 'tool-2',
        startTime: 3_000,
        duration: 7_000,
        outputFile: '/tmp/pty-1.log',
        cols: 120,
        rows: 30,
      },
    ]);

    const ledger = new BackgroundTaskLedger();
    syncBackgroundTaskSnapshotsToLedger(ledger);
    syncBackgroundTaskSnapshotsToLedger(ledger);

    const shellTask = ledger.getTask('shell:shell-1');
    expect(shellTask).toMatchObject({
      kind: 'shell',
      source: 'shell',
      title: 'npm test',
      status: 'failed',
      command: 'npm test',
      cwd: '/repo',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      completedAt: 2_500,
      durationMs: 1_500,
      failure: {
        message: 'Process exited with code 1',
        exitCode: 1,
        category: 'command_failed',
      },
    });
    expect(shellTask?.outputRefs).toEqual([
      expect.objectContaining({
        id: 'shell:shell-1:log',
        type: 'log',
        path: '/tmp/shell-1.log',
      }),
    ]);

    const ptyTask = ledger.getTask('pty:pty-1');
    expect(ptyTask).toMatchObject({
      kind: 'pty',
      source: 'pty',
      title: 'bash -lc npm run dev',
      status: 'running',
      command: 'bash -lc npm run dev',
      cwd: '/repo',
      sessionId: 'session-1',
      toolCallId: 'tool-2',
      startedAt: 3_000,
      updatedAt: 10_000,
      durationMs: 7_000,
      metadata: expect.objectContaining({
        createdBy: 'neo',
        recoveryStatus: 'running-live',
        recoveryPlan: expect.objectContaining({
          status: 'running-live',
          recoverable: true,
          controlActions: ['poll', 'open_log', 'kill'],
        }),
      }),
    });
    expect(ptyTask?.outputRefs).toEqual([
      expect.objectContaining({
        id: 'pty:pty-1:log',
        type: 'log',
        path: '/tmp/pty-1.log',
      }),
    ]);

    const notifications = ledger.drainNotifications('session-1');
    expect(notifications).toEqual([
      expect.objectContaining({
        id: 'shell:shell-1:terminal:failed',
        taskId: 'shell:shell-1',
        type: 'task_failed',
        message: expect.stringContaining('npm test 失败'),
      }),
    ]);
    expect(ledger.drainNotifications('session-1')).toEqual([]);
  });

  it('installs lifecycle event adapters once and updates ledger from shell events', () => {
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    installBackgroundTaskEventAdapters(ledger);

    expect(mocks.onBackgroundTaskLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(mocks.onPtySessionLifecycleEvent).toHaveBeenCalledTimes(1);

    const shellListener = mocks.onBackgroundTaskLifecycleEvent.mock.calls[0][0];
    shellListener({
      type: 'started',
      task: {
        taskId: 'event-shell',
        status: 'running',
        command: 'npm run build',
        cwd: '/repo',
        sessionId: 'session-event',
        toolCallId: 'tool-event',
        startTime: 4_000,
        duration: 0,
        outputFile: '/tmp/event-shell.log',
      },
    });
    shellListener({
      type: 'completed',
      task: {
        taskId: 'event-shell',
        status: 'completed',
        command: 'npm run build',
        cwd: '/repo',
        sessionId: 'session-event',
        toolCallId: 'tool-event',
        startTime: 4_000,
        endTime: 5_500,
        duration: 1_500,
        exitCode: 0,
        outputFile: '/tmp/event-shell.log',
      },
    });

    expect(ledger.getTask('shell:event-shell')).toMatchObject({
      status: 'completed',
      sessionId: 'session-event',
      toolCallId: 'tool-event',
      completedAt: 5_500,
    });
    expect(ledger.drainNotifications('session-event')).toEqual([
      expect.objectContaining({
        id: 'shell:event-shell:terminal:completed',
        type: 'task_completed',
      }),
    ]);

    detach();
  });

  it('reloads persisted running shell tasks with explicit recovery status', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'background-recovery-'));
    const db = new Database(':memory:');
    try {
      const liveLog = path.join(tempDir, 'live.log');
      const deadLog = path.join(tempDir, 'dead.log');
      await writeFile(liveLog, 'live output\n', 'utf8');
      await writeFile(deadLog, 'dead output\n', 'utf8');

      const store = new SqliteBackgroundTaskStore(db);
      store.upsertTask({
        id: 'shell:live',
        kind: 'shell',
        sessionId: 'session-live',
        source: 'shell',
        title: 'npm run dev',
        command: 'npm run dev',
        status: 'running',
        createdAt: 100,
        updatedAt: 150,
        startedAt: 100,
        metadata: {
          createdBy: 'neo',
          pid: process.pid,
        },
        events: [],
        outputRefs: [{
          id: 'shell:live:log',
          taskId: 'shell:live',
          type: 'log',
          path: liveLog,
          createdAt: 100,
        }],
      });
      store.upsertTask({
        id: 'shell:dead',
        kind: 'shell',
        sessionId: 'session-dead',
        source: 'shell',
        title: 'npm run old-dev',
        command: 'npm run old-dev',
        status: 'running',
        createdAt: 200,
        updatedAt: 250,
        startedAt: 200,
        metadata: {
          createdBy: 'neo',
        },
        events: [],
        outputRefs: [{
          id: 'shell:dead:log',
          taskId: 'shell:dead',
          type: 'log',
          path: deadLog,
          createdAt: 200,
        }],
      });

      expect(store.loadTerminalTask('shell:live')).toMatchObject({
        status: 'running',
        metadata: expect.objectContaining({
          recoveryStatus: 'running-recovered',
          recoveryPlan: expect.objectContaining({
            status: 'running-recovered',
            recoverable: true,
            controlActions: ['poll', 'open_log', 'kill'],
          }),
        }),
      });
      expect(store.loadTerminalTask('shell:dead')).toMatchObject({
        status: 'orphaned',
        failure: expect.objectContaining({ category: 'dead_log_only' }),
        metadata: expect.objectContaining({
          recoveryStatus: 'dead-log-only',
          recoveryPlan: expect.objectContaining({
            status: 'dead-log-only',
            recoverable: false,
            controlActions: ['open_log', 'retry'],
          }),
        }),
      });
    } finally {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
