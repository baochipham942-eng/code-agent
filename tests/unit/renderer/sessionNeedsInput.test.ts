import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import {
  hasNeedsInputForSession,
  hasPendingPermissionForSession,
  hasQueuedPermissionForSession,
  hasWaitingInputBackgroundTaskForSession,
} from '../../../src/renderer/utils/sessionNeedsInput';

function permission(id: string): PermissionRequest {
  return { id, tool: 'bash' } as PermissionRequest;
}

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'task-1',
    source: 'test',
    title: 'Background task',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    events: [],
    outputRefs: [],
    ...overrides,
  } as Task;
}

describe('sessionNeedsInput', () => {
  it('detects the active permission dialog for the owning session and clears when the dialog is gone', () => {
    expect(
      hasPendingPermissionForSession('session-needs-permission', {
        pendingPermissionRequest: permission('perm-1'),
        pendingPermissionSessionId: 'session-needs-permission',
      }),
    ).toBe(true);

    expect(
      hasPendingPermissionForSession('session-needs-permission', {
        pendingPermissionRequest: null,
        pendingPermissionSessionId: null,
      }),
    ).toBe(false);
  });

  it('detects queued permission requests for the session and clears when the queue is empty', () => {
    expect(
      hasQueuedPermissionForSession('session-queued-permission', {
        queuedPermissionRequests: {
          'session-queued-permission': [permission('perm-queued')],
        },
      }),
    ).toBe(true);

    expect(
      hasQueuedPermissionForSession('session-queued-permission', {
        queuedPermissionRequests: {
          'session-queued-permission': [],
        },
      }),
    ).toBe(false);
  });

  it('detects durable background tasks waiting for input and clears after status changes', () => {
    expect(
      hasWaitingInputBackgroundTaskForSession('session-bg-waiting', [
        task({ id: 'task-waiting', sessionId: 'session-bg-waiting', status: 'waiting_input' }),
      ]),
    ).toBe(true);

    expect(
      hasWaitingInputBackgroundTaskForSession('session-bg-waiting', [
        task({ id: 'task-running', sessionId: 'session-bg-waiting', status: 'running' }),
      ]),
    ).toBe(false);
  });

  it('ORs all renderer-reachable needs-input sources without matching unrelated sessions', () => {
    expect(
      hasNeedsInputForSession('session-target', {
        permissionState: {
          pendingPermissionRequest: permission('perm-other'),
          pendingPermissionSessionId: 'session-other',
          queuedPermissionRequests: {},
        },
        backgroundTasks: [task({ id: 'task-target', sessionId: 'session-target', status: 'waiting_input' })],
      }),
    ).toBe(true);

    expect(
      hasNeedsInputForSession('session-target', {
        permissionState: {
          pendingPermissionRequest: permission('perm-other'),
          pendingPermissionSessionId: 'session-other',
          queuedPermissionRequests: {
            'session-other': [permission('perm-queued-other')],
          },
        },
        backgroundTasks: [task({ id: 'task-other', sessionId: 'session-other', status: 'waiting_input' })],
      }),
    ).toBe(false);
  });
});

