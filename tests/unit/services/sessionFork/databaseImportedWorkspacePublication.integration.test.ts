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
  databasePath: string;
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
  const databasePath = path.join(root, 'data', 'code-agent.db');
  (database as unknown as { dbPath: string }).dbPath = databasePath;
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
        anchorChildMessageId: 'imported-a1',
        isolatedAnchor: portableEvidence,
      },
      forkLineage: {
        forkId: 'imported-fork',
        childSessionId: 'imported-child',
        anchorChildMessageId: 'imported-a1',
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
  return { database, databasePath, repositoryRoot, portableEvidence };
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

function stageDurableImportGraph(database: DatabaseService): string {
  const rawDatabase = database.getDb();
  if (!rawDatabase) throw new Error('database fixture failed to initialize');
  const importId = 'import-graph-1';
  rawDatabase.prepare(`
    INSERT INTO session_fork_portability_imports (
      import_id, source_export_id, source_payload_digest,
      target_owner_scope_id, target_project_id, import_namespace,
      imported_root_session_id, plan_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    importId,
    'export-1',
    `sha256:${'7'.repeat(64)}`,
    'owner',
    'project-1',
    'workspace-publication-test',
    'imported-root',
    JSON.stringify({
      schema: 'neo.session-fork-import-plan',
      version: 1,
      result: {
        importId,
        sourceExportId: 'export-1',
        rootSessionId: 'imported-root',
        sessionIdMap: {
          root: 'imported-root',
          child: 'imported-child',
          child2: 'imported-child-2',
        },
        messageIdMap: {},
        forkIdMap: {},
        importedAt: 1,
      },
      expectedConversationStatusBySession: {},
      compatibilityProjectionDigestBySession: {},
    }),
    1,
  );
  return importId;
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

  it('revalidates the full publication closure before an idempotent early return', async () => {
    const setup = await fixture();
    const input = publicationInput(setup.repositoryRoot, setup.portableEvidence);
    const db = setup.database.getDb();
    try {
      const first = await setup.database.publishImportedIsolatedWorkspace(input);
      await expect(setup.database.publishImportedIsolatedWorkspace(input)).resolves.toEqual(first);
      db?.prepare(`
        UPDATE sessions
        SET agent_engine = json_set(agent_engine, '$.cwd', '/tampered/cwd')
        WHERE id = 'imported-child'
      `).run();
      const changesBeforeRetry = db?.prepare('SELECT total_changes() AS changes').get();

      await expect(setup.database.publishImportedIsolatedWorkspace(input))
        .rejects.toThrow(/publication boundary does not close: session runtime/u);
      expect(db?.prepare('SELECT total_changes() AS changes').get()).toEqual(changesBeforeRetry);
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

  it('keeps every workspace hidden when publication of the second graph item fails', async () => {
    const setup = await fixture();
    const db = setup.database.getDb();
    try {
      setup.database.createSession({
        id: 'imported-root',
        userId: 'owner',
        title: 'Imported root',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        projectId: 'project-1',
        origin: { kind: 'import' },
        metadata: {
          portabilityImportV2: { sourceExportId: 'export-1' },
          portabilityPublicationBarrierV1: {
            sourceExportId: 'export-1',
            desiredReadOnly: false,
            workspaceMode: 'shared_current',
          },
        },
        engine: { kind: 'native', origin: 'import' },
        readOnly: true,
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      });
      setup.database.createSession({
        id: 'imported-child-2',
        userId: 'owner',
        title: 'Imported child 2',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        projectId: 'project-1',
        origin: { kind: 'import' },
        metadata: {
          portabilityImportV2: { sourceExportId: 'export-1' },
          portableWorkspaceV2: {
            mode: 'isolated_at_anchor',
            label: '历史对话 + 锚点文件',
            anchorChildMessageId: 'imported-a2',
            isolatedAnchor: setup.portableEvidence,
          },
          forkLineage: {
            forkId: 'imported-fork-2',
            childSessionId: 'imported-child-2',
            anchorChildMessageId: 'imported-a2',
            workspaceMode: 'isolated_at_anchor',
          },
        },
        engine: { kind: 'native', origin: 'import' },
        readOnly: true,
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      });
      setup.database.addMessage('imported-child-2', {
        id: 'imported-a2',
        role: 'assistant',
        content: 'portable anchor 2',
        timestamp: 2,
      });
      const first = await setup.database.prepareImportedIsolatedWorkspace(
        publicationInput(setup.repositoryRoot, setup.portableEvidence),
      );
      const second = await setup.database.prepareImportedIsolatedWorkspace({
        ...publicationInput(setup.repositoryRoot, setup.portableEvidence),
        importedSessionId: 'imported-child-2',
        importedAnchorMessageId: 'imported-a2',
      });
      const importId = stageDurableImportGraph(setup.database);
      const graphInput = {
        importId,
        sourceExportId: 'export-1',
        ownerUserId: 'owner',
        targetProjectId: 'project-1',
        sessions: [
          {
            sessionId: 'imported-root',
            readOnly: false,
            workspaceMode: 'shared_current' as const,
          },
          {
            sessionId: 'imported-child',
            readOnly: false,
            workspaceMode: 'isolated_at_anchor' as const,
          },
          {
            sessionId: 'imported-child-2',
            readOnly: false,
            workspaceMode: 'isolated_at_anchor' as const,
          },
        ],
        workspaces: [first, second],
        now: 110,
      };
      db?.exec(`
        CREATE TRIGGER fail_second_imported_workspace_publish
        BEFORE UPDATE OF working_directory ON sessions
        WHEN NEW.id = 'imported-child-2'
        BEGIN
          SELECT RAISE(ABORT, 'injected second publication failure');
        END;
      `);

      await expect(setup.database.publishPreparedImportedWorkspaceGraph(graphInput))
        .rejects.toThrow(/injected second publication failure/u);
      expect(setup.database.getSession('imported-child', { userId: 'owner' })).toMatchObject({
        readOnly: true,
        workingDirectory: null,
        workspace: null,
      });
      expect(setup.database.getSession('imported-child-2', { userId: 'owner' })).toMatchObject({
        readOnly: true,
        workingDirectory: null,
        workspace: null,
      });
      expect(setup.database.getSession('imported-root', { userId: 'owner' })).toMatchObject({
        readOnly: true,
        workingDirectory: null,
        workspace: null,
      });
      expect(db?.prepare(`
        SELECT status, advertisable
        FROM session_fork_workspace_intents
        ORDER BY source_session_id
      `).all()).toEqual([
        { status: 'ready', advertisable: 1 },
        { status: 'ready', advertisable: 1 },
      ]);

      db?.exec('DROP TRIGGER fail_second_imported_workspace_publish');
      await expect(setup.database.publishPreparedImportedWorkspaceGraph(graphInput))
        .resolves.toHaveLength(2);
      expect(setup.database.getSession('imported-child', { userId: 'owner' }))
        .toMatchObject({ readOnly: false, workingDirectory: first.workspacePath });
      expect(setup.database.getSession('imported-child-2', { userId: 'owner' }))
        .toMatchObject({ readOnly: false, workingDirectory: second.workspacePath });
      expect(setup.database.getSession('imported-root', { userId: 'owner' }))
        .toMatchObject({ readOnly: false, workingDirectory: null, workspace: null });
      expect(setup.database.getSession('imported-root', { userId: 'owner' })?.metadata)
        .not.toHaveProperty('portabilityPublicationBarrierV1');
      const repeatedFirst = await setup.database.prepareImportedIsolatedWorkspace(
        publicationInput(setup.repositoryRoot, setup.portableEvidence),
      );
      const repeatedSecond = await setup.database.prepareImportedIsolatedWorkspace({
        ...publicationInput(setup.repositoryRoot, setup.portableEvidence),
        importedSessionId: 'imported-child-2',
        importedAnchorMessageId: 'imported-a2',
      });
      expect([repeatedFirst.state, repeatedSecond.state]).toEqual(['published', 'published']);
      const changesBeforeRepeat = db?.prepare('SELECT total_changes() AS changes').get();
      await expect(setup.database.publishPreparedImportedWorkspaceGraph({
        ...graphInput,
        workspaces: [repeatedFirst, repeatedSecond],
        now: 130,
      })).resolves.toHaveLength(2);
      expect(db?.prepare('SELECT total_changes() AS changes').get()).toEqual(changesBeforeRepeat);
    } finally {
      setup.database.close();
    }
  });

  it('resumes a durable ready workspace after restart and publishes it once', async () => {
    const setup = await fixture();
    const input = publicationInput(setup.repositoryRoot, setup.portableEvidence);
    const firstPrepared = await setup.database.prepareImportedIsolatedWorkspace(input);
    expect(firstPrepared.state).toBe('ready');
    setup.database.close();

    const restarted = new DatabaseService();
    (restarted as unknown as { dbPath: string }).dbPath = setup.databasePath;
    await restarted.initialize();
    try {
      const resumed = await restarted.prepareImportedIsolatedWorkspace(input);
      expect(resumed).toMatchObject({
        intentId: firstPrepared.intentId,
        workspacePath: firstPrepared.workspacePath,
        state: 'ready',
      });
      await expect(restarted.publishPreparedImportedWorkspaceGraph({
        sourceExportId: resumed.sourceExportId,
        ownerUserId: 'owner',
        targetProjectId: 'project-1',
        sessions: [{
          sessionId: 'imported-child',
          readOnly: false,
          workspaceMode: 'isolated_at_anchor',
        }],
        workspaces: [resumed],
        now: 120,
      })).resolves.toEqual([
        expect.objectContaining({
          sessionId: 'imported-child',
          intentId: firstPrepared.intentId,
          publishedAt: 120,
        }),
      ]);
      expect(restarted.getSession('imported-child', { userId: 'owner' }))
        .toMatchObject({ readOnly: false, workingDirectory: firstPrepared.workspacePath });
      expect(restarted.getDb()?.prepare(`
        SELECT COUNT(*) AS count
        FROM session_fork_workspace_intents
        WHERE status = 'advertised'
      `).get()).toEqual({ count: 1 });
    } finally {
      restarted.close();
    }
  });

  it('refuses to bypass a durable graph barrier through the legacy single-session API', async () => {
    const setup = await fixture();
    const input = publicationInput(setup.repositoryRoot, setup.portableEvidence);
    const db = setup.database.getDb();
    try {
      const prepared = await setup.database.prepareImportedIsolatedWorkspace(input);
      db?.prepare(`
        UPDATE sessions
        SET metadata = json_set(
          metadata,
          '$.portabilityPublicationBarrierV1',
          json(?)
        )
        WHERE id = 'imported-child'
      `).run(JSON.stringify({
        sourceExportId: 'export-1',
        desiredReadOnly: false,
        workspaceMode: 'isolated_at_anchor',
      }));

      await expect(setup.database.publishPreparedImportedWorkspaceGraph({
        sourceExportId: 'export-1',
        ownerUserId: 'owner',
        targetProjectId: 'project-1',
        sessions: [{
          sessionId: 'imported-child',
          readOnly: false,
          workspaceMode: 'isolated_at_anchor',
        }],
        workspaces: [{ ...prepared, graphPublicationRequired: false }],
      })).rejects.toThrow(/requires its durable import id/u);
      await expect(setup.database.publishImportedIsolatedWorkspace(input))
        .rejects.toThrow(/require graph publication/u);
      expect(setup.database.getSession('imported-child', { userId: 'owner' }))
        .toMatchObject({ readOnly: true, workingDirectory: null, workspace: null });
      expect(db?.prepare(`
        SELECT status, advertisable
        FROM session_fork_workspace_intents
        WHERE intent_id = ?
      `).get(prepared.intentId)).toEqual({ status: 'ready', advertisable: 1 });
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
