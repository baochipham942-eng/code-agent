import type { Message } from './message';
import type { Session } from './session';

export type SessionForkWorkspaceMode = 'shared_current' | 'isolated_at_anchor';

export type SessionForkContextDeliveryMode =
  | 'neo_native_prefix'
  | 'provider_native_fork'
  | 'validated_context_handoff'
  | 'unsupported';

export type SessionForkStatus =
  | 'preparing'
  | 'workspace_ready'
  | 'completed'
  | 'failed'
  | 'quarantined';

export type SessionForkSyncState = 'local_only' | 'pending' | 'synced' | 'blocked';

export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_RUNNING'
  | 'INVALID_ANCHOR'
  | 'ANCHOR_REWOUND'
  | 'ANCHOR_NOT_COMPLETED_ASSISTANT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVIDENCE_INCOMPLETE'
  | 'WORKSPACE_IDENTITY_DRIFT'
  | 'CONTEXT_HANDOFF_REJECTED'
  | 'FORK_OPERATION_FAILED';

export class SessionForkError extends Error {
  readonly code: SessionForkErrorCode;

  constructor(code: SessionForkErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SessionForkError';
    this.code = code;
  }
}

export interface SessionForkLineageSummary {
  forkId: string;
  rootSessionId: string;
  parentSessionId: string;
  /** Absent on legacy projections; authoritative repository reads always populate it. */
  parentDeleted?: boolean;
  childSessionId: string;
  sourceAnchorMessageId: string;
  anchorChildMessageId: string;
  depth: number;
  workspaceMode: SessionForkWorkspaceMode;
  contextDeliveryMode: SessionForkContextDeliveryMode;
  status: SessionForkStatus;
  syncState: SessionForkSyncState;
  createdAt: number;
}

export interface SessionForkMessageMapping {
  forkId: string;
  ordinal: number;
  sourceMessageId: string;
  childMessageId: string;
  sourceTimestamp: number;
  sourceOrderKey: string;
  sourceRowDigest: string;
}

export interface CreateSessionForkRequest {
  sourceSessionId: string;
  anchorAssistantMessageId: string;
  idempotencyKey: string;
  workspaceMode: SessionForkWorkspaceMode;
}

export interface CreateSessionForkResult {
  childSession: Session;
  lineage: SessionForkLineageSummary;
  messageMappings: SessionForkMessageMapping[];
  copiedMessageCount: number;
  sourcePrefixDigest: string;
  workspaceLabel: '历史对话 + 当前文件' | '历史对话 + 锚点文件';
}

export interface SessionForkBranchReplay {
  sessionId: string;
  branchId: string;
  entries: Array<{
    entryId: string;
    ordinal: number;
    message: Message;
    sourceSessionId: string;
    sourceMessageId: string;
    payloadDigest: string;
  }>;
}

export interface SessionForkBranchComparison {
  leftSessionId: string;
  rightSessionId: string;
  sharedPrefixEntries: number;
  leftOnlyEntryIds: string[];
  rightOnlyEntryIds: string[];
}
