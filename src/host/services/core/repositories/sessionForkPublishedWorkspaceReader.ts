import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import {
  SessionForkPortabilityError,
  type PortableSessionWorkspaceV2,
} from '../../../../shared/contract/sessionForkPortability';
import {
  buildPortableIsolatedAnchorEvidenceV1,
} from '../../sessionFork/portability';
import { portabilityDigest } from '../../sessionFork/portability/canonical';
import {
  digestWorkspaceValue,
  projectChildWorkspaceScope,
  type AnchorWorkspaceEvidence,
} from '../../sessionFork/workspace';

type SQLiteRow = Record<string, unknown>;

export interface PublishedImportedWorkspaceSessionRow {
  user_id: string | null;
  project_id: string | null;
  origin: string | null;
  metadata: string | null;
  agent_engine: string | null;
  read_only: number;
  working_directory: string | null;
  workspace: string | null;
  is_deleted: number;
  status: string;
}

interface ReadPublishedImportedWorkspaceInput {
  fork: {
    id: string;
    child_session_id: string;
    anchor_child_message_id: string;
    requireLineage?: boolean;
  };
  session: PublishedImportedWorkspaceSessionRow;
  metadata: Record<string, unknown>;
  importedPortable: PortableSessionWorkspaceV2;
  publication: unknown;
}

function fail(
  code: ConstructorParameters<typeof SessionForkPortabilityError>[0],
  message: string,
): never {
  throw new SessionForkPortabilityError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') fail('INVALID_ENVELOPE', `${label} is not JSON text`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    fail(
      'INVALID_ENVELOPE',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    fail('INVALID_ENVELOPE', `${label}.${key} is required`);
  }
  return value.trim();
}

function portableDigestValue(value: unknown): string {
  if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/iu.test(value)) {
    return value.toLowerCase();
  }
  if (typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value)) {
    return `sha256:${value.toLowerCase()}`;
  }
  return portabilityDigest(value);
}

function assertTargetRepositoryIdentity(evidence: AnchorWorkspaceEvidence): void {
  const identity = evidence.manifest.repositoryIdentity;
  try {
    const canonicalRoot = realpathSync.native(identity.canonicalRoot);
    const canonicalGitCommonDirectory = realpathSync.native(identity.canonicalGitCommonDirectory);
    const rootStat = statSync(canonicalRoot);
    const gitCommonStat = statSync(canonicalGitCommonDirectory);
    const objectFormat = execFileSync(
      'git',
      ['rev-parse', '--show-object-format'],
      { cwd: canonicalRoot, encoding: 'utf8' },
    ).trim();
    execFileSync(
      'git',
      ['cat-file', '-e', `${evidence.manifest.baseCommit}^{commit}`],
      { cwd: canonicalRoot, stdio: 'ignore' },
    );
    const worktreeCommonDirectory = realpathSync.native(path.resolve(
      canonicalRoot,
      execFileSync(
        'git',
        ['rev-parse', '--git-common-dir'],
        { cwd: canonicalRoot, encoding: 'utf8' },
      ).trim(),
    ));
    if (
      canonicalRoot !== identity.canonicalRoot
      || canonicalGitCommonDirectory !== identity.canonicalGitCommonDirectory
      || String(rootStat.dev) !== identity.rootDevice
      || String(rootStat.ino) !== identity.rootInode
      || String(gitCommonStat.dev) !== identity.gitCommonDevice
      || String(gitCommonStat.ino) !== identity.gitCommonInode
      || objectFormat !== identity.objectFormat
      || worktreeCommonDirectory !== canonicalGitCommonDirectory
    ) {
      fail('DIGEST_MISMATCH', 'published target repository identity drifted');
    }
  } catch (error) {
    if (error instanceof SessionForkPortabilityError) throw error;
    fail(
      'REFERENCE_NOT_CLOSED',
      `published target repository identity cannot be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function readPublishedImportedPortableWorkspace(
  db: BetterSqlite3.Database,
  input: ReadPublishedImportedWorkspaceInput,
): PortableSessionWorkspaceV2 {
  const { fork, session, metadata, importedPortable } = input;
  if (!isRecord(input.publication)) {
    fail('INVALID_ENVELOPE', `imported isolated fork ${fork.id} publication is invalid`);
  }
  const publication = input.publication;
  const label = 'imported workspace publication';
  const intentId = requiredString(publication, 'intentId', label);
  const evidenceId = requiredString(publication, 'evidenceId', label);
  const portableEvidenceId = requiredString(publication, 'portableEvidenceId', label);
  const portablePayloadDigest = requiredString(publication, 'portablePayloadDigest', label);
  const evidenceDigest = requiredString(publication, 'evidenceDigest', label);
  const workspaceScopeVersion = requiredString(publication, 'workspaceScopeVersion', label);
  if (publication.version !== 1 || !Number.isSafeInteger(publication.publishedAt)) {
    fail('INVALID_ENVELOPE', `imported isolated fork ${fork.id} publication is incomplete`);
  }
  const row = db.prepare(`
    SELECT
      intent.source_session_id AS intent_source_session_id,
      intent.proposed_child_session_id AS intent_child_session_id,
      intent.repository_root AS intent_repository_root,
      intent.workspace_path AS intent_workspace_path,
      intent.evidence_digest AS intent_evidence_digest,
      intent.status AS intent_status,
      intent.advertisable AS intent_advertisable,
      evidence.source_session_id AS evidence_source_session_id,
      evidence.anchor_message_id AS evidence_anchor_message_id,
      evidence.owner_user_id AS evidence_owner_user_id,
      evidence.project_id AS evidence_project_id,
      evidence.workspace_scope_version AS evidence_workspace_scope_version,
      evidence.source_identity_digest AS evidence_source_identity_digest,
      evidence.source_identity_json AS evidence_source_identity_json,
      evidence.repository_root AS evidence_repository_root,
      evidence.base_commit AS evidence_base_commit,
      evidence.observed_head AS evidence_observed_head,
      evidence.evidence_digest AS evidence_digest,
      evidence.evidence_json AS evidence_json,
      evidence.status AS evidence_status
    FROM session_fork_workspace_intents AS intent
    JOIN session_fork_anchor_evidence AS evidence ON evidence.id = ?
    WHERE intent.intent_id = ?
    LIMIT 1
  `).get(evidenceId, intentId) as SQLiteRow | undefined;
  if (!row) fail('REFERENCE_NOT_CLOSED', `imported isolated fork ${fork.id} lost evidence`);
  const evidence = parseJson<AnchorWorkspaceEvidence>(row.evidence_json, 'rebound evidence');
  const sourceIdentity = parseJson<Record<string, unknown>>(
    row.evidence_source_identity_json,
    'source identity',
  );
  const engine = parseJson<Record<string, unknown>>(session.agent_engine, 'imported engine');
  let projection: ReturnType<typeof projectChildWorkspaceScope>;
  try {
    projection = projectChildWorkspaceScope(metadata);
  } catch (error) {
    fail(
      'INVALID_ENVELOPE',
      `imported isolated fork ${fork.id} WorkspaceScope is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!projection) {
    fail(
      'REFERENCE_NOT_CLOSED',
      `imported isolated fork ${fork.id} WorkspaceScope projection is missing`,
    );
  }
  const lineage = isRecord(metadata.forkLineage) ? metadata.forkLineage : null;
  const portableAnchorMessageId = importedPortable.anchorChildMessageId
    ?? (
      fork.requireLineage !== false
      && typeof lineage?.anchorChildMessageId === 'string'
      ? lineage.anchorChildMessageId
      : undefined
    );
  const expectedMappings = evidence.manifest.pathMappings.map((mapping) => ({
    sourceId: mapping.sourceId,
    sourcePath: mapping.sourcePath,
    sourceRelativePath: mapping.repositoryRelativePath,
    isolatedRelativePath: mapping.isolatedRelativePath,
  }));
  const roots = Array.isArray(sourceIdentity.roots) ? sourceIdentity.roots : [];
  const sourceRoot = roots.length === 1 && isRecord(roots[0]) ? roots[0] : null;
  const originalAnchor = importedPortable.isolatedAnchor;
  const checks: Array<[string, boolean]> = [
    ['portable source evidence', Boolean(originalAnchor)],
    ['portable child anchor', (
      portableAnchorMessageId === fork.anchor_child_message_id
    )],
    ['session visibility', Number(session.read_only) === 0 && Number(session.is_deleted) === 0],
    ['session runtime', Boolean(
      session.status === 'idle'
      && session.working_directory
      && session.workspace === session.working_directory
      && engine.cwd === session.working_directory,
    )],
    ['intent state', row.intent_status === 'advertised' && Number(row.intent_advertisable) === 1],
    ['intent session', (
      row.intent_source_session_id === fork.child_session_id
      && row.intent_child_session_id === fork.child_session_id
    )],
    ['intent workspace', (
      row.intent_workspace_path === session.working_directory
      && row.intent_repository_root === row.evidence_repository_root
    )],
    ['intent evidence', (
      row.intent_evidence_digest === evidenceDigest
      && row.intent_evidence_digest === row.evidence_digest
    )],
    ['evidence boundary', (
      row.evidence_status === 'complete'
      && row.evidence_source_session_id === fork.child_session_id
      && row.evidence_anchor_message_id === fork.anchor_child_message_id
      && row.evidence_owner_user_id === session.user_id
      && typeof session.project_id === 'string'
      && session.project_id.length > 0
      && row.evidence_project_id === session.project_id
      && row.evidence_workspace_scope_version === workspaceScopeVersion
    )],
    ['evidence manifest', (
      row.evidence_base_commit === evidence.manifest.baseCommit
      && row.evidence_observed_head === evidence.manifest.observedHead
      && row.evidence_digest === evidence.manifest.evidenceDigest
      && row.evidence_repository_root === evidence.manifest.repositoryIdentity.canonicalRoot
    )],
    ['source identity', (
      row.evidence_source_identity_digest === digestWorkspaceValue(sourceIdentity)
      && sourceIdentity.projectId === session.project_id
      && sourceIdentity.version === workspaceScopeVersion
      && sourceIdentity.primaryRoot === row.evidence_repository_root
      && sourceRoot?.path === row.evidence_repository_root
      && sourceRoot?.role === 'primary'
    )],
    ['fork lineage', (
      fork.requireLineage === false
      || (
        lineage?.forkId === fork.id
        && lineage?.childSessionId === fork.child_session_id
        && lineage?.anchorChildMessageId === fork.anchor_child_message_id
        && lineage?.workspaceMode === 'isolated_at_anchor'
      )
    )],
    ['WorkspaceScope identity', (
      projection.verification.forkId === fork.id
      && projection.verification.intentId === intentId
      && projection.verification.evidenceId === evidenceId
      && projection.verification.projectId === session.project_id
      && projection.verification.sourceWorkspaceScopeVersion === workspaceScopeVersion
    )],
    ['WorkspaceScope seal', (
      projection.verification.sourcePrimaryRoot === row.evidence_repository_root
      && projection.verification.isolatedPrimaryRoot === session.working_directory
      && projection.verification.baseCommit === row.evidence_base_commit
      && projection.verification.evidenceDigest === evidenceDigest
      && digestWorkspaceValue(projection.provenance.sourceIdentity)
        === digestWorkspaceValue(sourceIdentity)
      && digestWorkspaceValue(projection.provenance.pathMappings)
        === digestWorkspaceValue(expectedMappings)
    )],
    ['portable source seal', (
      portableEvidenceId === originalAnchor?.evidenceId
      && portablePayloadDigest === originalAnchor?.content.payloadDigest
    )],
  ];
  const failed = checks.find(([, valid]) => !valid);
  if (failed) {
    fail(
      'REFERENCE_NOT_CLOSED',
      `imported isolated fork ${fork.id} publication boundary does not close: ${failed[0]}`,
    );
  }
  if (!originalAnchor) {
    fail('PORTABLE_EVIDENCE_REQUIRED', `imported isolated fork ${fork.id} lost source evidence`);
  }
  assertTargetRepositoryIdentity(evidence);
  const portable = buildPortableIsolatedAnchorEvidenceV1({
    evidenceId,
    repositoryIdentityDigest: portableDigestValue(row.evidence_source_identity_digest),
    evidence,
  });
  const relativeMappings = (workspace: typeof portable) => workspace.pathMappings.map((mapping) => ({
    relativePath: mapping.relativePath,
    isolatedRelativePath: mapping.isolatedRelativePath,
  }));
  if (
    portable.content.payloadDigest !== portablePayloadDigest
    || portable.baseCommit !== originalAnchor.baseCommit
    || portable.observedHead !== originalAnchor.observedHead
    || portable.diffDigest !== originalAnchor.diffDigest
    || portable.untrackedManifestDigest !== originalAnchor.untrackedManifestDigest
    || digestWorkspaceValue(relativeMappings(portable))
      !== digestWorkspaceValue(relativeMappings(originalAnchor))
  ) {
    fail(
      'DIGEST_MISMATCH',
      `imported isolated fork ${fork.id} rebound evidence differs from its portable source`,
    );
  }
  return {
    mode: 'isolated_at_anchor',
    label: '历史对话 + 锚点文件',
    anchorChildMessageId: fork.anchor_child_message_id,
    isolatedAnchor: portable,
  };
}
