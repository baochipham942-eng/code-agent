import type {
  ConversationBranchEventType,
  ConversationMessageSnapshot,
  ConversationReplayMessage,
} from './conversationBranch';

export const PORTABLE_CONVERSATION_HISTORY_SCHEMA = 'neo.conversation-history' as const;
export const PORTABLE_CONVERSATION_HISTORY_VERSION = 1 as const;

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
