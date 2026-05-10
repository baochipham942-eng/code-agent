import { describe, expect, it } from 'vitest';
import { buildGlobalTaskRecords } from '../../../src/renderer/hooks/useRunWorkbenchModel';
import type { SessionState } from '../../../src/renderer/stores/taskStore';

describe('buildGlobalTaskRecords', () => {
  it('does not mirror the current session into background tasks', () => {
    const tasks = buildGlobalTaskRecords({
      currentSessionId: 'session-current',
      sessionStates: {
        'session-current': { status: 'running' },
        'other-123456': { status: 'running' },
        idle: { status: 'idle' },
      } satisfies Record<string, SessionState>,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'global:other-123456',
      scope: 'global',
      title: '会话 other-12',
      status: 'in_progress',
      ownerRunId: null,
      sourceThreadId: 'other-123456',
    });
  });
});
