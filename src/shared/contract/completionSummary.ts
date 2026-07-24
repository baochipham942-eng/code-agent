// ============================================================================
// Completion Summary Contract
// ============================================================================

export type CompletionSummaryStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'goal_met'
  | 'aborted';

export interface CompletionSummaryCommand {
  toolCallId: string;
  command: string;
  cwd?: string;
  success: boolean;
  exitCode?: number | null;
  durationMs?: number;
  verification: boolean;
  outputPreview?: string;
}

export interface CompletionSummaryVerificationEvidence {
  kind: 'command';
  toolCallId: string;
  command: string;
  success: boolean;
  exitCode?: number | null;
  outputPreview?: string;
}

export interface CompletionSummaryDirtyState {
  sourceId?: string;
  sourceRole?: 'primary' | 'additional';
  sourceAccess?: 'read_only' | 'read_write';
  repositoryRoot?: string;
  checkedAt: number;
  gitBranch?: string | null;
  headCommit?: string | null;
  isDirty?: boolean;
  changedFiles?: string[];
  error?: string;
}

export interface CompletionSummaryArtifactRef {
  kind: 'file' | 'artifact';
  path?: string;
  messageId?: string;
  artifactId?: string;
  title?: string;
}

export interface CompletionSummaryVisibleFinalAnswerRef {
  messageId: string;
  timestamp: number;
  sha256: string;
  preview: string;
}

export interface CompletionSummaryRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  traceId?: string;
  agentId?: string;
  objective: string;
  status: CompletionSummaryStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  iterations: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  toolCallCount: number;
  changedFiles: string[];
  commands: CompletionSummaryCommand[];
  verificationEvidence: CompletionSummaryVerificationEvidence[];
  dirtyState?: CompletionSummaryDirtyState;
  dirtyStates?: CompletionSummaryDirtyState[];
  changedFilesBySource?: Array<{
    sourceId: string;
    sourceRole: 'primary' | 'additional';
    sourceAccess: 'read_only' | 'read_write';
    files: string[];
  }>;
  workspaceScopeVersion?: string;
  commitIds: string[];
  risks: string[];
  blockers: string[];
  artifactRefs: CompletionSummaryArtifactRef[];
  visibleFinalAnswer?: CompletionSummaryVisibleFinalAnswerRef;
}
