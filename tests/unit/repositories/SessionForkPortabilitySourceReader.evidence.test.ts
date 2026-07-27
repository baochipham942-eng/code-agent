import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/services/core/database/nativeLoader', async () => {
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

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    getWorkspaceScope: () => projectState.scope,
  }),
}));

import {
  AnchorWorkspaceEvidenceService,
  digestWorkspaceValue,
} from '../../../src/host/services/sessionFork/workspace';
import {
  buildPortableIsolatedAnchorEvidenceV1,
} from '../../../src/host/services/sessionFork/portability/portableWorkspaceEvidence';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { SessionForkPortabilitySourceReader } from '../../../src/host/services/core/repositories/SessionForkPortabilitySourceReader';

const temporaryDirectories: string[] = [];

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceRow() {
  const stagedPatch = Buffer.from('diff --git a/tracked.txt b/tracked.txt\nstaged binary patch\n');
  const unstagedPatch = Buffer.from('diff --git a/tracked.txt b/tracked.txt\nunstaged binary patch\n');
  const untracked = Buffer.from([0, 255, 3, 4]);
  const identityFields = {
    canonicalRoot: '/source/private/repository',
    canonicalGitCommonDirectory: '/source/private/repository/.git',
    rootDevice: '1',
    rootInode: '2',
    gitCommonDevice: '1',
    gitCommonInode: '3',
    objectFormat: 'sha1',
  };
  const manifestWithoutDigest = {
    version: 1 as const,
    captureState: 'complete' as const,
    anchorId: 'assistant-a2',
    capturedAt: 10,
    baseCommit: 'a'.repeat(40),
    baseCommitSource: 'explicit_anchor_input' as const,
    observedHead: 'b'.repeat(40),
    workspaceScopeVersion: 'scope-v1',
    repositoryIdentity: {
      ...identityFields,
      fingerprint: digestWorkspaceValue(identityFields),
    },
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: '/source/private/repository',
      repositoryRelativePath: '.',
      isolatedRelativePath: '.',
    }],
    stagedPatch: { sha256: sha256(stagedPatch), sizeBytes: stagedPatch.byteLength },
    unstagedPatch: { sha256: sha256(unstagedPatch), sizeBytes: unstagedPatch.byteLength },
    untrackedFiles: [{
      path: 'new.bin',
      sha256: sha256(untracked),
      sizeBytes: untracked.byteLength,
      mode: 0o600,
    }],
  };
  const payload = {
    stagedPatchBase64: stagedPatch.toString('base64'),
    unstagedPatchBase64: unstagedPatch.toString('base64'),
    untrackedBlobs: {
      [sha256(untracked)]: untracked.toString('base64'),
    },
  };
  const evidence = {
    manifest: {
      ...manifestWithoutDigest,
      evidenceDigest: digestWorkspaceValue({
        manifest: manifestWithoutDigest,
        payload,
      }),
    },
    payload,
  };
  return {
    saga_state: 'completed',
    intent_status: 'advertised',
    advertisable: 1,
    evidence_status: 'complete',
    evidence_id: 'evidence-1',
    intent_evidence_digest: evidence.manifest.evidenceDigest,
    evidence_digest: evidence.manifest.evidenceDigest,
    source_identity_digest: '1'.repeat(64),
    source_identity_json: JSON.stringify(identityFields),
    base_commit: evidence.manifest.baseCommit,
    evidence_json: JSON.stringify(evidence),
  };
}

function readerForRow(row: Record<string, unknown>) {
  const get = vi.fn(() => row);
  const db = {
    prepare: vi.fn(() => ({ get })),
  };
  const reader = new SessionForkPortabilitySourceReader(db as never);
  return {
    read: (reader as unknown as {
      readPortableWorkspace: (fork: Record<string, unknown>) => unknown;
    }).readPortableWorkspace.bind(reader),
  };
}

const isolatedFork = {
  id: 'fork-1',
  child_session_id: 'child-1',
  anchor_child_message_id: 'child-a1',
  workspace_mode: 'isolated_at_anchor',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function publishedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-published-workspace-reader-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  const isolatedRoot = path.join(root, 'isolated');
  await mkdir(repositoryRoot);
  await mkdir(isolatedRoot);
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'changed\n');
  await writeFile(path.join(repositoryRoot, 'new.bin'), Buffer.from([0, 2, 255]));
  const evidence = await new AnchorWorkspaceEvidenceService().capture({
    anchorId: 'child-a1',
    repositoryRoot,
    baseCommit,
    workspaceScopeVersion: 'scope-v1',
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: repositoryRoot,
      isolatedRelativePath: '.',
    }],
  });
  const portable = buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'portable-source-evidence',
    repositoryIdentityDigest: `sha256:${'2'.repeat(64)}`,
    evidence,
  });
  const canonicalRepositoryRoot = evidence.manifest.repositoryIdentity.canonicalRoot;
  const rootIdentity = await stat(canonicalRepositoryRoot);
  const sourceIdentity = {
    projectId: 'project-1',
    version: 'scope-v1',
    primaryRoot: canonicalRepositoryRoot,
    roots: [{
      sourceId: 'primary',
      path: canonicalRepositoryRoot,
      access: 'read_write',
      role: 'primary',
      identityDev: String(rootIdentity.dev),
      identityIno: String(rootIdentity.ino),
    }],
  };
  const evidenceId = 'local-evidence';
  const intentId = 'import-workspace-intent';
  const metadata = {
    portabilityImportV2: {
      sourceExportId: 'export-1',
    },
    portableWorkspaceV2: {
      mode: 'isolated_at_anchor',
      label: '历史对话 + 锚点文件',
      anchorChildMessageId: 'child-a1',
      isolatedAnchor: portable,
    },
    forkLineage: {
      forkId: 'fork-1',
      childSessionId: 'child-1',
      anchorChildMessageId: 'child-a1',
      workspaceMode: 'isolated_at_anchor',
    },
    forkWorkspaceScopeV1: {
      version: 1,
      forkId: 'fork-1',
      intentId,
      evidenceId,
      projectId: 'project-1',
      sourceWorkspaceScopeVersion: 'scope-v1',
      sourcePrimaryRoot: canonicalRepositoryRoot,
      isolatedPrimaryRoot: isolatedRoot,
      baseCommit,
      evidenceDigest: evidence.manifest.evidenceDigest,
      sourceIdentity,
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: canonicalRepositoryRoot,
        sourceRelativePath: '.',
        isolatedRelativePath: '.',
      }],
    },
    importedWorkspacePublicationV1: {
      version: 1,
      intentId,
      evidenceId,
      portableEvidenceId: portable.evidenceId,
      portablePayloadDigest: portable.content.payloadDigest,
      evidenceDigest: evidence.manifest.evidenceDigest,
      workspaceScopeVersion: 'scope-v1',
      publishedAt: 100,
    },
  };
  const sessionRow = {
    user_id: 'owner-1',
    project_id: 'project-1',
    origin: JSON.stringify({ kind: 'import' }),
    metadata: JSON.stringify(metadata),
    agent_engine: JSON.stringify({ kind: 'native', cwd: isolatedRoot }),
    read_only: 0,
    working_directory: isolatedRoot,
    workspace: isolatedRoot,
    is_deleted: 0,
    status: 'idle',
  };
  const publicationRow = {
    intent_source_session_id: 'child-1',
    intent_child_session_id: 'child-1',
    intent_repository_root: canonicalRepositoryRoot,
    intent_workspace_path: isolatedRoot,
    intent_evidence_digest: evidence.manifest.evidenceDigest,
    intent_status: 'advertised',
    intent_advertisable: 1,
    evidence_source_session_id: 'child-1',
    evidence_anchor_message_id: 'child-a1',
    evidence_owner_user_id: 'owner-1',
    evidence_project_id: 'project-1',
    evidence_workspace_scope_version: 'scope-v1',
    evidence_source_identity_digest: digestWorkspaceValue(sourceIdentity),
    evidence_source_identity_json: JSON.stringify(sourceIdentity),
    evidence_repository_root: canonicalRepositoryRoot,
    evidence_base_commit: evidence.manifest.baseCommit,
    evidence_observed_head: evidence.manifest.observedHead,
    evidence_digest: evidence.manifest.evidenceDigest,
    evidence_json: JSON.stringify(evidence),
    evidence_status: 'complete',
  };
  return {
    sessionRow,
    publicationRow,
    portable,
    repositoryRoot: canonicalRepositoryRoot,
  };
}

function readerForPublishedRows(
  sessionRow: Record<string, unknown>,
  publicationRow: Record<string, unknown>,
) {
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM session_fork_workspace_sagas')) return undefined;
        if (sql.includes('FROM sessions')) return sessionRow;
        if (sql.includes('FROM session_fork_workspace_intents')) return publicationRow;
        return undefined;
      }),
    })),
  };
  const reader = new SessionForkPortabilitySourceReader(db as never);
  return (reader as unknown as {
    readPortableWorkspace: (fork: Record<string, unknown>) => unknown;
  }).readPortableWorkspace.bind(reader);
}

function rootReaderForPublishedRows(
  sessionRow: Record<string, unknown>,
  publicationRow: Record<string, unknown>,
) {
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM sessions')) return sessionRow;
        if (sql.includes('FROM session_fork_workspace_intents')) return publicationRow;
        return undefined;
      }),
    })),
  };
  const reader = new SessionForkPortabilitySourceReader(db as never);
  return (reader as unknown as {
    readImportedRootPortableWorkspace: (sessionId: string) => unknown;
  }).readImportedRootPortableWorkspace.bind(reader);
}

afterEach(async () => {
  projectState.scope = undefined;
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('SessionForkPortabilitySourceReader isolated evidence', () => {
  it('exports content-addressed bytes while removing every absolute source path', () => {
    const workspace = readerForRow(evidenceRow()).read(isolatedFork) as {
      isolatedAnchor: {
        content: {
          stagedPatch: { blobDigest: string };
          untrackedFiles: Array<{ relativePath: string; blobDigest: string }>;
          blobs: Record<string, string>;
        };
      };
    };

    expect(workspace.isolatedAnchor.content.untrackedFiles).toEqual([
      expect.objectContaining({ relativePath: 'new.bin', mode: 0o600 }),
    ]);
    const stagedDigest = workspace.isolatedAnchor.content.stagedPatch.blobDigest;
    expect(Buffer.from(workspace.isolatedAnchor.content.blobs[stagedDigest], 'base64').toString())
      .toContain('staged binary patch');
    expect(JSON.stringify(workspace)).not.toContain('/source/private');
  });

  it('fails closed when persisted evidence bytes no longer match their digest', () => {
    const row = evidenceRow();
    const evidence = JSON.parse(String(row.evidence_json)) as {
      payload: { stagedPatchBase64: string };
    };
    evidence.payload.stagedPatchBase64 = Buffer.from('tampered').toString('base64');
    row.evidence_json = JSON.stringify(evidence);

    expect(() => readerForRow(row).read(isolatedFork)).toThrow(/DIGEST_MISMATCH/u);
  });

  it('re-exports an atomically published imported workspace from target-local evidence', async () => {
    const fixture = await publishedFixture();
    const workspace = readerForPublishedRows(
      fixture.sessionRow,
      fixture.publicationRow,
    )(isolatedFork) as {
      isolatedAnchor: {
        evidenceId: string;
        content: { payloadDigest: string };
        pathMappings: Array<{ relativePath: string; isolatedRelativePath: string }>;
      };
    };

    expect(workspace.isolatedAnchor).toMatchObject({
      evidenceId: 'local-evidence',
      content: { payloadDigest: fixture.portable.content.payloadDigest },
      pathMappings: [{ relativePath: '.', isolatedRelativePath: '.' }],
    });
    expect(JSON.stringify(workspace)).not.toContain(fixture.repositoryRoot);
  });

  it('re-exports a published isolated import root with its explicit child anchor', async () => {
    const fixture = await publishedFixture();
    const workspace = rootReaderForPublishedRows(
      fixture.sessionRow,
      fixture.publicationRow,
    )('child-1') as {
      mode: string;
      anchorChildMessageId: string;
      isolatedAnchor: { content: { payloadDigest: string } };
    };

    expect(workspace).toMatchObject({
      mode: 'isolated_at_anchor',
      anchorChildMessageId: 'child-a1',
      isolatedAnchor: {
        content: { payloadDigest: fixture.portable.content.payloadDigest },
      },
    });
  });

  it('re-exports an atomically published imported workspace for the local null-owner scope', async () => {
    const fixture = await publishedFixture();
    const workspace = readerForPublishedRows(
      { ...fixture.sessionRow, user_id: null },
      { ...fixture.publicationRow, evidence_owner_user_id: null },
    )(isolatedFork) as {
      isolatedAnchor: {
        evidenceId: string;
        content: { payloadDigest: string };
      };
    };

    expect(workspace.isolatedAnchor).toMatchObject({
      evidenceId: 'local-evidence',
      content: { payloadDigest: fixture.portable.content.payloadDigest },
    });
  });

  it('reads the exact durable rows emitted by imported workspace publication', async () => {
    const fixture = await publishedFixture();
    const rootIdentity = await stat(fixture.repositoryRoot);
    projectState.scope = {
      projectId: 'project-1',
      primaryRoot: fixture.repositoryRoot,
      version: 'scope-v1',
      roots: [{
        sourceId: 'primary',
        path: fixture.repositoryRoot,
        access: 'read_write',
        role: 'primary',
        identityDev: String(rootIdentity.dev),
        identityIno: String(rootIdentity.ino),
      }],
    };
    const database = new DatabaseService();
    (database as unknown as { dbPath: string }).dbPath = path.join(
      path.dirname(fixture.repositoryRoot),
      'data',
      'code-agent.db',
    );
    await database.initialize();
    try {
      const importedMetadata = JSON.parse(String(fixture.sessionRow.metadata)) as Record<string, unknown>;
      delete importedMetadata.forkWorkspaceScopeV1;
      delete importedMetadata.importedWorkspacePublicationV1;
      database.createSession({
        id: 'child-1',
        userId: 'owner-1',
        title: 'Imported child',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        projectId: 'project-1',
        origin: { kind: 'import' },
        metadata: importedMetadata,
        engine: { kind: 'native', origin: 'import' },
        readOnly: true,
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      });
      database.addMessage('child-1', {
        id: 'child-a1',
        role: 'assistant',
        content: 'imported anchor',
        timestamp: 2,
      });
      const published = await database.publishImportedIsolatedWorkspace({
        importedSessionId: 'child-1',
        importedAnchorMessageId: 'child-a1',
        ownerUserId: 'owner-1',
        targetProjectId: 'project-1',
        workspaceBinding: {
          projectId: 'project-1',
          topology: 'single_root_git',
          identityTrust: 'verified',
          repositoryRoot: fixture.repositoryRoot,
          workspaceScopeVersion: 'scope-v1',
        },
        portableEvidence: fixture.portable,
        now: 100,
      });
      const reader = new SessionForkPortabilitySourceReader(database.getDb() as never);
      const workspace = (reader as unknown as {
        readPortableWorkspace: (fork: Record<string, unknown>) => {
          isolatedAnchor: { content: { payloadDigest: string } };
        };
      }).readPortableWorkspace(isolatedFork);
      expect(workspace.isolatedAnchor.content.payloadDigest)
        .toBe(fixture.portable.content.payloadDigest);
      expect(database.getSession('child-1', { userId: 'owner-1' })).toMatchObject({
        readOnly: false,
        workingDirectory: published.workspacePath,
      });
    } finally {
      database.close();
    }
  });

  it('fails closed on published content, publication, owner, or Project drift', async () => {
    const fixture = await publishedFixture();
    const tamperedEvidence = JSON.parse(String(fixture.publicationRow.evidence_json)) as {
      payload: { unstagedPatchBase64: string };
    };
    tamperedEvidence.payload.unstagedPatchBase64 = Buffer.from('tampered').toString('base64');
    expect(() => readerForPublishedRows(
      fixture.sessionRow,
      {
        ...fixture.publicationRow,
        evidence_json: JSON.stringify(tamperedEvidence),
      },
    )(isolatedFork)).toThrow(/DIGEST_MISMATCH/u);

    const metadata = JSON.parse(String(fixture.sessionRow.metadata)) as Record<string, unknown>;
    const publication = metadata.importedWorkspacePublicationV1 as Record<string, unknown>;
    delete publication.evidenceDigest;
    expect(() => readerForPublishedRows(
      { ...fixture.sessionRow, metadata: JSON.stringify(metadata) },
      fixture.publicationRow,
    )(isolatedFork)).toThrow(/evidenceDigest is required/u);

    const pathMetadata = JSON.parse(String(fixture.sessionRow.metadata)) as {
      forkWorkspaceScopeV1: {
        pathMappings: Array<{ isolatedRelativePath: string }>;
      };
    };
    pathMetadata.forkWorkspaceScopeV1.pathMappings[0].isolatedRelativePath = 'tampered';
    expect(() => readerForPublishedRows(
      { ...fixture.sessionRow, metadata: JSON.stringify(pathMetadata) },
      fixture.publicationRow,
    )(isolatedFork)).toThrow(/WorkspaceScope/u);

    expect(() => readerForPublishedRows(
      fixture.sessionRow,
      { ...fixture.publicationRow, evidence_owner_user_id: 'other-owner' },
    )(isolatedFork)).toThrow(/boundary does not close/u);
    expect(() => readerForPublishedRows(
      fixture.sessionRow,
      { ...fixture.publicationRow, evidence_project_id: 'other-project' },
    )(isolatedFork)).toThrow(/boundary does not close/u);
    expect(() => readerForPublishedRows(
      { ...fixture.sessionRow, agent_engine: JSON.stringify({ kind: 'native', cwd: '/wrong' }) },
      fixture.publicationRow,
    )(isolatedFork)).toThrow(/session runtime/u);
  });
});
