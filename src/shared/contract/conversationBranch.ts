/**
 * Append-only conversation truth model.
 *
 * `messages` remains the compatibility projection consumed by existing
 * surfaces. These contracts describe the immutable entry / branch ledger used
 * for replay, fork provenance, rewind visibility, evaluation attribution, and
 * lineage repair.
 */

type ConversationOwnerId = string | null;
type ConversationProjectId = string | null;

export interface ConversationBoundary {
  /**
   * Exact authenticated owner. `null` means an explicitly local/anonymous
   * session. Callers must not pass `undefined`.
   */
  ownerUserId: ConversationOwnerId;
  /** Exact project boundary. `null` means the session is not in a project. */
  projectId: ConversationProjectId;
}

type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * A portable message snapshot. Unknown fields are deliberately retained in the
 * immutable JSON payload so new message capabilities do not require destructive
 * ledger migrations.
 */
export interface ConversationMessageSnapshot {
  id: string;
  role: ConversationMessageRole;
  content: string;
  timestamp: number;
  visibility?: 'active' | 'rewound';
  hiddenByRewindId?: string;
  hiddenAt?: number;
  [key: string]: unknown;
}

export type ConversationBranchEventType =
  | 'legacy_backfill'
  | 'append'
  | 'message_revision'
  | 'projection_replace'
  | 'projection_repair'
  | 'fork'
  | 'rewind'
  | 'rewind_restore'
  | 'evaluation_attribution'
  | 'quarantine'
  | 'repair_override';

export interface ConversationProjectionRepairEventPayload {
  issueDigest: string;
  quarantineEventId: string;
  reason: string;
  previousProjectionDigest: string;
  repairedProjectionDigest: string;
  expectedActiveCount: number;
  previousActiveCount: number;
  insertedCount: number;
  updatedCount: number;
  softHiddenCount: number;
  reorderedCount: number;
  recalibratedForkMappingCount: number;
}

export interface ConversationBranchLineage {
  branchId: string;
  sessionId: string;
  ownerUserId: ConversationOwnerId;
  projectId: ConversationProjectId;
  rootBranchId: string;
  parentBranchId: string | null;
  parentSessionId: string | null;
  forkId: string | null;
  anchorEntryId: string | null;
  createdAt: number;
}

export interface ConversationReplayMessage {
  ordinal: number;
  entryId: string;
  projectedMessageId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  aliasKind: 'native' | 'fork_copy' | 'legacy_backfill' | 'revision' | 'replacement';
  message: ConversationMessageSnapshot;
}

export interface ConversationReplay {
  lineage: ConversationBranchLineage;
  messages: ConversationReplayMessage[];
  openRewindIds: string[];
  ledgerEventCount: number;
}

export interface ConversationBranchComparison {
  left: ConversationBranchLineage;
  right: ConversationBranchLineage;
  sharedPrefixLength: number;
  sharedEntryIds: string[];
  leftOnly: ConversationReplayMessage[];
  rightOnly: ConversationReplayMessage[];
}

export interface ConversationEntryRecord {
  id: string;
  ownerUserId: ConversationOwnerId;
  projectId: ConversationProjectId;
  sourceSessionId: string;
  sourceMessageId: string;
  payloadDigest: string;
  message: ConversationMessageSnapshot;
  provenance: Record<string, unknown>;
  createdAt: number;
}

interface ConversationEntryAlias {
  branchId: string;
  sessionId: string;
  messageId: string;
  ordinal: number;
  aliasKind: ConversationReplayMessage['aliasKind'];
}

export interface ConversationProvenanceTrace {
  entry: ConversationEntryRecord;
  canonicalSource: { sessionId: string; messageId: string };
  aliases: ConversationEntryAlias[];
  branchPath: ConversationBranchLineage[];
}

export interface ConversationEvaluationAttribution {
  eventId: string;
  evaluationId: string;
  runId: string | null;
  metric: string;
  value: number;
  entryIds: string[];
  createdAt: number;
}

export type ConversationLineageIssueCode =
  | 'BRANCH_LINEAGE_CYCLE'
  | 'BRANCH_LINEAGE_DIGEST_MISMATCH'
  | 'BRANCH_BOUNDARY_MISMATCH'
  | 'ROOT_BRANCH_MISSING'
  | 'ROOT_BRANCH_MISMATCH'
  | 'PARENT_BRANCH_MISSING'
  | 'ENTRY_BOUNDARY_MISMATCH'
  | 'REFERENCE_SEQUENCE_GAP'
  | 'EVENT_SEQUENCE_GAP'
  | 'EVENT_PAYLOAD_DIGEST_MISMATCH'
  | 'EVENT_CHAIN_MISMATCH'
  | 'EVENT_DIGEST_MISMATCH'
  | 'PROJECTION_ALIAS_MISSING'
  | 'PROJECTION_ALIAS_EXTRA'
  | 'PROJECTION_ALIAS_ORDER_MISMATCH'
  | 'PROJECTION_ALIAS_PAYLOAD_MISMATCH'
  | 'LEGACY_ALIAS_MISSING'
  | 'LEGACY_ALIAS_PAYLOAD_MISMATCH'
  | 'FORK_PREFIX_ENTRY_MISMATCH'
  | 'FORK_PREFIX_NOT_CONTIGUOUS'
  | 'FORK_ANCHOR_MISSING'
  | 'FORK_ANCHOR_MISMATCH'
  | 'FORK_ALIAS_MISMATCH'
  | 'LEGACY_FORK_MAPPING_MISSING'
  | 'LEGACY_FORK_MAPPING_GAP'
  | 'LEGACY_FORK_MAPPING_NOT_CLOSED'
  | 'LEGACY_FORK_ANCHOR_MISMATCH'
  | 'LEGACY_FORK_PAYLOAD_MISMATCH'
  | 'EVENT_PAYLOAD_INVALID';

export interface ConversationLineageIssue {
  code: ConversationLineageIssueCode;
  detail: string;
  branchId: string;
  ordinal?: number;
  eventId?: string;
  entryId?: string;
}

export type ConversationLineageAuditStatus = 'healthy' | 'quarantined' | 'override_active';

export interface ConversationLineageAudit {
  branch: ConversationBranchLineage;
  status: ConversationLineageAuditStatus;
  issueDigest: string;
  issues: ConversationLineageIssue[];
  quarantineEventId: string | null;
  repairOverrideEventId: string | null;
}

export type ConversationBranchErrorCode =
  | 'BOUNDARY_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'BRANCH_NOT_FOUND'
  | 'OWNER_MISMATCH'
  | 'PROJECT_MISMATCH'
  | 'MESSAGE_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_FORK'
  | 'INVALID_REWIND'
  | 'REWIND_ORDER_CONFLICT'
  | 'BRANCH_QUARANTINED'
  | 'PROJECTION_REPAIR_REJECTED'
  | 'REPAIR_OVERRIDE_REJECTED'
  | 'LEDGER_CORRUPT';

export class ConversationBranchError extends Error {
  readonly name = 'ConversationBranchError';

  constructor(
    readonly code: ConversationBranchErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
  }
}
