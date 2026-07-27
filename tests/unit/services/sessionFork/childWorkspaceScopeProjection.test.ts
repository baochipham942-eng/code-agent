import { describe, expect, it } from 'vitest';

import {
  ChildWorkspaceScopeProjectionError,
  projectChildWorkspaceScope,
} from '../../../../src/host/services/sessionFork/workspace';

function metadata() {
  return {
    ordinary: true,
    forkWorkspaceScopeV1: {
      version: 1,
      forkId: 'fork-1',
      intentId: 'intent-1',
      evidenceId: 'evidence-1',
      projectId: 'project-1',
      sourceWorkspaceScopeVersion: 'scope-v3',
      sourcePrimaryRoot: '/source/repository',
      isolatedPrimaryRoot: '/durable/child-1',
      baseCommit: 'a'.repeat(40),
      evidenceDigest: 'b'.repeat(64),
      sourceIdentity: {
        projectId: 'project-1',
        primaryRoot: '/source/repository',
        roots: [{ sourceId: 'source-primary', path: '/source/repository' }],
      },
      pathMappings: [{
        sourceId: 'source-primary',
        sourcePath: '/source/repository',
        sourceRelativePath: '.',
        isolatedRelativePath: '.',
      }],
    },
  };
}

describe('projectChildWorkspaceScope', () => {
  it('returns null for ordinary/shared session metadata', () => {
    expect(projectChildWorkspaceScope({ ordinary: true })).toBeNull();
  });

  it('constructs one read-only isolated root while retaining source details only as provenance', () => {
    const projection = projectChildWorkspaceScope(metadata());

    expect(projection?.scope).toEqual({
      projectId: 'project-1',
      primaryRoot: '/durable/child-1',
      roots: [{
        sourceId: 'isolated:intent-1',
        path: '/durable/child-1',
        access: 'read_only',
        role: 'primary',
      }],
      version: `isolated-v1:intent-1:${'b'.repeat(64)}`,
    });
    expect(projection?.scope.roots).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/source/repository' }),
    ]));
    expect(projection?.verification).toMatchObject({
      forkId: 'fork-1',
      intentId: 'intent-1',
      evidenceId: 'evidence-1',
      baseCommit: 'a'.repeat(40),
      evidenceDigest: 'b'.repeat(64),
    });
    expect(projection?.provenance).toMatchObject({
      sourceIdentity: {
        primaryRoot: '/source/repository',
      },
      pathMappings: [{
        sourcePath: '/source/repository',
        sourceRelativePath: '.',
        isolatedRelativePath: '.',
      }],
    });
  });

  it('rejects extra roots and paths that escape the isolated root', () => {
    const extraRoot = metadata();
    extraRoot.forkWorkspaceScopeV1.pathMappings.push({
      sourceId: 'second',
      sourcePath: '/source/second',
      sourceRelativePath: '.',
      isolatedRelativePath: 'second',
    });
    expect(() => projectChildWorkspaceScope(extraRoot))
      .toThrow(ChildWorkspaceScopeProjectionError);

    const escaping = metadata();
    escaping.forkWorkspaceScopeV1.pathMappings[0].isolatedRelativePath = '../source';
    expect(() => projectChildWorkspaceScope(escaping))
      .toThrow(ChildWorkspaceScopeProjectionError);
  });
});
