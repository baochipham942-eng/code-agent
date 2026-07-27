export type WorkspaceForkIntentStatus =
  | 'recorded'
  | 'worktree_created'
  | 'applying'
  | 'evidence_applied'
  | 'verifying'
  | 'cleanup_required'
  | 'ready'
  | 'advertised'
  | 'abandoned';

export interface AnchorRepositoryIdentity {
  canonicalRoot: string;
  canonicalGitCommonDirectory: string;
  rootDevice: string;
  rootInode: string;
  gitCommonDevice: string;
  gitCommonInode: string;
  objectFormat: string;
  fingerprint: string;
}

export interface AnchorPathMapping {
  sourceId: string;
  sourcePath: string;
  repositoryRelativePath: string;
  isolatedRelativePath: string;
}

export interface AnchorPatchDescriptor {
  sha256: string;
  sizeBytes: number;
}

export interface AnchorUntrackedFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  mode: number;
}

export interface AnchorWorkspaceEvidenceManifest {
  version: 1;
  captureState: 'complete';
  anchorId: string;
  capturedAt: number;
  baseCommit: string;
  baseCommitSource: 'explicit_anchor_input';
  observedHead: string;
  workspaceScopeVersion: string;
  repositoryIdentity: AnchorRepositoryIdentity;
  pathMappings: AnchorPathMapping[];
  stagedPatch: AnchorPatchDescriptor;
  unstagedPatch: AnchorPatchDescriptor;
  untrackedFiles: AnchorUntrackedFile[];
  evidenceDigest: string;
}

interface AnchorWorkspaceEvidencePayload {
  stagedPatchBase64: string;
  unstagedPatchBase64: string;
  untrackedBlobs: Record<string, string>;
}

export interface AnchorWorkspaceEvidence {
  manifest: AnchorWorkspaceEvidenceManifest;
  payload: AnchorWorkspaceEvidencePayload;
}

export interface CaptureAnchorWorkspaceEvidenceInput {
  anchorId: string;
  repositoryRoot: string;
  /**
   * The caller must persist and supply the commit observed at the logical
   * conversation anchor. Capture never substitutes the process' current HEAD.
   */
  baseCommit: string;
  workspaceScopeVersion: string;
  pathMappings: Array<{
    sourceId: string;
    sourcePath: string;
    isolatedRelativePath: string;
  }>;
}

export interface WorkspaceCommand {
  executable: 'git';
  args: string[];
  cwd: string;
  input?: Buffer;
  timeoutMs?: number;
}

export interface WorkspaceCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

export interface WorkspaceCommandRunner {
  run(command: WorkspaceCommand): Promise<WorkspaceCommandResult>;
}

export interface WorkspaceForkIntent {
  version: 1;
  revision: number;
  intentId: string;
  requestDigest: string;
  sourceSessionId: string;
  proposedChildSessionId: string;
  repositoryRoot: string;
  workspacePath: string;
  evidence: AnchorWorkspaceEvidence;
  evidenceDigest: string;
  status: WorkspaceForkIntentStatus;
  advertisable: boolean;
  attempts: number;
  lastError?: {
    code: string;
    message: string;
    at: number;
  };
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceForkIntentStore {
  create(intent: WorkspaceForkIntent): Promise<WorkspaceForkIntent>;
  get(intentId: string): Promise<WorkspaceForkIntent | null>;
  list(): Promise<WorkspaceForkIntent[]>;
  update(
    intentId: string,
    expectedRevision: number,
    patch: Partial<Omit<WorkspaceForkIntent, 'intentId' | 'version' | 'revision' | 'createdAt'>>,
  ): Promise<WorkspaceForkIntent>;
}

export interface PrepareIsolatedAnchorWorkspaceInput {
  intentId: string;
  sourceSessionId: string;
  proposedChildSessionId: string;
  repositoryRoot: string;
  destinationName: string;
  evidence: AnchorWorkspaceEvidence;
}

export interface PreparedIsolatedAnchorWorkspace {
  intentId: string;
  status: 'ready';
  advertisable: true;
  workspacePath: string;
  baseCommit: string;
  evidenceDigest: string;
  workspaceScopeVersion: string;
  pathMappings: Array<AnchorPathMapping & { isolatedPath: string }>;
}

export interface WorkspaceRecoveryResult {
  intentId: string;
  outcome: 'ready' | 'cleaned' | 'failed';
  workspacePath: string;
  error?: string;
}
