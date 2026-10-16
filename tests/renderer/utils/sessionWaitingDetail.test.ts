import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import {
  getSessionWaitingDetail,
  hasNeedsInputForSession,
  type SessionNeedsInputSources,
} from '../../../src/renderer/utils/sessionNeedsInput';

function permission(id: string, appName?: string, resolved = false): PermissionRequest {
  return {
    id, type: 'command', tool: 'bash', timestamp: 1, resolved,
    details: appName === undefined ? {} : { targetApp: { name: appName } },
  };
}

describe('session waiting detail', () => {
  it('uses the matching pending permission before any queued request', () => {
    expect(getSessionWaitingDetail('target', { permissionState: {
      pendingPermissionRequest: permission('pending', 'Calculator'),
      pendingPermissionSessionId: 'target',
      queuedPermissionRequests: { target: [permission('queued', 'Notes')] },
    } })).toEqual({ kind: 'permission', appName: 'Calculator' });
  });

  it('uses the first unresolved queued request when the pending request belongs to another session', () => {
    expect(getSessionWaitingDetail('target', { permissionState: {
      pendingPermissionRequest: permission('foreign', 'Safari'),
      pendingPermissionSessionId: 'other',
      queuedPermissionRequests: { target: [
        permission('resolved', 'Mail', true), permission('head', 'Calculator'), permission('later', 'Notes'),
      ] },
    } })).toEqual({ kind: 'permission', appName: 'Calculator' });
  });

  it.each([undefined, '', '  '])('keeps a permission with no app generic (%s)', (appName) => {
    expect(getSessionWaitingDetail('target', { permissionState: {
      pendingPermissionRequest: permission('pending', appName),
      pendingPermissionSessionId: 'target',
      queuedPermissionRequests: { target: [permission('later', 'Notes')] },
    } })).toEqual({ kind: 'permission' });
  });

  it('keeps a queued head without an app generic instead of borrowing a later app', () => {
    expect(getSessionWaitingDetail('target', { permissionState: {
      queuedPermissionRequests: { target: [permission('head'), permission('later', 'Notes')] },
    } })).toEqual({ kind: 'permission' });
  });

  it('ignores resolved pending and queued permissions and clears the needs-input boolean', () => {
    const sources = { permissionState: {
      pendingPermissionRequest: permission('pending', 'Mail', true),
      pendingPermissionSessionId: 'target',
      queuedPermissionRequests: { target: [permission('queued', 'Safari', true)] },
    } };
    expect(getSessionWaitingDetail('target', sources)).toBeUndefined();
    expect(hasNeedsInputForSession('target', sources)).toBe(false);
    sources.permissionState.queuedPermissionRequests.target.push(permission('active', 'Calculator'));
    expect(getSessionWaitingDetail('target', sources)).toEqual({ kind: 'permission', appName: 'Calculator' });
  });

  it.each<SessionNeedsInputSources>([
    { pendingUserQuestionsBySessionId: new Map([['target', [{ id: 'question', sessionId: 'target', questions: [], timestamp: 1 }]]]) },
    { backgroundTasks: [{ id: 'background', sessionId: 'target', status: 'waiting_input' } as Task] },
    { durableWaitingApprovalSessionIds: new Set(['target']) },
  ])('preserves other needs-input sources without matching another session: %j', (sources) => {
    expect(getSessionWaitingDetail('target', sources)).toEqual({ kind: 'other' });
    expect(getSessionWaitingDetail('other', sources)).toBeUndefined();
  });

  it('returns no detail when nothing is waiting', () => {
    expect(getSessionWaitingDetail('target')).toBeUndefined();
  });
});
