import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from '../../../src/host/services/core/database/schemaSessionForkPortability';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';
import {
  SessionForkPortabilityRepository,
} from '../../../src/host/services/core/repositories/SessionForkPortabilityRepository';
import { SessionForkPortabilitySourceReader } from '../../../src/host/services/core/repositories/SessionForkPortabilitySourceReader';
import {
  FakeSessionForkSyncTransport,
  planSessionForkImport,
  rehashSessionExportEnvelopeV2,
} from '../../../src/host/services/sessionFork/portability';
import { digestWorkspaceValue } from '../../../src/host/services/sessionFork/workspace';
import { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } from '../../../src/shared/contract/sessionForkPortability';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function totalChanges(db: BetterSqlite3.Database): number {
  const row = db.prepare(`
    SELECT total_changes() AS total_changes
  `).get() as { total_changes: number };
  return row.total_changes;
}

function applyAllSchema(db: BetterSqlite3.Database): void {
  applySchema(db, noopLogger);
  applySessionsMigrations(db, noopLogger);
  applyIndexes(db);
  applyConversationBranchSchema(db, { backfillLegacy: false });
  applySessionForkPortabilitySchema(db);
}

function seedLineage(
  db: BetterSqlite3.Database,
  ownerUserId: string | null = 'owner-1',
): void {
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, user_id, title, model_provider, model_name, working_directory,
      project_id, session_type, origin, metadata, parent_session_id,
      source_run_id, agent_engine, memory_mode, suppressed_memory_entry_ids,
      read_only, created_at, updated_at, workbench_provenance, is_deleted,
      synced_at, status, workspace, last_token_usage, git_branch
    ) VALUES (?, ?, ?, 'openai', 'gpt-test', ?, 'project-1', 'chat',
              '{"kind":"manual"}', ?, ?, ?, ?, 'off', '["memory-1"]',
              0, ?, ?, ?, 0, NULL, 'completed', ?, '{"totalTokens":99}', 'main')
  `);
  insertSession.run(
    'root',
    ownerUserId,
    'Root task',
    '/Users/private/root',
    '{"runtimeLease":"root-secret"}',
    null,
    'source-run-root',
    '{"kind":"native","runId":"run-root","externalSessionId":"native-secret","cwd":"/Users/private/root","permissionProfile":"workspace_write"}',
    1,
    10,
    '{"connectorGrant":"secret"}',
    'workspace-root',
  );
  insertSession.run(
    'child',
    ownerUserId,
    'Child branch',
    '/Users/private/isolated-child',
    '{"forkLineage":{"untrusted":"legacy"},"queuedInputs":["secret"]}',
    'root',
    'source-run-child',
    '{"kind":"codex_cli","model":"gpt-test","runId":"run-child","externalSessionId":"provider-secret","logPath":"/tmp/provider.log","cwd":"/Users/private/isolated-child","permissionProfile":"workspace_write"}',
    2,
    20,
    '{"approvalQueue":["secret"]}',
    'workspace-child',
  );

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, timestamp, tool_calls, tool_results,
      attachments, thinking, effort_level, synced_at, content_parts, metadata,
      is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL,
              0, NULL, ?, NULL, NULL)
  `);
  insertMessage.run('u1', 'root', 'user', 'hello', 1, null, 'active');
  const sharedAssistantContent = 'answer\n```mermaid\ngraph TD\nsecret --> body\n```';
  const sharedAssistantAttachments = JSON.stringify([{
    id: 'attachment-1',
    type: 'file',
    category: 'text',
    name: 'private.txt',
    size: 12,
    mimeType: 'text/plain',
    data: 'attachment secret bytes',
    path: '/Users/private/private.txt',
    metadata: { token: 'attachment-token' },
  }]);
  insertMessage.run(
    'a1',
    'root',
    'assistant',
    sharedAssistantContent,
    2,
    sharedAssistantAttachments,
    'active',
  );
  insertMessage.run('cu1', 'child', 'user', 'hello', 1, null, 'active');
  insertMessage.run(
    'ca1',
    'child',
    'assistant',
    sharedAssistantContent,
    2,
    sharedAssistantAttachments,
    'active',
  );
  insertMessage.run('cu2', 'child', 'user', 'hidden suffix', 3, null, 'rewound');

  db.prepare(`
    INSERT INTO session_forks (
      id, source_session_id, child_session_id, root_session_id, parent_fork_id,
      anchor_message_id, anchor_child_message_id, workspace_mode,
      context_delivery_mode, idempotency_key, request_digest,
      source_prefix_digest, status, depth, sync_state, workspace_snapshot_id,
      error_json, created_at, updated_at, committed_at
    ) VALUES (
      'fork-1', 'root', 'child', 'root', NULL, 'a1', 'ca1',
      'isolated_at_anchor', 'validated_context_handoff', 'fork-key',
      'request-digest', 'prefix-digest', 'completed', 1, 'local_only',
      'intent-1', NULL, 2, 2, 2
    )
  `).run();
  const insertMapping = db.prepare(`
    INSERT INTO session_fork_message_map (
      fork_id, ordinal, source_message_id, child_message_id,
      source_timestamp, source_order_key, source_row_digest
    ) VALUES ('fork-1', ?, ?, ?, ?, ?, ?)
  `);
  insertMapping.run(0, 'u1', 'cu1', 1, '1:1', 'a'.repeat(64));
  insertMapping.run(1, 'a1', 'ca1', 2, '2:2', 'b'.repeat(64));

  const stagedPatch = Buffer.from(
    'diff --git a/staged.txt b/staged.txt\nnew file mode 100644\n--- /dev/null\n+++ b/staged.txt\n@@ -0,0 +1 @@\n+staged\n',
  );
  const unstagedPatch = Buffer.from(
    'diff --git a/live.txt b/live.txt\n--- a/live.txt\n+++ b/live.txt\n@@ -1 +1 @@\n-old\n+live\n',
  );
  const untrackedBytes = Buffer.from('portable untracked content');
  const identityFields = {
    canonicalRoot: '/Users/private/root',
    canonicalGitCommonDirectory: '/Users/private/root/.git',
    rootDevice: '1',
    rootInode: '2',
    gitCommonDevice: '1',
    gitCommonInode: '3',
    objectFormat: 'sha1',
  };
  const repositoryIdentityDigest = digestWorkspaceValue(identityFields);
  const baseCommit = 'a'.repeat(40);
  const observedHead = 'b'.repeat(40);
  const untrackedDigest = sha256Hex(untrackedBytes);
  const manifestWithoutDigest = {
    version: 1 as const,
    captureState: 'complete' as const,
    anchorId: 'a1',
    capturedAt: 2,
    baseCommit,
    baseCommitSource: 'explicit_anchor_input' as const,
    observedHead,
    workspaceScopeVersion: 'scope-v1',
    repositoryIdentity: {
      ...identityFields,
      fingerprint: repositoryIdentityDigest,
    },
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: '/Users/private/root',
      repositoryRelativePath: '.',
      isolatedRelativePath: '.',
    }],
    stagedPatch: {
      sha256: sha256Hex(stagedPatch),
      sizeBytes: stagedPatch.byteLength,
    },
    unstagedPatch: {
      sha256: sha256Hex(unstagedPatch),
      sizeBytes: unstagedPatch.byteLength,
    },
    untrackedFiles: [{
      path: 'private-untracked.txt',
      sha256: untrackedDigest,
      sizeBytes: untrackedBytes.byteLength,
      mode: 0o644,
    }],
  };
  const payload = {
    stagedPatchBase64: stagedPatch.toString('base64'),
    unstagedPatchBase64: unstagedPatch.toString('base64'),
    untrackedBlobs: { [untrackedDigest]: untrackedBytes.toString('base64') },
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
  db.prepare(`
    INSERT INTO session_fork_anchor_evidence (
      id, source_session_id, anchor_message_id, owner_user_id, project_id,
      workspace_scope_version, source_identity_digest, source_identity_json,
      message_digest, repository_root, base_commit, observed_head,
      evidence_digest, evidence_json, summary_json, status, blocked_reason,
      created_at, updated_at
    ) VALUES (
      'evidence-1', 'root', 'a1', ?, 'project-1', 'scope-v1',
      ?, ?, 'message-digest', '/Users/private/root', ?, ?,
      ?, ?, '{}', 'complete', NULL, 2, 2
    )
  `).run(
    ownerUserId,
    repositoryIdentityDigest,
    JSON.stringify(identityFields),
    baseCommit,
    observedHead,
    evidence.manifest.evidenceDigest,
    JSON.stringify(evidence),
  );
  db.prepare(`
    INSERT INTO session_fork_workspace_intents (
      intent_id, request_digest, revision, source_session_id,
      proposed_child_session_id, repository_root, workspace_path,
      evidence_digest, intent_json, status, advertisable, created_at, updated_at
    ) VALUES (
      'intent-1', 'request-digest', 1, 'root', 'child',
      '/Users/private/root', '/Users/private/isolated-child', ?,
      '{}', 'advertised', 1, 2, 2
    )
  `).run(evidence.manifest.evidenceDigest);
  db.prepare(`
    INSERT INTO session_fork_workspace_sagas (
      intent_id, source_session_id, anchor_message_id, idempotency_key,
      request_digest, evidence_id, proposed_fork_id, proposed_child_session_id,
      context_delivery_mode, child_title, workspace_path, state,
      child_session_id, error_json, created_at, updated_at
    ) VALUES (
      'intent-1', 'root', 'a1', 'fork-key', 'request-digest',
      'evidence-1', 'fork-1', 'child', 'validated_context_handoff',
      'Child branch', '/Users/private/isolated-child', 'completed',
      'child', NULL, 2, 2
    )
  `).run();

  db.prepare(`
    INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
    VALUES ('child', 'do not import', 'pending', 'secret todo', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO session_tasks (
      session_id, task_id, subject, description, active_form, status, priority,
      blocks_json, blocked_by_json, metadata_json, created_at, updated_at
    ) VALUES (
      'child', 'task-1', 'do not import', 'secret task', 'running',
      'pending', 'normal', '[]', '[]', '{}', 1, 1
    )
  `).run();
  db.prepare(`
    INSERT INTO session_rewinds (
      id, session_id, anchor_message_id, anchor_prompt, anchor_timestamp,
      checkpoint_message_id, hidden_message_count, hidden_message_ids,
      files_restored, files_deleted, errors_json, idempotency_key,
      request_digest, status, restored_at, created_at
    ) VALUES (
      'rewind-child-cu2', 'child', 'cu2', 'hidden suffix', 3,
      NULL, 1, '["cu2"]', 0, 0, '[]', 'rewind-child-key',
      'rewind-child-digest', 'completed', NULL, 3
    )
  `).run();
  applyConversationBranchSchema(db);
}

describe('SessionForkPortabilityRepository', () => {
  let db: BetterSqlite3.Database;
  let repository: SessionForkPortabilityRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAllSchema(db);
    seedLineage(db);
    repository = new SessionForkPortabilityRepository(db);
  });

  afterEach(() => db.close());

  it('persists a source-backed subtree with complete content bytes but no runtime identity or absolute paths', () => {
    const sourceSessionsBefore = JSON.stringify(
      db.prepare("SELECT * FROM sessions WHERE id IN ('root', 'child') ORDER BY id").all(),
    );
    const sourceMessagesBefore = JSON.stringify(
      db.prepare("SELECT * FROM messages WHERE session_id IN ('root', 'child') ORDER BY rowid").all(),
    );

    const envelope = repository.exportSessionFork({
      exportId: 'export-subtree',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });

    expect(envelope.sessions.map((session) => session.id)).toEqual(['root', 'child']);
    expect(envelope.lineage.nodes).toEqual([
      expect.objectContaining({ sessionId: 'root', parentSessionId: null, depth: 0 }),
      expect.objectContaining({
        sessionId: 'child',
        parentSessionId: 'root',
        forkId: 'fork-1',
        workspaceMode: 'isolated_at_anchor',
      }),
    ]);
    expect(envelope.sessions.find((session) => session.id === 'child')?.workspace)
      .toMatchObject({
        mode: 'isolated_at_anchor',
        isolatedAnchor: {
          evidenceId: 'evidence-1',
          baseCommit: 'a'.repeat(40),
          pathMappings: [{ relativePath: '.' }],
          content: {
            version: 1,
            untrackedFiles: [{
              relativePath: 'private-untracked.txt',
              mode: 0o644,
            }],
          },
        },
      });
    const isolatedContent = envelope.sessions
      .find((session) => session.id === 'child')
      ?.workspace?.isolatedAnchor?.content;
    expect(isolatedContent && Object.values(isolatedContent.blobs)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(Buffer.from('diff --git a/staged.txt').toString('base64').slice(0, 12)),
        Buffer.from('portable untracked content').toString('base64'),
      ]),
    );
    const exportedAttachmentDigest = envelope.messages
      .find((message) => message.id === 'a1')
      ?.attachments?.[0]?.contentDigest;
    expect(exportedAttachmentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('attachment secret bytes');
    expect(serialized).not.toContain('attachment-token');
    expect(serialized).not.toContain('secret --> body');
    expect(JSON.stringify(db.prepare("SELECT * FROM sessions WHERE id IN ('root', 'child') ORDER BY id").all()))
      .toBe(sourceSessionsBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM messages WHERE session_id IN ('root', 'child') ORDER BY rowid").all()))
      .toBe(sourceMessagesBefore);
    expect(repository.getDurableEnvelope(
      'export-subtree',
      'owner-1',
      'project-1',
    )).toEqual(envelope);
  });

  it('builds detached child provenance without attaching an unavailable parent', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-detached',
      rootSessionId: 'child',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'detached_child',
      exportedAt: 101,
    });

    expect(envelope.sessions).toHaveLength(1);
    expect(envelope.lineage.nodes).toEqual([
      expect.objectContaining({
        sessionId: 'child',
        parentSessionId: null,
        forkId: null,
        depth: 0,
      }),
    ]);
    expect(envelope.detachedProvenance).toMatchObject({
      sourceRootSessionId: 'root',
      sourceParentSessionId: 'root',
      sourceForkId: 'fork-1',
      sourceAnchorMessageId: 'a1',
      sourceDepth: 1,
    });
    const result = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'detached-device',
      importedAt: 201,
    });
    const imported = db.prepare(`
      SELECT parent_session_id, metadata
      FROM sessions
      WHERE id = ?
    `).get(result.rootSessionId) as {
      parent_session_id: string | null;
      metadata: string;
    };
    expect(imported.parent_session_id).toBeNull();
    expect(JSON.parse(imported.metadata)).toMatchObject({
      portableDetachedForkProvenanceV1: {
        sourceRootSessionId: 'root',
        sourceParentSessionId: 'root',
        sourceForkId: 'fork-1',
        sourceAnchorMessageId: 'a1',
      },
    });
  });

  it('rejects a legacy isolated detached root without explicit child-anchor evidence with zero writes', () => {
    const current = repository.exportSessionFork({
      exportId: 'export-detached-legacy',
      rootSessionId: 'child',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'detached_child',
      exportedAt: 101,
    });
    const legacy = structuredClone(current);
    delete legacy.sessions[0].workspace?.anchorChildMessageId;
    const envelope = rehashSessionExportEnvelopeV2(legacy);
    const sessionsBefore = db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
    const importsBefore = db.prepare(`
      SELECT COUNT(*) AS count FROM session_fork_portability_imports
    `).get();
    const changesBefore = totalChanges(db);

    expect(() => repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'legacy-detached-device',
      importedAt: 201,
    })).toThrow(/PORTABLE_EVIDENCE_REQUIRED.*explicit child anchor/u);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual(sessionsBefore);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_fork_portability_imports
    `).get()).toEqual(importsBefore);
    expect(totalChanges(db)).toBe(changesBefore);
  });

  it('uses an explicit portable boundary for local sessions without inventing a persisted user', () => {
    db.close();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAllSchema(db);
    seedLineage(db, null);
    repository = new SessionForkPortabilityRepository(db);
    const envelope = repository.exportSessionFork({
      exportId: 'export-local',
      rootSessionId: 'root',
      ownerScopeId: LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 102,
    });
    const result = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
      targetProjectId: 'project-1',
      namespace: 'local-device-b',
      importedAt: 202,
    });

    expect(db.prepare('SELECT user_id FROM sessions WHERE id = ?')
      .get(result.rootSessionId)).toEqual({ user_id: null });
    expect(new ConversationBranchRepository(db).auditLineage(
      result.rootSessionId,
      { ownerUserId: null, projectId: 'project-1' },
    )).toMatchObject({ status: 'healthy', issues: [] });
  });

  it('fails exact owner/project boundaries and incomplete isolated evidence with zero durable writes', () => {
    expect(() => repository.exportSessionFork({
      exportId: 'wrong-owner',
      rootSessionId: 'root',
      ownerScopeId: 'attacker',
      projectId: 'project-1',
      mode: 'subtree',
    })).toThrow(/OWNER_SCOPE_MISMATCH|SESSION/);
    expect(() => repository.exportSessionFork({
      exportId: 'wrong-project',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'other-project',
      mode: 'subtree',
    })).toThrow(/PROJECT_SCOPE_MISMATCH|SESSION/);
    db.prepare("UPDATE session_fork_anchor_evidence SET status = 'blocked' WHERE id = 'evidence-1'").run();
    const afterEvidenceMutation = totalChanges(db);
    expect(() => repository.exportSessionFork({
      exportId: 'incomplete-evidence',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
    })).toThrow(/EVIDENCE|isolated/i);
    expect(totalChanges(db)).toBe(afterEvidenceMutation);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_fork_portability_exports').get())
      .toEqual({ count: 0 });
  });

  it('imports a fully remapped lineage atomically and clears runtime/task/authorization state', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-import',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const exportedAttachmentDigest = envelope.messages
      .find((message) => message.id === 'a1')
      ?.attachments?.[0]?.contentDigest;
    const plan = planSessionForkImport({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-b',
    });

    const result = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-b',
      importedAt: 200,
    });

    expect(result.rootSessionId).toBe(plan.envelope.rootSessionId);
    expect(result.sessionIdMap).toEqual(plan.sessionIdMap);
    expect(result.messageIdMap).toEqual(plan.messageIdMap);
    expect(result.forkIdMap).toEqual(plan.forkIdMap);

    const importedChildId = plan.sessionIdMap.child;
    const importedChild = db.prepare(`
      SELECT user_id, project_id, working_directory, parent_session_id,
             source_run_id, agent_engine, metadata, workbench_provenance,
             last_token_usage, status, read_only
      FROM sessions WHERE id = ?
    `).get(importedChildId) as Record<string, unknown>;
    expect(importedChild).toMatchObject({
      user_id: 'owner-1',
      project_id: 'project-1',
      working_directory: null,
      parent_session_id: plan.sessionIdMap.root,
      source_run_id: null,
      workbench_provenance: null,
      last_token_usage: null,
      status: 'idle',
      read_only: 1,
    });
    expect(JSON.parse(String(importedChild.agent_engine))).toEqual({
      kind: 'codex_cli',
      model: 'gpt-test',
      permissionProfile: 'read_only',
      origin: 'import',
    });
    expect(JSON.parse(String(importedChild.metadata))).toMatchObject({
      forkLineage: {
        forkId: plan.forkIdMap['fork-1'],
        parentSessionId: plan.sessionIdMap.root,
        childSessionId: importedChildId,
      },
      portableWorkspaceV2: {
        mode: 'isolated_at_anchor',
      },
      portabilityPublicationBarrierV1: {
        sourceExportId: envelope.exportId,
        desiredReadOnly: false,
        workspaceMode: 'isolated_at_anchor',
      },
    });
    expect(db.prepare(`
      SELECT id, read_only
      FROM sessions
      WHERE id IN (?, ?)
      ORDER BY id
    `).all(plan.sessionIdMap.root, importedChildId)).toEqual(expect.arrayContaining([
      { id: importedChildId, read_only: 1 },
      { id: plan.sessionIdMap.root, read_only: 1 },
    ]));
    const importedRootMetadata = db.prepare(`
      SELECT metadata FROM sessions WHERE id = ?
    `).get(plan.sessionIdMap.root) as { metadata: string };
    expect(JSON.parse(importedRootMetadata.metadata)).toMatchObject({
      portabilityPublicationBarrierV1: {
        sourceExportId: envelope.exportId,
        desiredReadOnly: false,
        workspaceMode: 'shared_current',
      },
    });
    const importedJson = JSON.stringify(
      db.prepare('SELECT * FROM sessions WHERE id IN (?, ?) ORDER BY id')
        .all(plan.sessionIdMap.root, importedChildId),
    );
    expect(importedJson).not.toContain('/Users/private');
    expect(importedJson).not.toContain('provider-secret');
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM todos WHERE session_id IN (?, ?)
    `).get(plan.sessionIdMap.root, importedChildId)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_tasks WHERE session_id IN (?, ?)
    `).get(plan.sessionIdMap.root, importedChildId)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_forks WHERE id = ?
    `).get(plan.forkIdMap['fork-1'])).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_fork_message_map WHERE fork_id = ?
    `).get(plan.forkIdMap['fork-1'])).toEqual({ count: 2 });
    const branchRepo = new ConversationBranchRepository(db);
    const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' };
    expect(branchRepo.replay(plan.sessionIdMap.root, boundary).messages.map((message) => (
      message.projectedMessageId
    ))).toEqual([plan.messageIdMap.u1, plan.messageIdMap.a1]);
    expect(branchRepo.replay(importedChildId, boundary).messages.map((message) => (
      message.projectedMessageId
    ))).toEqual([plan.messageIdMap.cu1, plan.messageIdMap.ca1]);
    expect(branchRepo.compareBranches({
      leftSessionId: plan.sessionIdMap.root,
      rightSessionId: importedChildId,
      boundary,
    })).toMatchObject({
      sharedPrefixLength: 2,
      leftOnly: [],
      rightOnly: [],
    });
    expect(branchRepo.auditLineage(importedChildId, boundary)).toMatchObject({
      status: 'healthy',
      issues: [],
    });
    const importedRootAssistantId = plan.messageIdMap.a1;
    const importedAttachmentRow = db.prepare(`
      SELECT entry.message_json
      FROM conversation_branch_entries AS reference
      JOIN conversation_branches AS branch ON branch.id = reference.branch_id
      JOIN conversation_entries AS entry ON entry.id = reference.entry_id
      WHERE branch.session_id = ? AND reference.projected_message_id = ?
      ORDER BY reference.ordinal DESC
      LIMIT 1
    `).get(
      plan.sessionIdMap.root,
      importedRootAssistantId,
    ) as { message_json: string } | undefined;
    const importedAttachmentProvenance = JSON.parse(String(
      importedAttachmentRow?.message_json ?? '{}',
    )) as {
      readOnlyAttachmentProvenance?: Array<{ contentDigest?: string }>;
    };
    expect(importedAttachmentProvenance.readOnlyAttachmentProvenance?.[0]?.contentDigest)
      .toBe(exportedAttachmentDigest?.replace(/^sha256:/u, ''));

    expect(repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-b',
      importedAt: 300,
    })).toEqual(result);
    const reexported = repository.exportSessionFork({
      exportId: 'reexport-imported-lineage',
      rootSessionId: result.rootSessionId,
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 400,
    });
    expect(reexported.conversationHistory?.events.map((event) => event.eventType))
      .toEqual(expect.arrayContaining(['append', 'fork', 'rewind']));
    expect(reexported.lineage.nodes).toHaveLength(2);
  });

  it('rejects an idempotent import lookup when its compatibility projection was tampered', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-import-tamper',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const result = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-tamper',
      importedAt: 200,
    });
    db.prepare(`
      UPDATE messages
      SET content = 'tampered after completed import'
      WHERE id = ?
    `).run(result.messageIdMap.a1);
    const changesBeforeRetry = totalChanges(db);

    expect(() => repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-tamper',
      importedAt: 300,
    })).toThrow(
      /changed its compatibility projection|failed immutable replay|PROJECTION_ALIAS_PAYLOAD_MISMATCH/u,
    );
    expect(totalChanges(db)).toBe(changesBeforeRetry);
  });

  it('fails closed when an idempotent import target was soft-deleted', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-import-deleted',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const result = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-deleted',
      importedAt: 200,
    });
    db.prepare('UPDATE sessions SET is_deleted = 1 WHERE id = ?')
      .run(result.rootSessionId);
    const changesBeforeRetry = totalChanges(db);

    expect(() => repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'device-deleted',
      importedAt: 300,
    })).toThrow(/REFERENCE_NOT_CLOSED.*deleted/u);
    expect(totalChanges(db)).toBe(changesBeforeRetry);
  });

  it('roundtrips revisions, projection replacement, Fork, Rewind, and evaluation attribution', () => {
    db.prepare(`
      INSERT INTO sessions (
        id, user_id, title, model_provider, model_name, working_directory,
        project_id, session_type, origin, metadata, parent_session_id,
        source_run_id, agent_engine, memory_mode, suppressed_memory_entry_ids,
        read_only, created_at, updated_at, workbench_provenance, is_deleted,
        synced_at, status, workspace, last_token_usage, git_branch
      ) VALUES (
        'evo-root', 'owner-1', 'Evolution root', 'openai', 'gpt-test', NULL,
        'project-1', 'chat', '{"kind":"manual"}', NULL, NULL,
        NULL, '{"kind":"native"}', 'auto', '[]',
        0, 100, 100, NULL, 0, NULL, 'idle', NULL, NULL, NULL
      )
    `).run();
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, tool_calls, tool_results,
        attachments, thinking, effort_level, synced_at, content_parts, metadata,
        is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                0, NULL, 'active', NULL, NULL)
    `);
    const sourceMessages = [
      ['evo-u1', 'user', 'one', 101],
      ['evo-a1', 'assistant', 'answer one', 102],
      ['evo-u2', 'user', 'two', 103],
      ['evo-a2', 'assistant', 'answer two', 104],
      ['evo-u3', 'user', 'source suffix', 105],
    ] as const;
    for (const [id, role, content, timestamp] of sourceMessages) {
      insertMessage.run(id, 'evo-root', role, content, timestamp);
    }
    const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
    const branchRepository = new ConversationBranchRepository(db);
    branchRepository.initializeSessionBranch({
      sessionId: 'evo-root',
      boundary,
      createdAt: 100,
    });
    for (const [id, role, content, timestamp] of sourceMessages) {
      branchRepository.appendMessage({
        sessionId: 'evo-root',
        boundary,
        message: { id, role, content, timestamp },
        idempotencyKey: `append:${id}`,
        createdAt: timestamp,
      });
    }
    db.prepare("UPDATE messages SET content = 'answer one revised' WHERE id = 'evo-a1'").run();
    branchRepository.recordMessageRevision({
      sessionId: 'evo-root',
      boundary,
      targetMessageId: 'evo-a1',
      revisedMessage: {
        id: 'evo-a1',
        role: 'assistant',
        content: 'answer one revised',
        timestamp: 102,
      },
      idempotencyKey: 'revision:evo-a1',
      reason: 'test revision before fork',
      createdAt: 106,
    });
    branchRepository.recordProjectionReplacement({
      sessionId: 'evo-root',
      boundary,
      messages: sourceMessages.map(([id, role, content, timestamp]) => ({
        id,
        role,
        content: id === 'evo-a1' ? 'answer one revised' : content,
        timestamp,
      })),
      idempotencyKey: 'projection:evo-root',
      reason: 'test projection before fork',
      createdAt: 107,
    });
    const createdFork = new SessionForkRepository(db, branchRepository).createFork({
      sourceSessionId: 'evo-root',
      anchorAssistantMessageId: 'evo-a2',
      idempotencyKey: 'fork:evo-a2',
      ownerUserId: 'owner-1',
      forkId: 'evo-fork',
      childSessionId: 'evo-child',
      childTitle: 'Evolution child',
      workspaceMode: 'shared_current',
      contextDeliveryMode: 'neo_native_prefix',
      now: 108,
    });
    insertMessage.run('evo-child-u3', 'evo-child', 'user', 'child suffix', 109);
    branchRepository.appendMessage({
      sessionId: 'evo-child',
      boundary,
      message: {
        id: 'evo-child-u3',
        role: 'user',
        content: 'child suffix',
        timestamp: 109,
      },
      idempotencyKey: 'append:evo-child-u3',
      createdAt: 109,
    });
    db.prepare(`
      UPDATE messages
      SET visibility = 'rewound', hidden_by_rewind_id = 'evo-rewind', hidden_at = 110
      WHERE id = 'evo-child-u3'
    `).run();
    branchRepository.recordRewind({
      sessionId: 'evo-child',
      boundary,
      anchorMessageId: 'evo-child-u3',
      hiddenMessageIds: ['evo-child-u3'],
      rewindId: 'evo-rewind',
      idempotencyKey: 'rewind:evo-child-u3',
      createdAt: 110,
    });
    branchRepository.recordEvaluationAttribution({
      sessionId: 'evo-child',
      boundary,
      evaluationId: 'evo-evaluation',
      runId: 'local-eval-run',
      metric: 'quality',
      value: 0.9,
      attributedMessageIds: [createdFork.lineage.anchorChildMessageId],
      idempotencyKey: 'evaluation:evo-child',
      createdAt: 111,
    });

    const envelope = repository.exportSessionFork({
      exportId: 'export-evolution',
      rootSessionId: 'evo-root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 120,
    });
    expect(envelope.conversationHistory?.events.map((event) => event.eventType))
      .toEqual(expect.arrayContaining([
        'message_revision',
        'projection_replace',
        'fork',
        'rewind',
        'evaluation_attribution',
      ]));
    const imported = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'evolution-device',
      importedAt: 130,
    });
    const importedRootId = imported.sessionIdMap['evo-root'];
    const importedChildId = imported.sessionIdMap['evo-child'];
    expect(branchRepository.compareBranches({
      leftSessionId: importedRootId,
      rightSessionId: importedChildId,
      boundary,
    }).sharedPrefixLength).toBe(4);
    expect(branchRepository.replay(importedChildId, boundary).messages).toHaveLength(4);
    expect(branchRepository.replay(
      importedChildId,
      boundary,
      { includeRewound: true },
    ).messages).toHaveLength(5);
    expect(branchRepository.listEvaluationAttributions(importedChildId, boundary))
      .toEqual([expect.objectContaining({
        evaluationId: expect.stringMatching(/^import_evaluation_/u),
        runId: null,
        metric: 'quality',
        value: 0.9,
      })]);
    expect(repository.exportSessionFork({
      exportId: 'reexport-evolution',
      rootSessionId: importedRootId,
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 140,
    }).conversationHistory?.events.map((event) => event.eventType))
      .toEqual(expect.arrayContaining([
        'message_revision',
        'projection_replace',
        'fork',
        'rewind',
        'evaluation_attribution',
      ]));
  });

  it('replays projection repair with target-native quarantine evidence and atomic recovery', () => {
    const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
    const branchRepository = new ConversationBranchRepository(db);
    db.prepare(`
      UPDATE messages
      SET content = 'temporary source projection divergence'
      WHERE session_id = 'child' AND id = 'ca1'
    `).run();
    const sourceQuarantine = branchRepository.auditAndQuarantine({
      sessionId: 'child',
      boundary,
      idempotencyKey: 'source-projection-quarantine',
      createdAt: 30,
    });
    expect(sourceQuarantine.issues.map((issue) => issue.code))
      .toEqual(['PROJECTION_ALIAS_PAYLOAD_MISMATCH']);
    expect(branchRepository.repairCompatibilityProjection({
      sessionId: 'child',
      boundary,
      issueDigest: sourceQuarantine.issueDigest,
      reason: 'Restore the source compatibility projection from immutable replay.',
      idempotencyKey: 'source-projection-repair',
      createdAt: 31,
    })).toMatchObject({ status: 'healthy', issues: [] });

    const envelope = repository.exportSessionFork({
      exportId: 'export-projection-repair',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 40,
    });
    const sourceEvents = envelope.conversationHistory?.events ?? [];
    const sourceQuarantineEvent = sourceEvents.find((event) => (
      event.eventType === 'quarantine' && event.branchId === sourceEvents
        .find((candidate) => candidate.eventType === 'projection_repair')?.branchId
    ));
    const sourceRepairEvent = sourceEvents.find((event) => event.eventType === 'projection_repair');
    expect(sourceQuarantineEvent?.payload.issueDigest).toBe(sourceQuarantine.issueDigest);
    expect(sourceRepairEvent?.payload).toMatchObject({
      issueDigest: sourceQuarantine.issueDigest,
      quarantineEventId: sourceQuarantineEvent?.id,
    });

    for (const faultPhase of ['after_projection_write', 'after_event_append'] as const) {
      const namespace = `projection-repair-fault-${faultPhase}`;
      const failedPlan = planSessionForkImport({
        envelope,
        targetOwnerScopeId: 'owner-1',
        targetProjectId: 'project-1',
        namespace,
      });
      const faultingRepository = new SessionForkPortabilityRepository(
        db,
        new ConversationBranchRepository(db, {
          projectionRepairFaultInjector: (phase) => {
            if (phase === faultPhase) {
              throw new Error(`injected portable projection repair failure at ${phase}`);
            }
          },
        }),
      );
      expect(() => faultingRepository.importSessionFork({
        envelope,
        targetOwnerScopeId: 'owner-1',
        targetProjectId: 'project-1',
        namespace,
        importedAt: 50,
      })).toThrow(`injected portable projection repair failure at ${faultPhase}`);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE id IN (?, ?)
      `).get(
        failedPlan.sessionIdMap.root,
        failedPlan.sessionIdMap.child,
      )).toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_fork_portability_imports
        WHERE source_export_id = 'export-projection-repair'
          AND import_namespace = ?
      `).get(namespace)).toEqual({ count: 0 });
    }

    const imported = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'projection-repair-device',
      importedAt: 60,
    });
    const importedChildId = imported.sessionIdMap.child;
    expect(branchRepository.auditLineage(importedChildId, boundary))
      .toMatchObject({ status: 'healthy', issues: [] });
    const targetEvents = db.prepare(`
      SELECT id, event_type, payload_json
      FROM conversation_branch_events
      WHERE branch_id = (
        SELECT id FROM conversation_branches WHERE session_id = ?
      )
        AND event_type IN ('quarantine', 'projection_repair')
      ORDER BY sequence ASC
    `).all(importedChildId) as Array<{ id: string; event_type: string; payload_json: string }>;
    expect(targetEvents.map((event) => event.event_type))
      .toEqual(['quarantine', 'projection_repair']);
    const targetQuarantinePayload = JSON.parse(targetEvents[0].payload_json) as {
      issueDigest: string;
      issues: Array<{ code: string }>;
    };
    const targetRepairPayload = JSON.parse(targetEvents[1].payload_json) as {
      issueDigest: string;
      quarantineEventId: string;
    };
    expect(targetQuarantinePayload.issueDigest).not.toBe(sourceQuarantine.issueDigest);
    expect(targetQuarantinePayload.issues.map((issue) => issue.code))
      .toEqual(['PROJECTION_ALIAS_PAYLOAD_MISMATCH']);
    expect(targetRepairPayload.issueDigest).toBe(targetQuarantinePayload.issueDigest);
    expect(targetRepairPayload.quarantineEventId).toBe(targetEvents[0].id);
    expect(targetRepairPayload.quarantineEventId).not.toBe(sourceQuarantineEvent?.id);
    expect(JSON.stringify(targetEvents)).not.toContain(sourceQuarantine.issueDigest);
    expect(JSON.stringify(targetEvents)).not.toContain('temporary source projection divergence');

    const eventCountBeforeRetry = db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branch_events
      WHERE branch_id = (
        SELECT id FROM conversation_branches WHERE session_id = ?
      )
    `).get(importedChildId);
    expect(repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'projection-repair-device',
      importedAt: 70,
    })).toEqual(imported);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branch_events
      WHERE branch_id = (
        SELECT id FROM conversation_branches WHERE session_id = ?
      )
    `).get(importedChildId)).toEqual(eventCountBeforeRetry);

    const reexportedEvents = repository.exportSessionFork({
      exportId: 'reexport-projection-repair',
      rootSessionId: imported.rootSessionId,
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 80,
    }).conversationHistory?.events.filter((event) => (
      event.eventType === 'quarantine' || event.eventType === 'projection_repair'
    )) ?? [];
    expect(reexportedEvents.map((event) => event.eventType))
      .toEqual(['quarantine', 'projection_repair']);
    expect(reexportedEvents[0].payload.issueDigest).toBe(targetQuarantinePayload.issueDigest);
    expect(reexportedEvents[1].payload).toMatchObject({
      issueDigest: targetQuarantinePayload.issueDigest,
      quarantineEventId: reexportedEvents[0].id,
    });
  });

  it.each([
    'PROJECTION_ALIAS_MISSING',
    'PROJECTION_ALIAS_EXTRA',
    'PROJECTION_ALIAS_ORDER_MISMATCH',
  ] as const)('reconstructs exact target-native %s evidence before repair', (issueType) => {
    const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
    const branchRepository = new ConversationBranchRepository(db);
    if (issueType === 'PROJECTION_ALIAS_MISSING') {
      db.prepare(`
        UPDATE messages
        SET visibility = 'rewound', hidden_by_rewind_id = 'source-missing', hidden_at = 30
        WHERE session_id = 'child' AND id = 'ca1'
      `).run();
    } else if (issueType === 'PROJECTION_ALIAS_EXTRA') {
      db.prepare(`
        INSERT INTO messages (
          id, session_id, role, content, timestamp, is_meta, visibility
        ) VALUES (
          'source-extra', 'child', 'system', 'source extra projection', 4, 1, 'active'
        )
      `).run();
    } else {
      db.prepare(`
        UPDATE messages SET timestamp = 3
        WHERE session_id = 'child' AND id = 'cu1'
      `).run();
    }
    const sourceQuarantine = branchRepository.auditAndQuarantine({
      sessionId: 'child',
      boundary,
      idempotencyKey: `source-quarantine-${issueType}`,
      createdAt: 31,
    });
    expect([...new Set(sourceQuarantine.issues.map((issue) => issue.code))])
      .toEqual([issueType]);
    expect(branchRepository.repairCompatibilityProjection({
      sessionId: 'child',
      boundary,
      issueDigest: sourceQuarantine.issueDigest,
      reason: `Restore exact ${issueType} compatibility evidence from immutable replay.`,
      idempotencyKey: `source-repair-${issueType}`,
      createdAt: 32,
    })).toMatchObject({ status: 'healthy', issues: [] });
    const envelope = repository.exportSessionFork({
      exportId: `export-${issueType}`,
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 40,
    });
    const imported = repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: `target-${issueType}`,
      importedAt: 50,
    });
    expect(branchRepository.auditLineage(imported.sessionIdMap.child, boundary))
      .toMatchObject({ status: 'healthy', issues: [] });
    const targetQuarantine = db.prepare(`
      SELECT payload_json
      FROM conversation_branch_events
      WHERE branch_id = (
        SELECT id FROM conversation_branches WHERE session_id = ?
      )
        AND event_type = 'quarantine'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(imported.sessionIdMap.child) as { payload_json: string };
    const targetPayload = JSON.parse(targetQuarantine.payload_json) as {
      issueDigest: string;
      issues: Array<{ code: string }>;
    };
    expect([...new Set(targetPayload.issues.map((issue) => issue.code))])
      .toEqual([issueType]);
    expect(targetPayload.issueDigest).not.toBe(sourceQuarantine.issueDigest);
  });

  it.each([
    ['quarantined', false],
    ['override_active', true],
  ] as const)(
    'preserves exact %s audit closure on first and repeated import',
    (expectedStatus, withOverride) => {
      const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
      const branchRepository = new ConversationBranchRepository(db);
      const baselineEnvelope = repository.exportSessionFork({
        exportId: `export-${expectedStatus}`,
        rootSessionId: 'root',
        ownerScopeId: 'owner-1',
        projectId: 'project-1',
        mode: 'subtree',
        exportedAt: 29,
      });
      db.prepare(`
        UPDATE messages
        SET content = 'portable quarantined projection'
        WHERE session_id = 'child' AND id = 'ca1'
      `).run();
      const sourceQuarantine = branchRepository.auditAndQuarantine({
        sessionId: 'child',
        boundary,
        idempotencyKey: `source-${expectedStatus}-quarantine`,
        createdAt: 30,
      });
      if (withOverride) {
        expect(branchRepository.recordRepairOverride({
          sessionId: 'child',
          boundary,
          issueDigest: sourceQuarantine.issueDigest,
          reason: 'Operator accepted the exact quarantined compatibility evidence.',
          idempotencyKey: 'source-override-repair',
          createdAt: 31,
        }).status).toBe('override_active');
      }
      const history = (new SessionForkPortabilitySourceReader(db) as unknown as {
        readPortableConversationHistory: (
          sessionIds: string[],
          exportRootSessionId: string,
          ownerScopeId: string,
          projectId: string,
        ) => NonNullable<(typeof baselineEnvelope)['conversationHistory']>;
      }).readPortableConversationHistory(
        ['root', 'child'],
        'root',
        'owner-1',
        'project-1',
      );
      const envelopeDraft = structuredClone(baselineEnvelope);
      const divergentChildMessage = envelopeDraft.messages.find((message) => (
        message.sessionId === 'child' && message.id === 'ca1'
      ));
      if (!divergentChildMessage) throw new Error('portable child projection fixture is missing');
      divergentChildMessage.content = 'portable quarantined projection';
      envelopeDraft.conversationHistory = history;
      const envelope = rehashSessionExportEnvelopeV2(envelopeDraft);
      const imported = repository.importSessionFork({
        envelope,
        targetOwnerScopeId: 'owner-1',
        targetProjectId: 'project-1',
        namespace: `${expectedStatus}-device`,
        importedAt: 50,
      });
      const importedChildId = imported.sessionIdMap.child;
      const importedAudit = branchRepository.auditLineage(importedChildId, boundary);
      expect(importedAudit.status).toBe(expectedStatus);
      expect(importedAudit.issueDigest).not.toBe(sourceQuarantine.issueDigest);
      expect(importedAudit.quarantineEventId).toBeTruthy();
      if (withOverride) expect(importedAudit.repairOverrideEventId).toBeTruthy();

      const eventCountBeforeRetry = db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE branch_id = (
          SELECT id FROM conversation_branches WHERE session_id = ?
        )
      `).get(importedChildId);
      expect(repository.importSessionFork({
        envelope,
        targetOwnerScopeId: 'owner-1',
        targetProjectId: 'project-1',
        namespace: `${expectedStatus}-device`,
        importedAt: 60,
      })).toEqual(imported);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE branch_id = (
          SELECT id FROM conversation_branches WHERE session_id = ?
        )
      `).get(importedChildId)).toEqual(eventCountBeforeRetry);

      db.prepare(`
        UPDATE messages
        SET content = 'post-import audit closure tamper'
        WHERE session_id = ? AND id = ?
      `).run(importedChildId, imported.messageIdMap.ca1);
      const changesBeforeRejectedRetry = totalChanges(db);
      expect(() => repository.importSessionFork({
        envelope,
        targetOwnerScopeId: 'owner-1',
        targetProjectId: 'project-1',
        namespace: `${expectedStatus}-device`,
        importedAt: 70,
      })).toThrow(/changed its compatibility projection|failed immutable replay closure|audit digest|audit status/u);
      expect(totalChanges(db)).toBe(changesBeforeRejectedRetry);
    },
  );

  it('rolls back every imported row when mapping persistence fails', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-failure',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const plan = planSessionForkImport({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'failing-device',
    });
    db.exec(`
      CREATE TRIGGER inject_portability_mapping_failure
      BEFORE INSERT ON session_fork_message_map
      WHEN NEW.fork_id LIKE 'import_failing-device_%'
      BEGIN
        SELECT RAISE(ABORT, 'injected portability mapping failure');
      END
    `);

    expect(() => repository.importSessionFork({
      envelope,
      targetOwnerScopeId: 'owner-1',
      targetProjectId: 'project-1',
      namespace: 'failing-device',
      importedAt: 200,
    })).toThrow(/injected portability mapping failure/);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE id IN (?, ?)
    `).get(plan.sessionIdMap.root, plan.sessionIdMap.child)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_forks WHERE id = ?
    `).get(plan.forkIdMap['fork-1'])).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM session_fork_portability_imports
      WHERE source_export_id = 'export-failure'
    `).get()).toEqual({ count: 0 });
  });

  it('persists outbox/inbox state, disables upload by default, and recovers interrupted pending upload', async () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-sync',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    repository.enqueueOutbound({
      syncEnvelopeId: 'sync-1',
      envelope,
      dependencyIds: [],
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      now: 200,
    });
    const transport = new FakeSessionForkSyncTransport();

    await expect(repository.flushOutbound(
      'sync-1',
      'owner-1',
      'project-1',
      { transport },
    )).rejects.toThrow(/REMOTE_UPLOAD_DISABLED/);
    expect(transport.uploadCount).toBe(0);
    expect(repository.getSyncRecord('outbox', 'sync-1', 'owner-1', 'project-1')?.state)
      .toBe('local_only');

    db.prepare(`
      UPDATE session_fork_portability_sync
      SET state = 'pending', reason = NULL
      WHERE direction = 'outbox' AND sync_envelope_id = 'sync-1'
    `).run();
    const restarted = new SessionForkPortabilityRepository(db);
    expect(restarted.recoverInterruptedSync(300)).toBe(1);
    expect(restarted.getSyncRecord('outbox', 'sync-1', 'owner-1', 'project-1'))
      .toMatchObject({ state: 'local_only', reason: 'RECOVERED_PENDING_UPLOAD' });

    await restarted.flushOutbound(
      'sync-1',
      'owner-1',
      'project-1',
      { transport, remoteUploadEnabled: true },
    );
    expect(transport.uploadCount).toBe(1);
    expect(restarted.getSyncRecord('outbox', 'sync-1', 'owner-1', 'project-1')?.state)
      .toBe('applied');
  });

  it('never returns or mutates a duplicate sync id across owner or Project boundaries', () => {
    const envelope = repository.exportSessionFork({
      exportId: 'export-scoped-sync',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const wire = {
      syncEnvelopeId: 'sync-scoped',
      payloadDigest: envelope.payloadDigest,
      dependencyIds: [],
      envelope,
    };
    repository.ingestInbound({
      wire,
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      now: 200,
    });
    const before = JSON.stringify(db.prepare(`
      SELECT * FROM session_fork_portability_sync
      WHERE direction = 'inbox' AND sync_envelope_id = 'sync-scoped'
    `).get());

    expect(() => repository.ingestInbound({
      wire,
      ownerScopeId: 'owner-2',
      projectId: 'project-1',
      now: 201,
    })).toThrow('OWNER_SCOPE_MISMATCH');
    expect(() => repository.ingestInbound({
      wire,
      ownerScopeId: 'owner-1',
      projectId: 'project-2',
      now: 202,
    })).toThrow('PROJECT_SCOPE_MISMATCH');
    expect(JSON.stringify(db.prepare(`
      SELECT * FROM session_fork_portability_sync
      WHERE direction = 'inbox' AND sync_envelope_id = 'sync-scoped'
    `).get())).toBe(before);

    repository.enqueueOutbound({
      syncEnvelopeId: 'sync-scoped-out',
      envelope,
      dependencyIds: [],
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      now: 203,
    });
    expect(() => repository.enqueueOutbound({
      syncEnvelopeId: 'sync-scoped-out',
      envelope,
      dependencyIds: [],
      ownerScopeId: 'owner-2',
      projectId: 'project-1',
      now: 204,
    })).toThrow('OWNER_SCOPE_MISMATCH');
  });

  it('quarantines inbound dependencies durably and promotes them after the parent applies', () => {
    const parent = repository.exportSessionFork({
      exportId: 'export-parent',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const child = repository.exportSessionFork({
      exportId: 'export-child',
      rootSessionId: 'child',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'detached_child',
      exportedAt: 101,
    });
    repository.ingestInbound({
      wire: {
        syncEnvelopeId: 'sync-child',
        payloadDigest: child.payloadDigest,
        dependencyIds: ['sync-parent'],
        envelope: child,
      },
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      now: 200,
    });
    expect(repository.getSyncRecord('inbox', 'sync-child', 'owner-1', 'project-1'))
      .toMatchObject({ state: 'quarantined', reason: 'DEPENDENCY_NOT_APPLIED' });
    db.prepare(`
      INSERT INTO session_fork_portability_sync (
        direction, sync_envelope_id, owner_scope_id, project_id,
        payload_digest, dependency_ids_json, envelope_json, state,
        reason, attempt_count, created_at, updated_at
      ) VALUES ('inbox', 'sync-other-owner', 'owner-2', 'project-2',
        ?, '["sync-parent"]', ?, 'quarantined',
        'DEPENDENCY_NOT_APPLIED', 0, 200, 200)
    `).run(parent.payloadDigest, JSON.stringify(parent));

    repository.ingestInbound({
      wire: {
        syncEnvelopeId: 'sync-parent',
        payloadDigest: parent.payloadDigest,
        dependencyIds: [],
        envelope: parent,
      },
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      now: 201,
    });
    repository.applyInbound('sync-parent', 'owner-1', 'project-1', 202);
    expect(repository.getSyncRecord('inbox', 'sync-child', 'owner-1', 'project-1')?.state)
      .toBe('ready');
    expect(db.prepare(`
      SELECT state FROM session_fork_portability_sync
      WHERE direction = 'inbox' AND sync_envelope_id = 'sync-other-owner'
    `).get()).toEqual({ state: 'quarantined' });
  });

  it('serves search, tree, and neighborhood from the durable envelope after repository restart', () => {
    repository.exportSessionFork({
      exportId: 'export-search',
      rootSessionId: 'root',
      ownerScopeId: 'owner-1',
      projectId: 'project-1',
      mode: 'subtree',
      exportedAt: 100,
    });
    const restarted = new SessionForkPortabilityRepository(db);

    expect(restarted.searchDurableForks(
      'export-search',
      'owner-1',
      'project-1',
      'child codex',
    ).map((document) => document.sessionId)).toEqual(['child']);
    expect(restarted.getDurableForkTree(
      'export-search',
      'owner-1',
      'project-1',
    )).toMatchObject({
      sessionId: 'root',
      children: [{ sessionId: 'child' }],
    });
    expect(restarted.getDurableForkNeighborhood(
      'export-search',
      'owner-1',
      'project-1',
      'child',
      1,
    ).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'root', relation: 'ancestor' }),
      expect.objectContaining({ sessionId: 'child', relation: 'self' }),
    ]));
  });
});
