import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTask } from '../../../src/shared/contract/planning';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveSessionTasks: vi.fn(),
    getSessionTasks: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('taskStore persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    dbState.db.isReady = true;
    dbState.db.saveSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReturnValue([]);
  });

  it('persists task changes to session-scoped storage', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');

    const task = taskStore.createTask('task-session-1', {
      subject: 'Implement persistence',
      description: 'Persist taskStore state',
      priority: 'high',
    });

    expect(dbState.db.saveSessionTasks).toHaveBeenCalledWith('task-session-1', [task]);

    taskStore.updateTask('task-session-1', task.id, { status: 'completed' });

    const lastSavedTasks = dbState.db.saveSessionTasks.mock.calls.at(-1)?.[1] as SessionTask[];
    expect(lastSavedTasks[0].status).toBe('completed');
  });

  it('hydrates persisted tasks after module reload', async () => {
    const persisted: SessionTask[] = [
      {
        id: '7',
        subject: 'Reload task',
        description: 'Survive restart',
        activeForm: 'Reloading task',
        status: 'pending',
        priority: 'normal',
        blocks: [],
        blockedBy: [],
        metadata: { source: 'test' },
        createdAt: 10,
        updatedAt: 20,
      },
    ];
    dbState.db.getSessionTasks.mockReturnValue(persisted);

    const taskStore = await import('../../../src/main/services/planning/taskStore');
    expect(taskStore.listTasks('task-session-reload')).toEqual(persisted);

    const next = taskStore.createTask('task-session-reload', {
      subject: 'Next task',
      description: 'Uses restored counter',
    });
    expect(next.id).toBe('8');
  });

  it('hydrates persisted tasks when the database becomes ready after an early read', async () => {
    const persisted: SessionTask[] = [
      {
        id: '3',
        subject: 'Late database task',
        description: 'Hydrate after DB readiness changes',
        activeForm: 'Hydrating late database task',
        status: 'pending',
        priority: 'high',
        blocks: [],
        blockedBy: [],
        metadata: { source: 'late-db' },
        createdAt: 30,
        updatedAt: 40,
      },
    ];
    dbState.db.isReady = false;
    dbState.db.getSessionTasks.mockReturnValue(persisted);

    const taskStore = await import('../../../src/main/services/planning/taskStore');

    expect(taskStore.listTasks('task-session-late-db')).toEqual([]);
    expect(dbState.db.getSessionTasks).not.toHaveBeenCalled();

    dbState.db.isReady = true;

    expect(taskStore.listTasks('task-session-late-db')).toEqual(persisted);
  });

  it('merges in-memory tasks created before delayed database hydration', async () => {
    const persisted: SessionTask[] = [
      {
        id: '3',
        subject: 'Persisted task',
        description: 'Already in durable storage',
        activeForm: 'Persisting task',
        status: 'pending',
        priority: 'normal',
        blocks: [],
        blockedBy: [],
        metadata: {},
        createdAt: 30,
        updatedAt: 40,
      },
    ];
    dbState.db.isReady = false;
    dbState.db.getSessionTasks.mockReturnValue(persisted);

    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const transient = taskStore.createTask('task-session-merge-late-db', {
      subject: 'Transient task',
      description: 'Created before DB readiness',
    });

    dbState.db.isReady = true;

    expect(taskStore.listTasks('task-session-merge-late-db')).toEqual([
      persisted[0],
      expect.objectContaining({ id: transient.id, subject: 'Transient task' }),
    ]);

    const next = taskStore.createTask('task-session-merge-late-db', {
      subject: 'Next task',
      description: 'Uses merged counter',
    });
    expect(next.id).toBe('4');
  });
});
