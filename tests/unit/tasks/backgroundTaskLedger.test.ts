import { describe, expect, it } from 'vitest';
import { BackgroundTaskLedger } from '../../../src/main/tasks/backgroundTaskLedger';

function createClock(start = 1_000): [() => number, (value: number) => void] {
  let current = start;
  return [
    () => current,
    (value: number) => {
      current = value;
    },
  ];
}

describe('BackgroundTaskLedger', () => {
  it('upserts tasks and filters by session, status, and source', () => {
    const [now, setNow] = createClock();
    const ledger = new BackgroundTaskLedger({ now });

    ledger.upsertTask({
      id: 'task-a',
      sessionId: 'session-1',
      source: 'chat',
      title: 'Write brief',
      status: 'queued',
    });

    setNow(2_000);
    ledger.upsertTask({
      id: 'task-b',
      sessionId: 'session-2',
      source: 'channel',
      title: 'Summarize message',
      status: 'running',
    });

    setNow(3_000);
    const updated = ledger.upsertTask({
      id: 'task-a',
      sessionId: 'session-1',
      source: 'chat',
      title: 'Write updated brief',
      status: 'running',
      metadata: { priority: 'high' },
    });

    expect(updated).toMatchObject({
      id: 'task-a',
      sessionId: 'session-1',
      source: 'chat',
      title: 'Write updated brief',
      status: 'running',
      createdAt: 1_000,
      updatedAt: 3_000,
      startedAt: 3_000,
      metadata: { priority: 'high' },
    });

    expect(ledger.listTasks().map((task) => task.id)).toEqual(['task-a', 'task-b']);
    expect(ledger.listTasks({ sessionId: 'session-1' })).toHaveLength(1);
    expect(ledger.listTasks({ status: 'running' }).map((task) => task.id)).toEqual(['task-a', 'task-b']);
    expect(ledger.listTasks({ source: 'channel' }).map((task) => task.id)).toEqual(['task-b']);
    expect(ledger.listTasks({ sessionId: 'session-1', status: 'queued' })).toEqual([]);
  });

  it('appends events, updates task status, and keeps snapshots immutable', () => {
    const [now, setNow] = createClock(10);
    const ledger = new BackgroundTaskLedger({
      now,
      idFactory: (kind) => `${kind}-id`,
    });

    ledger.upsertTask({
      id: 'task-1',
      sessionId: 'session-1',
      source: 'chat',
      title: 'Background run',
    });

    setNow(20);
    const event = ledger.appendEvent({
      taskId: 'task-1',
      type: 'task.started',
      status: 'running',
      message: 'Started',
      metadata: { phase: 'start' },
    });

    expect(event).toEqual({
      id: 'task-event-id',
      taskId: 'task-1',
      type: 'task.started',
      status: 'running',
      message: 'Started',
      timestamp: 20,
      data: undefined,
      metadata: { phase: 'start' },
    });

    const firstSnapshot = ledger.getTask('task-1');
    expect(firstSnapshot?.events).toHaveLength(1);
    expect(firstSnapshot).toMatchObject({
      status: 'running',
      updatedAt: 20,
      startedAt: 20,
    });

    firstSnapshot?.events.push({
      id: 'external-mutation',
      taskId: 'task-1',
      type: 'bad',
      timestamp: 99,
    });

    expect(ledger.getTask('task-1')?.events).toHaveLength(1);
  });

  it('adds output refs and stamps terminal task completion from events', () => {
    const [now, setNow] = createClock(100);
    const ledger = new BackgroundTaskLedger({
      now,
      idFactory: (kind) => `${kind}-1`,
    });

    ledger.upsertTask({
      id: 'task-output',
      sessionId: 'session-output',
      source: 'chat',
      title: 'Produce artifact',
      status: 'running',
    });

    setNow(150);
    const outputRef = ledger.addOutputRef({
      taskId: 'task-output',
      type: 'artifact',
      label: 'Draft',
      uri: 'artifact://draft',
      metadata: { version: 1 },
    });

    setNow(200);
    ledger.appendEvent({
      taskId: 'task-output',
      type: 'task.completed',
      status: 'completed',
    });

    const task = ledger.getTask('task-output');
    expect(outputRef).toMatchObject({
      id: 'task-output-1',
      taskId: 'task-output',
      type: 'artifact',
      label: 'Draft',
      uri: 'artifact://draft',
      createdAt: 150,
      metadata: { version: 1 },
    });
    expect(task?.outputRefs).toHaveLength(1);
    expect(task).toMatchObject({
      status: 'completed',
      updatedAt: 200,
      completedAt: 200,
    });
  });

  it('stamps completion time for expired and orphaned tasks', () => {
    const [now, setNow] = createClock(500);
    const ledger = new BackgroundTaskLedger({ now });

    ledger.upsertTask({
      id: 'expired-task',
      source: 'automation',
      title: 'Expired automation',
      status: 'running',
    });
    ledger.upsertTask({
      id: 'orphaned-task',
      source: 'shell',
      title: 'Orphaned shell',
      status: 'running',
    });

    setNow(750);
    ledger.appendEvent({
      taskId: 'expired-task',
      type: 'task.expired',
      status: 'expired',
    });

    setNow(900);
    ledger.upsertTask({
      id: 'orphaned-task',
      status: 'orphaned',
    });

    expect(ledger.getTask('expired-task')).toMatchObject({
      status: 'expired',
      completedAt: 750,
    });
    expect(ledger.getTask('orphaned-task')).toMatchObject({
      status: 'orphaned',
      completedAt: 900,
    });
  });

  it('queues, drains, and marks notifications by session', () => {
    const [now, setNow] = createClock(1);
    let id = 0;
    const ledger = new BackgroundTaskLedger({
      now,
      idFactory: (kind) => `${kind}-${++id}`,
    });

    ledger.upsertTask({
      id: 'task-session-a',
      sessionId: 'session-a',
      source: 'chat',
      title: 'Task A',
    });
    ledger.upsertTask({
      id: 'task-session-b',
      sessionId: 'session-b',
      source: 'channel',
      title: 'Task B',
    });

    const first = ledger.queueNotification({
      id: 'notification-a',
      taskId: 'task-session-a',
      type: 'task_updated',
      message: 'Task A changed',
    });
    const duplicate = ledger.queueNotification({
      id: 'notification-a',
      taskId: 'task-session-a',
      type: 'task_updated',
      message: 'Task A changed again',
    });

    setNow(2);
    const second = ledger.queueNotification({
      taskId: 'task-session-b',
      type: 'task_completed',
      message: 'Task B completed',
    });

    setNow(3);
    const third = ledger.queueNotification({
      taskId: 'external-task',
      sessionId: 'session-a',
      type: 'custom',
      message: 'External task notice',
    });

    expect(duplicate).toEqual(first);

    setNow(4);
    expect(ledger.markNotificationDelivered(second.id)).toMatchObject({
      id: second.id,
      deliveredAt: 4,
    });

    setNow(5);
    const drained = ledger.drainNotifications('session-a');

    expect(drained.map((notification) => notification.id)).toEqual([first.id, third.id]);
    expect(drained.every((notification) => notification.deliveredAt === 5)).toBe(true);
    expect(ledger.drainNotifications('session-a')).toEqual([]);
    expect(ledger.drainNotifications('session-b')).toEqual([]);
  });

  it('rejects events, outputs, and notifications without enough task context', () => {
    const ledger = new BackgroundTaskLedger();

    expect(() => ledger.appendEvent({
      taskId: 'missing',
      type: 'task.started',
    })).toThrow('Unknown background task: missing');

    expect(() => ledger.addOutputRef({
      taskId: 'missing',
      type: 'file',
      path: '/tmp/out.txt',
    })).toThrow('Unknown background task: missing');

    expect(() => ledger.queueNotification({
      taskId: 'missing',
      type: 'custom',
      message: 'No session',
    })).toThrow('notification session id is required');
  });
});
