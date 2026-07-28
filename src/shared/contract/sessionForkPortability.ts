import type { AgentEngineKind, AgentEnginePermissionProfile } from './agentEngine';
import type { Artifact, Message, MessageAttachment, MessageRole, MessageVisibility } from './message';
import type { ModelCapability, ModelProvider, ModelProviderProtocol, ModelReasoningEffort } from './model';
import type { Session, SessionMemoryMode, SessionOrigin, SessionType } from './session';
import type { PortableConversationHistoryV1 } from './conversationHistory';
import type {
  SessionForkContextDeliveryMode,
  SessionForkWorkspaceMode,
} from './sessionFork';

export const SESSION_EXPORT_ENVELOPE_SCHEMA = 'neo.session-export' as const;
export const SESSION_EXPORT_ENVELOPE_VERSION = 2 as const;
export const FORK_LINEAGE_ENVELOPE_SCHEMA = 'neo.fork-lineage' as const;
export const FORK_LINEAGE_ENVELOPE_VERSION = 1 as const;
/** Portable boundary for an explicitly local/anonymous Neo profile. */
export const LOCAL_SESSION_FORK_OWNER_SCOPE_ID = 'neo.local-owner' as const;
export const PORTABLE_ANCHOR_MAX_PATCH_BYTES = 64 * 1024 * 1024;
export const PORTABLE_ANCHOR_MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
export const PORTABLE_ANCHOR_MAX_UNTRACKED_FILES = 10_000;

export type SessionForkPortabilityErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'OWNER_SCOPE_MISMATCH'
  | 'PROJECT_SCOPE_MISMATCH'
  | 'DIGEST_MISMATCH'
  | 'ORDINAL_INVALID'
  | 'REFERENCE_NOT_CLOSED'
  | 'LINEAGE_INVALID'
  | 'DETACHED_PROVENANCE_REQUIRED'
  | 'RUNTIME_IDENTITY_FORBIDDEN'
  | 'ABSOLUTE_WORKTREE_FORBIDDEN'
  | 'PORTABLE_EVIDENCE_REQUIRED'
  | 'PORTABLE_EVIDENCE_BUDGET_EXCEEDED'
  | 'ID_REMAP_COLLISION'
  | 'REMOTE_UPLOAD_DISABLED'
  | 'SYNC_ID_DIGEST_CONFLICT'
  | 'SYNC_ENVELOPE_NOT_FOUND'
  | 'ENVELOPE_NOT_READY';

export class SessionForkPortabilityError extends Error {
  readonly code: SessionForkPortabilityErrorCode;

  constructor(code: SessionForkPortabilityErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SessionForkPortabilityError';
    this.code = code;
  }
}

export interface PortableModelConfigV2 {
  provider: ModelProvider;
  model: string;
  protocol?: ModelProviderProtocol;
  temperature?: number;
  maxTokens?: number;
  capabilities?: ModelCapability[];
  computerUse?: boolean;
  promptCaching?: {
    enabled: boolean;
    cacheSystem?: boolean;
  };
  thinkingBudget?: number;
  reasoningEffort?: ModelReasoningEffort;
  adaptive?: boolean;
}

export interface PortableAgentEngineV2 {
  kind: AgentEngineKind;
  model?: string;
  permissionProfile?: AgentEnginePermissionProfile;
  origin?: 'manual' | 'import' | 'external';
}

interface PortableForkPathMappingV1 {
  sourceRootDigest: string;
  /** Repository-relative source path. `.` denotes the target repository root. */
  relativePath: string;
  /** Relative destination inside the isolated worktree. */
  isolatedRelativePath: string;
}

export interface PortableContentAddressedBlobRefV1 {
  blobDigest: string;
  sizeBytes: number;
}

export interface PortableUntrackedFileV1 extends PortableContentAddressedBlobRefV1 {
  relativePath: string;
  mode: number;
}

export interface PortableIsolatedAnchorContentV1 {
  version: 1;
  stagedPatch: PortableContentAddressedBlobRefV1;
  unstagedPatch: PortableContentAddressedBlobRefV1;
  untrackedFiles: PortableUntrackedFileV1[];
  /** Canonical base64 blobs addressed by their `sha256:<hex>` digest. */
  blobs: Record<string, string>;
  payloadDigest: string;
}

export interface PortableIsolatedAnchorEvidenceV1 {
  evidenceId: string;
  repositoryIdentityDigest: string;
  baseCommit: string;
  observedHead: string;
  capturedAt: number;
  workspaceScopeVersion: string;
  diffDigest: string;
  untrackedManifestDigest: string;
  pathMappings: PortableForkPathMappingV1[];
  content: PortableIsolatedAnchorContentV1;
}

export interface PortableSessionWorkspaceV2 {
  mode: SessionForkWorkspaceMode;
  label: '历史对话 + 当前文件' | '历史对话 + 锚点文件';
  /**
   * The completed assistant reply whose file evidence this isolated workspace
   * represents. Optional at the codec boundary for legacy V2 envelopes; import
   * planning requires it explicitly for an isolated export root.
   */
  anchorChildMessageId?: string;
  isolatedAnchor?: PortableIsolatedAnchorEvidenceV1;
}

export interface PortableAttachmentProvenanceV2 {
  id: string;
  type: MessageAttachment['type'];
  category: MessageAttachment['category'];
  name: string;
  size: number;
  mimeType: string;
  pageCount?: number;
  sheetCount?: number;
  rowCount?: number;
  language?: string;
  /** Digest of the original attachment payload/metadata, never the bytes themselves. */
  contentDigest: string;
}

export interface PortableArtifactProvenanceV2 {
  id: string;
  type: Artifact['type'];
  title?: string;
  version: number;
  parentId?: string;
  contentDigest: string;
}

export interface PortableSessionV2 {
  id: string;
  ownerScopeId: string;
  projectId: string;
  title: string;
  modelConfig: PortableModelConfigV2;
  type?: SessionType;
  origin?: SessionOrigin;
  memoryMode?: SessionMemoryMode;
  suppressedMemoryEntryIds?: string[];
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
  engine?: PortableAgentEngineV2;
  workspace?: PortableSessionWorkspaceV2;
  payloadDigest: string;
}

export interface PortableMessageV2 {
  id: string;
  sessionId: string;
  ordinal: number;
  role: MessageRole;
  content: string;
  timestamp: number;
  visibility?: MessageVisibility;
  isMeta?: boolean;
  source?: Message['source'];
  subtype?: Message['subtype'];
  attachments?: PortableAttachmentProvenanceV2[];
  artifacts?: PortableArtifactProvenanceV2[];
  payloadDigest: string;
}

export interface ForkLineageNodeV1 {
  forkId: string | null;
  sessionId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  sourceAnchorMessageId: string | null;
  anchorChildMessageId: string | null;
  depth: number;
  ordinal: number;
  workspaceMode: SessionForkWorkspaceMode;
  contextDeliveryMode: SessionForkContextDeliveryMode;
  ownerScopeId: string;
  projectId: string;
  createdAt: number;
  payloadDigest: string;
}

export interface ForkLineageMessageMappingV1 {
  forkId: string;
  ordinal: number;
  sourceSessionId: string;
  childSessionId: string;
  sourceMessageId: string;
  childMessageId: string;
  sourceTimestamp: number;
  sourceOrderKey: string;
  sourceRowDigest: string;
  payloadDigest: string;
}

export interface ForkLineageEnvelopeV1 {
  schema: typeof FORK_LINEAGE_ENVELOPE_SCHEMA;
  version: typeof FORK_LINEAGE_ENVELOPE_VERSION;
  ownerScopeId: string;
  projectId: string;
  rootSessionId: string;
  createdAt: number;
  nodes: ForkLineageNodeV1[];
  messageMappings: ForkLineageMessageMappingV1[];
  payloadDigest: string;
}

interface DetachedForkProvenanceV1 {
  kind: 'detached_child';
  sourceRootSessionId: string;
  sourceParentSessionId: string;
  sourceForkId: string;
  sourceAnchorMessageId: string;
  sourceAnchorDigest: string;
  sourceDepth: number;
}

export type SessionExportModeV2 = 'subtree' | 'detached_child';

export interface SessionExportEnvelopeV2 {
  schema: typeof SESSION_EXPORT_ENVELOPE_SCHEMA;
  version: typeof SESSION_EXPORT_ENVELOPE_VERSION;
  exportId: string;
  exportedAt: number;
  ownerScopeId: string;
  projectId: string;
  rootSessionId: string;
  mode: SessionExportModeV2;
  sessions: PortableSessionV2[];
  messages: PortableMessageV2[];
  lineage: ForkLineageEnvelopeV1;
  /** Optional append-only history; old V2 envelopes remain valid without it. */
  conversationHistory?: PortableConversationHistoryV1;
  detachedProvenance?: DetachedForkProvenanceV1;
  payloadDigest: string;
}

interface SessionExportWorkspaceInputV2 {
  mode: SessionForkWorkspaceMode;
  label: PortableSessionWorkspaceV2['label'];
  anchorChildMessageId?: string;
  isolatedAnchor?: PortableIsolatedAnchorEvidenceV1 & {
    /** Runtime-only path accepted as source input and deliberately dropped by the codec. */
    absoluteWorktreePath?: string;
  };
}

export interface SessionExportSourceV2 {
  session: Session & Record<string, unknown>;
  messages: Array<Message & Record<string, unknown>>;
  workspace?: SessionExportWorkspaceInputV2;
}

export type ForkLineageNodeDraftV1 = Omit<
ForkLineageNodeV1,
'ownerScopeId' | 'projectId' | 'payloadDigest'
>;

export type ForkLineageMessageMappingDraftV1 = Omit<
ForkLineageMessageMappingV1,
'payloadDigest'
>;

export interface ForkLineageDraftV1 {
  createdAt: number;
  nodes: ForkLineageNodeDraftV1[];
  messageMappings: ForkLineageMessageMappingDraftV1[];
}

export interface BuildSessionExportEnvelopeV2Input {
  exportId: string;
  exportedAt: number;
  ownerScopeId: string;
  projectId: string;
  rootSessionId: string;
  mode: SessionExportModeV2;
  sessions: SessionExportSourceV2[];
  lineage?: ForkLineageDraftV1;
  conversationHistory?: PortableConversationHistoryV1;
  detachedProvenance?: Omit<DetachedForkProvenanceV1, 'kind'>;
}

export interface ForkLineageValidationScope {
  ownerScopeId: string;
  projectId: string;
  sessionIds: ReadonlySet<string>;
  messageIds: ReadonlySet<string>;
}

export interface SessionExportDecodeScope {
  ownerScopeId: string;
  projectId: string;
}

export interface LegacyForkClaimStripResult {
  value: unknown;
  strippedPaths: string[];
}

export interface SessionForkImportPlan {
  sourceExportId: string;
  targetOwnerScopeId: string;
  targetProjectId: string;
  sessionIdMap: Record<string, string>;
  messageIdMap: Record<string, string>;
  forkIdMap: Record<string, string>;
  envelope: SessionExportEnvelopeV2;
}

export interface PlanSessionForkImportInput {
  envelope: SessionExportEnvelopeV2;
  targetOwnerScopeId: string;
  targetProjectId: string;
  namespace: string;
  allowProjectRemap?: boolean;
}

type SessionForkSyncEnvelopeState =
  | 'local_only'
  | 'pending'
  | 'quarantined'
  | 'ready'
  | 'applied'
  | 'blocked';

export interface SessionForkSyncWireEnvelope {
  syncEnvelopeId: string;
  payloadDigest: string;
  dependencyIds: string[];
  envelope: SessionExportEnvelopeV2;
}

export interface SessionForkSyncEnvelopeRecord extends SessionForkSyncWireEnvelope {
  direction: 'outbox' | 'inbox';
  state: SessionForkSyncEnvelopeState;
  createdAt: number;
  updatedAt: number;
  reason?: string;
}

export interface SessionForkSyncTransport {
  upload(envelope: SessionForkSyncWireEnvelope): Promise<void>;
  download(syncEnvelopeId: string): Promise<SessionForkSyncWireEnvelope | null>;
}

export interface ForkSearchDocument {
  id: string;
  sessionId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  depth: number;
  title: string;
  engineKind: AgentEngineKind | null;
  workspaceMode: SessionForkWorkspaceMode;
  messageCount: number;
  createdAt: number;
  searchText: string;
}

export interface ForkTreeNodeProjection {
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  ordinal: number;
  createdAt: number;
  children: ForkTreeNodeProjection[];
}

export interface ForkNeighborhoodNodeProjection {
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  relation: 'self' | 'ancestor' | 'descendant' | 'sibling';
  distance: number;
}

export interface ForkNeighborhoodProjection {
  centerSessionId: string;
  nodes: ForkNeighborhoodNodeProjection[];
  edges: Array<{
    parentSessionId: string;
    childSessionId: string;
  }>;
}

export interface ExportSessionForkRequest {
  sessionId: string;
  exportId: string;
  mode: SessionExportModeV2;
}

export interface ImportSessionForkRequest {
  envelope: SessionExportEnvelopeV2;
  targetProjectId: string;
  namespace: string;
  allowProjectRemap?: boolean;
}

export interface ImportSessionForkResponse {
  importId: string;
  sourceExportId: string;
  rootSessionId: string;
  sessionIdMap: Record<string, string>;
  messageIdMap: Record<string, string>;
  forkIdMap: Record<string, string>;
  importedAt: number;
}

export interface EnqueueSessionForkSyncRequest {
  exportId: string;
  projectId: string;
  syncEnvelopeId: string;
  dependencyIds?: string[];
}

export interface IngestSessionForkSyncRequest {
  wire: SessionForkSyncWireEnvelope;
  targetProjectId: string;
}

export interface ImportReadySessionForkSyncRequest {
  syncEnvelopeId: string;
  targetProjectId: string;
  namespace: string;
}

export interface ImportReadySessionForkSyncResponse {
  sync: SessionForkSyncEnvelopeRecord;
  imported: ImportSessionForkResponse;
}

export interface SearchSessionForkExportsRequest {
  exportId: string;
  projectId: string;
  query: string;
}

export interface ReadSessionForkTreeRequest {
  exportId: string;
  projectId: string;
}

export interface ReadSessionForkNeighborhoodRequest extends ReadSessionForkTreeRequest {
  centerSessionId: string;
  radius?: number;
}
