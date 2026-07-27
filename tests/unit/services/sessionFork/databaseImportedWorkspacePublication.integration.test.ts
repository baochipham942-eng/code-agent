import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
vi.mock('../../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return { loadBetterSqlite3: () => module.default };
});

const projectState = vi.hoisted(() => ({
  scope: undefined as undefined | {
    projectId: string;
    primaryRoot: string;
    version: string;
    roots: Array<{
      sourceId: string;
      path: string;
      access: 'read_write';
      role: 'primary';
      identityDev: string;
      identityIno: string;
    }>;
  },
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    getWorkspaceScope: () => projectState.scope,
  }),
}));

import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import {
  AnchorWorkspaceEvidenceService,
} from '../../../../src/host/services/sessionFork/workspace';
import {
  buildPortableIsolatedAnchorEvidenceV1,
} from '../../../../src/host/services/sessionFork/portability/portableWorkspaceEvidence';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function fixture(): Promise<{
  database: DatabaseService;
  repositoryRoot: string;
  portableEvidence: ReturnType<typeof buildPortableIsolatedAnchorEvidenceV1>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-imported-workspace-publication-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  await mkdir(repositoryRoot);
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'anchor\n');
  await writeFile(path.join(repositoryRoot, 'new.txt'), 'untracked\n');
  const identity = await stat(repositoryRoot);
  projectState.scope = {
    projectId: 'project-1',
    primaryRoot: repositoryRoot,
    version: 'scope-v1',
    roots: [{
      sourceId: 'primary',
      path: repositoryRoot,
      access: 'read_write',
      role: 'primary',
      identityDev: String(identity.dev),
      identityIno: String(identity.ino),
    }],
  };
  const evidence = await new AnchorWorkspaceEvidenceService().capture({
    anchorId: 'imported-a1',
    repositoryRoot,
    baseCommit,
    workspaceScopeVersion: 'source-scope',
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: repositoryRoot,
      isolatedRelativePath: '.',
    }],
  });
  const portableEvidence = buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'portable-evidence',
    repositoryIdentityDigest: `sha256:${'1'.repeat(64)}`,
    evidence,
  });
  const database = new DatabaseService();
  (database as unknown as { dbPath: string }).dbPath = path.join(root, 'data', 'code-agent.db');
  await database.initialize();
  database.createSession({
    id: 'imported-child',
    userId: 'owner',
    title: 'Imported child',
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    projectId: 'project-1',
    origin: { kind: 'import' },
    metadata: {
      portabilityImportV2: { sourceExportId: 'export-1' },
      portableWorkspaceV2: {
        mode: 'isolated_at_anchor',
        label: '历史对话 + 锚点文件',
        isolatedAnchor: portableEvidence,
      },
      forkLineage: {
        forkId: 'imported-fork',
        workspaceMode: 'isolated_at_anchor',
      },
    },
    engine: { kind: 'native', origin: 'import' },
    readOnly: true,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  });
  database.addMessage('imported-child', {
    id: 'imported-a1',
    role: 'assistant',
    content: 'portable anchor',
    timestamp: 2,
  });
  return { database, repositoryRoot, portableEvidence };
}

function publicationInput(
  repositoryRoot: string,
  portableEvidence: ReturnType<typeof buildPortableIsolatedAnchorEvidenceV1>,
) {
  return {
    importedSessionId: 'imported-child',
    importedAnchorMessageId: 'imported-a1',
    ownerUserId: 'owner',
    targetProjectId: 'project-1',
    workspaceBinding: {
      projectId: 'project-1',
      topology: 'single_root_git' as const,
      identityTrust: 'verified' as const,
      repositoryRoot,
      workspaceScopeVersion: 'scope-v1',
    },
    portableEvidence,
    now: 100,
  };
}

afterEach(async () => {
  projectState.scope = undefined;
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('DatabaseService imported isolated workspace publication', () => {
  it('atomically publishes the verified cwd, runtime metadata, and advertised intent', async () => {
    const setup = await fixture();
    const sourceBefore = await readFile(path.join(setup.repositoryRoot, 'tracked.txt'));
    try {
      const published = await setup.database.publishImportedIsolatedWorkspace(
        publicationInput(setup.repositoryRoot, setup.portableEvidence),
      );
      const session = setup.database.getSession('imported-child', { userId: 'owner' });
      expect(session).toMatchObject({
        readOnly: false,
        workingDirectory: published.workspacePath,
        workspace: published.workspacePath,
        engine: { cwd: published.workspacePath },
      });
      expect(session?.metadata).toMatchObject({
        importedWorkspacePublicationV1: {
          intentId: published.intentId,
          evidenceDigest: published.evidenceDigest,
        },
        forkWorkspaceScopeV1: {
          isolatedPrimaryRoot: published.workspacePath,
          projectId: 'project-1',
        },
      });
      expect(setup.database.getDb()?.prepare(`
        SELECT status, advertisable FROM session_fork_workspace_intents WHERE intent_id = ?
      `).get(published.intentId)).toEqual({ status: 'advertised', advertisable: 1 });
      expect(setup.database.getSessionForkWorkspaceScope('imported-child', 'owner'))
        .toMatchObject({ primaryRoot: published.workspacePath, projectId: 'project-1' });
      expect(await readFile(path.join(published.workspacePath, 'tracked.txt'), 'utf8'))
        .toBe('anchor\n');
      expect(await readFile(path.join(setup.repositoryRoot, 'tracked.txt'))).toEqual(sourceBefore);
    } finally {
      setup.database.close();
    }
  });

  it('rolls back both rows on a database fault and retries the same ready intent', async () => {
    const setup = await fixture();
    const db = setup.database.getDb();
    try {
      db?.exec(`
        CREATE TRIGGER fail_imported_workspace_publish
        BEFORE UPDATE OF working_directory ON sessions
        WHEN NEW.id = 'imported-child'
        BEGIN
          SELECT RAISE(ABORT, 'injected publication failure');
        END;
      `);
      const input = publicationInput(setup.repositoryRoot, setup.portableEvidence);
      await expect(setup.database.publishImportedIsolatedWorkspace(input))
        .rejects.toThrow(/injected publication failure/u);
      expect(setup.database.getSession('imported-child', { userId: 'owner' })).toMatchObject({
        readOnly: true,
        workingDirectory: null,
        workspace: null,
      });
      expect(db?.prepare(`
        SELECT status, advertisable, COUNT(*) OVER () AS count
        FROM session_fork_workspace_intents
      `).get()).toEqual({ status: 'ready', advertisable: 1, count: 1 });

      db?.exec('DROP TRIGGER fail_imported_workspace_publish');
      const retried = await setup.database.publishImportedIsolatedWorkspace(input);
      expect(setup.database.getSession('imported-child', { userId: 'owner' })).toMatchObject({
        readOnly: false,
        workingDirectory: retried.workspacePath,
      });
      expect(db?.prepare('SELECT COUNT(*) AS count FROM session_fork_workspace_intents').get())
        .toEqual({ count: 1 });
    } finally {
      setup.database.close();
    }
  });

  it('rejects owner or multi-root Project drift before writing evidence or an intent', async () => {
    const setup = await fixture();
    try {
      const input = publicationInput(setup.repositoryRoot, setup.portableEvidence);
      await expect(setup.database.publishImportedIsolatedWorkspace({
        ...input,
        ownerUserId: 'other-owner',
      })).rejects.toThrow(/BOUNDARY_MISMATCH/u);
      projectState.scope?.roots.push({
        sourceId: 'unexpected-secondary',
        path: setup.repositoryRoot,
        access: 'read_write',
        role: 'primary',
        identityDev: projectState.scope.roots[0].identityDev,
        identityIno: projectState.scope.roots[0].identityIno,
      });
      await expect(setup.database.publishImportedIsolatedWorkspace(input))
        .rejects.toThrow(/trusted single-root/u);
      expect(setup.database.getDb()?.prepare(`
        SELECT
          (SELECT COUNT(*) FROM session_fork_anchor_evidence) AS evidence_count,
          (SELECT COUNT(*) FROM session_fork_workspace_intents) AS intent_count
      `).get()).toEqual({ evidence_count: 0, intent_count: 0 });
      expect(setup.database.getSession('imported-child', { userId: 'owner' })).toMatchObject({
        readOnly: true,
        workingDirectory: null,
      });
    } finally {
      setup.database.close();
    }
  });
});
