import { describe, expect, it, vi } from 'vitest';

import { resolveSessionWorkspaceScope } from '../../../../src/host/services/sessionFork/workspace';

const projectScope = {
  projectId: 'project-1',
  primaryRoot: '/source',
  roots: [{
    sourceId: 'source',
    path: '/source',
    access: 'read_write' as const,
    role: 'primary' as const,
  }],
  version: 'project-v1',
};
const isolatedScope = {
  projectId: 'project-1',
  primaryRoot: '/durable/child',
  roots: [{
    sourceId: 'isolated:intent-1',
    path: '/durable/child',
    access: 'read_write' as const,
    role: 'primary' as const,
  }],
  version: 'isolated-v1',
};

describe('resolveSessionWorkspaceScope', () => {
  it('prefers the verified isolated child scope over the source Project', () => {
    const getSessionForkWorkspaceScope = vi.fn(() => isolatedScope);
    const getWorkspaceScope = vi.fn(() => projectScope);

    expect(resolveSessionWorkspaceScope(
      { id: 'child', projectId: 'project-1' },
      'owner',
      { getSessionForkWorkspaceScope },
      { getWorkspaceScope },
    )).toBe(isolatedScope);
    expect(getSessionForkWorkspaceScope).toHaveBeenCalledWith('child', 'owner');
    expect(getWorkspaceScope).not.toHaveBeenCalled();
  });

  it('uses the Project scope for ordinary and shared-current sessions', () => {
    const getSessionForkWorkspaceScope = vi.fn(() => null);
    const getWorkspaceScope = vi.fn(() => projectScope);

    expect(resolveSessionWorkspaceScope(
      { id: 'ordinary', projectId: 'project-1' },
      null,
      { getSessionForkWorkspaceScope },
      { getWorkspaceScope },
    )).toBe(projectScope);
    expect(getWorkspaceScope).toHaveBeenCalledWith('project-1');
  });

  it('does not query either source for a missing session', () => {
    const getSessionForkWorkspaceScope = vi.fn();
    const getWorkspaceScope = vi.fn();

    expect(resolveSessionWorkspaceScope(
      null,
      null,
      { getSessionForkWorkspaceScope },
      { getWorkspaceScope },
    )).toBeUndefined();
    expect(getSessionForkWorkspaceScope).not.toHaveBeenCalled();
    expect(getWorkspaceScope).not.toHaveBeenCalled();
  });

  it('fails closed when isolated metadata cannot be verified', () => {
    expect(() => resolveSessionWorkspaceScope(
      {
        id: 'isolated-child',
        projectId: 'project-1',
        metadata: {
          forkLineage: { workspaceMode: 'isolated_at_anchor' },
        },
      },
      'owner',
      {},
      { getWorkspaceScope: () => projectScope },
    )).toThrow('Verified isolated WorkspaceScope resolver is unavailable');
  });
});
