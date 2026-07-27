import type {
  ConversationBranchEventType,
  ConversationLineageIssueCode,
  ConversationMessageSnapshot,
  ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import type { ConversationBranchRepository } from '../../core/repositories/ConversationBranchRepository';

export const PORTABLE_CONVERSATION_HISTORY_SCHEMA = 'neo.conversation-history' as const;
export const PORTABLE_CONVERSATION_HISTORY_VERSION = 1 as const;

export type PortableConversationHistoryErrorCode =
  | 'INVALID_HISTORY'
  | 'DIGEST_MISMATCH'
  | 'BOUNDARY_MISMATCH'
  | 'REFERENCE_NOT_CLOSED'
  | 'ORDER_INVALID'
  | 'MAPPING_MISSING'
  | 'MAPPING_COLLISION'
  | 'UNSUPPORTED_EVENT'
  | 'PRIVACY_VIOLATION';

export class PortableConversationHistoryError extends Error {
  readonly name = 'PortableConversationHistoryError';

  constructor(
    readonly code: PortableConversationHistoryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type ConversationHistorySourceRow = Readonly<Record<string, unknown>>;

/** Accepts verbatim SQLite rows or normalized camel-case records. */
export interface ConversationHistorySourceRows {
  ownerUserId: string | null;
  projectId: string | null;
  branches: readonly ConversationHistorySourceRow[];
  entries: readonly ConversationHistorySourceRow[];
  references: readonly ConversationHistorySourceRow[];
  events: readonly ConversationHistorySourceRow[];
  evaluationAttributions?: readonly ConversationHistorySourceRow[];
}

export interface PortableConversationAttachmentProvenance {
  idDigest: string;
  type?: string;
  category?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  pageCount?: number;
  sheetCount?: number;
  rowCount?: number;
  language?: string;
  contentDigest: string;
}

export interface PortableConversationArtifactProvenance {
  idDigest: string;
  type?: string;
  title?: string;
  version?: number;
  parentIdDigest?: string;
  contentDigest: string;
}

export interface PortableConversationBranch {
  id: string;
  sessionId: string;
  rootBranchId: string;
  parentBranchId: string | null;
  forkId: string | null;
  anchorEntryId: string | null;
  createdAt: number;
  payloadDigest: string;
}

export interface PortableConversationEntry {
  id: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourcePayloadDigest: string;
  message: ConversationMessageSnapshot & {
    attachments?: PortableConversationAttachmentProvenance[];
    artifacts?: PortableConversationArtifactProvenance[];
  };
  provenance: Record<string, unknown>;
  createdAt: number;
  payloadDigest: string;
}

export interface PortableConversationReference {
  branchId: string;
  ordinal: number;
  entryId: string;
  projectedSessionId: string;
  projectedMessageId: string;
  canonicalSourceSessionId: string;
  canonicalSourceMessageId: string;
  aliasKind: ConversationReplayMessage['aliasKind'];
  createdAt: number;
  payloadDigest: string;
}

export interface PortableConversationEvent {
  id: string;
  branchId: string;
  sequence: number;
  eventType: ConversationBranchEventType;
  sourceIdempotencyDigest: string;
  payload: Record<string, unknown>;
  createdAt: number;
  payloadDigest: string;
}

export interface PortableConversationEvaluationAttribution {
  eventId: string;
  branchId: string;
  sequence: number;
  evaluationId: string;
  runProvenanceDigest: string | null;
  metric: string;
  value: number;
  entryIds: string[];
  createdAt: number;
  payloadDigest: string;
}

export interface PortableConversationHistoryV1 {
  schema: typeof PORTABLE_CONVERSATION_HISTORY_SCHEMA;
  version: typeof PORTABLE_CONVERSATION_HISTORY_VERSION;
  ownerUserId: string | null;
  projectId: string | null;
  branches: PortableConversationBranch[];
  entries: PortableConversationEntry[];
  references: PortableConversationReference[];
  events: PortableConversationEvent[];
  evaluationAttributions: PortableConversationEvaluationAttribution[];
  payloadDigest: string;
}

type PortableConversationReplayMethod =
  | 'initializeSessionBranch'
  | 'appendMessage'
  | 'recordMessageRevision'
  | 'recordProjectionReplacement'
  | 'createForkBranch'
  | 'recordRewind'
  | 'recordRewindRestore'
  | 'recordEvaluationAttribution'
  | 'auditAndQuarantine'
  | 'recordRepairOverride'
  | 'repairCompatibilityProjection';

type RepositoryReplayMethod = Exclude<
  PortableConversationReplayMethod,
  'repairCompatibilityProjection'
>;

type RepositoryReplayInput<Method extends RepositoryReplayMethod> =
  Parameters<ConversationBranchRepository[Method]>[0];

interface ReplayActionBase {
  order: number;
  sourceEventId: string;
  createdAt: number;
}

type RepositoryReplayAction = {
  [Method in RepositoryReplayMethod]:
  ReplayActionBase
  & { method: Method; input: RepositoryReplayInput<Method> }
  & (Method extends 'auditAndQuarantine'
    ? {
        expectedIssueDigest: string;
        expectedIssueTypes: ConversationLineageIssueCode[];
      }
    : Method extends 'recordRepairOverride'
      ? { sourceQuarantineEventId: string }
      : object)
}[RepositoryReplayMethod];

export type PortableProjectionIssueType = Extract<
  ConversationLineageIssueCode,
  | 'PROJECTION_ALIAS_MISSING'
  | 'PROJECTION_ALIAS_EXTRA'
  | 'PROJECTION_ALIAS_ORDER_MISMATCH'
  | 'PROJECTION_ALIAS_PAYLOAD_MISMATCH'
>;

export interface PortableProjectionRepairSourceEvidence {
  sourceIssueDigest: string;
  sourceQuarantineEventId: string;
  quarantineCreatedAt: number;
  quarantineIdempotencyKey: string;
  issueTypes: PortableProjectionIssueType[];
}

export interface PortableConversationProjectionRepairReplayAction extends ReplayActionBase {
  method: 'repairCompatibilityProjection';
  input: Omit<
    Parameters<ConversationBranchRepository['repairCompatibilityProjection']>[0],
    'issueDigest'
  >;
  sourceEvidence: PortableProjectionRepairSourceEvidence;
}

export type PortableConversationReplayAction =
  | RepositoryReplayAction
  | PortableConversationProjectionRepairReplayAction;

export interface PlanPortableConversationHistoryImportInput {
  history: PortableConversationHistoryV1;
  sessionIdMap: Readonly<Record<string, string>>;
  messageIdMap: Readonly<Record<string, string>>;
  forkIdMap: Readonly<Record<string, string>>;
  targetOwnerUserId: string | null;
  targetProjectId: string | null;
}

export interface PortableConversationHistoryImportPlan {
  sourceHistoryDigest: string;
  targetBoundary: {
    ownerUserId: string | null;
    projectId: string | null;
  };
  rewindIdMap: Record<string, string>;
  evaluationIdMap: Record<string, string>;
  actions: PortableConversationReplayAction[];
  payloadDigest: string;
}

export type PortableConversationReplayActionWithoutOrder =
  PortableConversationReplayAction extends infer Action
    ? Action extends { order: number }
      ? Omit<Action, 'order'>
      : never
    : never;

export const SUPPORTED_CONVERSATION_HISTORY_EVENTS = new Set<ConversationBranchEventType>([
  'legacy_backfill',
  'append',
  'message_revision',
  'projection_replace',
  'fork',
  'rewind',
  'rewind_restore',
  'evaluation_attribution',
  'quarantine',
  'repair_override',
  'projection_repair',
]);
