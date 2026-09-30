// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  members: [] as Array<{
    key: string;
    roleId: string;
    name: string;
    status: 'running';
    isLead: boolean;
  }>,
  pending: null as null | {
    id: string;
    tool: string;
    type: 'command';
    agentId?: string;
    runId?: string;
    details: Record<string, never>;
    timestamp: number;
    resolved?: boolean;
  },
  pendingSessionId: 'session-1' as string | null,
  activeAgentId: null as string | null,
  queued: {} as Record<string, Array<{
    id: string;
    tool: string;
    type: 'command';
    agentId?: string;
    details: Record<string, never>;
    timestamp: number;
  }>>,
}));

vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => runtime.members,
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: async () => {} }),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: never[] }) => unknown) =>
    selector({ tasks: [] }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: {
    pendingPermissionRequest: typeof runtime.pending;
    pendingPermissionSessionId: string | null;
    queuedPermissionRequests: typeof runtime.queued;
    activeAgentId: string | null;
  }) => unknown) => selector({
    pendingPermissionRequest: runtime.pending,
    pendingPermissionSessionId: runtime.pendingSessionId,
    queuedPermissionRequests: runtime.queued,
    activeAgentId: runtime.activeAgentId,
  }),
}));

import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';

function holdFor(key: string): string | undefined {
  return renderHook(() => useSessionAgentRows('session-1')).result.current.rows.find((row) => row.key === key)?.hold;
}

describe('useSessionAgentRows approval holds', () => {
  afterEach(() => {
    cleanup();
  });

  function seed(): void {
    runtime.members = [
      { key: 'default', roleId: 'default', name: 'Main', status: 'running', isLead: true },
      { key: 'role-writer', roleId: 'role-writer', name: 'Writer', status: 'running', isLead: false },
      { key: 'agent_child_1', roleId: 'scout', name: 'Scout', status: 'running', isLead: false },
    ];
    runtime.pendingSessionId = 'session-1';
    runtime.activeAgentId = 'role-writer';
    runtime.queued = {};
    runtime.pending = {
      id: 'req-1',
      tool: 'Bash',
      type: 'command',
      details: {},
      timestamp: 1,
    };
  }

  it('does not count default or the routed main agent as awaiting approval', () => {
    seed();
    runtime.pending = { ...runtime.pending!, agentId: 'default' };
    expect(holdFor('default')).toBeUndefined();

    cleanup();
    runtime.pending = { ...runtime.pending!, agentId: 'role-writer' };
    expect(holdFor('role-writer')).toBeUndefined();

    cleanup();
    runtime.pending = null;
    runtime.queued = {
      'session-1': [{
        id: 'queued-1',
        tool: 'Bash',
        type: 'command',
        agentId: 'default',
        details: {},
        timestamp: 2,
      }],
    };
    expect(holdFor('default')).toBeUndefined();
  });

  it('still counts a distinct subagent id that is already on the permission request', () => {
    seed();
    runtime.pending = { ...runtime.pending!, agentId: 'agent_child_1' };
    expect(holdFor('agent_child_1')).toBe('approval');
    expect(holdFor('default')).toBeUndefined();
    expect(holdFor('role-writer')).toBeUndefined();
  });
});
