import { describe, expect, it } from 'vitest';
import { isPlanningServiceScopedToSession } from '../../../src/main/ipc/planning.ipc';

describe('Planning IPC session scoping', () => {
  it('allows unscoped planning requests', () => {
    expect(isPlanningServiceScopedToSession({
      getPlanDirectory: () => '/tmp/plans/session-1',
    }, null)).toBe(true);
  });

  it('accepts requests for the current session plan directory', () => {
    expect(isPlanningServiceScopedToSession({
      getPlanDirectory: () => '/tmp/plans/session-1',
    }, 'session-1')).toBe(true);
  });

  it('rejects stale plans from another session', () => {
    expect(isPlanningServiceScopedToSession({
      getPlanDirectory: () => '/tmp/plans/session-1',
    }, 'session-2')).toBe(false);
  });
});
