import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Project,
  ProjectSource,
} from '../../../src/shared/contract/project';
import {
  canonicalizeWorkspacePath,
  workspacePathIdentity,
} from '../../../src/host/runtime/workspaceScope';

const databaseState = vi.hoisted(() => ({
  projectRepo: undefined as unknown,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getProjectRepo: () => databaseState.projectRepo,
  }),
}));

import { ProjectService } from '../../../src/host/services/project/projectService';

const tempRoots: string[] = [];
const NOW = 1_700_000_000_000;

function createFixture() {
  const basePath = mkdtempSync(path.join(os.tmpdir(), 'neo-project-source-identity-'));
  const sourcePath = path.join(basePath, 'source');
  mkdirSync(sourcePath);
  tempRoots.push(basePath);

  const identity = workspacePathIdentity(sourcePath);
  expect(identity.dev).not.toBeNull();
  expect(identity.ino).not.toBeNull();

  const project: Project = {
    id: 'proj_identity',
    name: 'identity',
    workspacePath: sourcePath,
    workspaceKey: 'identity-key',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    sourceRevision: 0,
  };
  const source: ProjectSource = {
    id: 'psrc_identity',
    projectId: project.id,
    path: sourcePath,
    canonicalPath: sourcePath,
    role: 'primary',
    access: 'read_write',
    trustState: 'trusted',
    identityDev: identity.dev,
    identityIno: identity.ino,
    createdAt: NOW,
    updatedAt: NOW,
  };

  databaseState.projectRepo = {
    getProject: () => project,
    listSources: () => [source],
    listGoals: () => [],
    listRoles: () => [],
    listSessionIds: () => [],
  };

  return {
    basePath,
    sourcePath,
    identity,
    source,
    service: new ProjectService(),
  };
}

function expectBlocked(service: ProjectService, projectId: string): void {
  expect(() => service.getWorkspaceScope(projectId))
    .toThrow('Project Source trust identity changed');
  expect(service.getProjectDetail(projectId)?.sources[0].trustState).toBe('blocked');
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('ProjectService workspace source identity gate', () => {
  it('keeps the source trusted when dev changes but ino stays the same', () => {
    const fixture = createFixture();
    fixture.source.identityDev = (BigInt(fixture.identity.dev!) + 1n).toString();

    const scope = fixture.service.getWorkspaceScope('proj_identity');

    expect(scope).toEqual(expect.objectContaining({
      projectId: 'proj_identity',
      primaryRoot: canonicalizeWorkspacePath(fixture.sourcePath),
    }));
    expect(fixture.service.getProjectDetail('proj_identity')?.sources[0].trustState).toBe('trusted');
  });

  it('blocks the source when the path points to a newly created inode', () => {
    const fixture = createFixture();
    renameSync(fixture.sourcePath, path.join(fixture.basePath, 'original-source'));
    mkdirSync(fixture.sourcePath);
    expect(workspacePathIdentity(fixture.sourcePath).ino).not.toBe(fixture.identity.ino);

    expectBlocked(fixture.service, 'proj_identity');
  });

  it('blocks the source when its path is replaced by a symlink to another directory', () => {
    const fixture = createFixture();
    const replacementPath = path.join(fixture.basePath, 'replacement');
    mkdirSync(replacementPath);
    renameSync(fixture.sourcePath, path.join(fixture.basePath, 'original-source'));
    symlinkSync(replacementPath, fixture.sourcePath, 'dir');
    expect(workspacePathIdentity(fixture.sourcePath).ino).not.toBe(fixture.identity.ino);

    expectBlocked(fixture.service, 'proj_identity');
  });

  it('blocks the source when its path no longer exists', () => {
    const fixture = createFixture();
    rmSync(fixture.sourcePath, { recursive: true });
    expect(workspacePathIdentity(fixture.sourcePath)).toEqual({ dev: null, ino: null });

    expectBlocked(fixture.service, 'proj_identity');
  });
});
