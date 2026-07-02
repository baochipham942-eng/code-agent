// ============================================================================
// Neo Tag Contract (P0)
// ============================================================================

export const NEO_TAG_IPC_DOMAIN = 'domain:tag' as const;

export type NeoTagSignalKind =
  | 'direct_invocation'
  | 'context_scan'
  | 'work_card_update'
  | 'scheduled_wakeup'
  | 'memory_update'
  | 'work_card_closed';

export type NeoTagSignalSource = 'conversation' | 'schedule' | 'hook' | 'system';

export type NeoTagIntent =
  | 'answer'
  | 'research'
  | 'plan'
  | 'implement'
  | 'review'
  | 'remember'
  | 'forget'
  | 'schedule'
  | 'resume_work'
  | 'cancel_work';

export type NeoWorkCardStatus =
  | 'draft'
  | 'needs_review'
  | 'approved'
  | 'queued'
  | 'working'
  | 'waiting_for_user'
  | 'in_result_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived';

export type NeoWorkCardUpdateReason =
  | 'draft_created'
  | 'draft_updated'
  | 'revision_approved'
  | 'revision_rejected'
  | 'card_cancelled'
  | 'card_archived'
  | 'result_accepted'
  | 'changes_requested'
  | 'memory_candidate_updated'
  | 'delta_appended'
  | 'runtime_queued'
  | 'runtime_working'
  | 'runtime_waiting_for_user'
  | 'runtime_result_review'
  | 'runtime_failed';

export type NeoWorkCardApprovalDecision = 'approved' | 'rejected' | 'revoked';

export type NeoWorkCardResultReviewDecision = 'accepted' | 'changes_requested' | 'archived';

export type NeoMemoryCandidateSource = 'explicit_memory_plan' | 'result_review';

export type NeoMemoryCandidateStatus = 'pending' | 'rejected' | 'written';

export type NeoReadScopeMode = 'none' | 'selected_context' | 'current_project';

export type NeoWriteScopeMode = 'none' | 'current_project';

export type NeoContextPackStrategy =
  | 'focused_reply'
  | 'work_card_thread'
  | 'deictic_recent'
  | 'project_retrieval'
  | 'plain';

export type NeoTagMemoryKind =
  | 'decision'
  | 'constraint'
  | 'business_rule'
  | 'failed_path'
  | 'project_preference'
  | 'artifact_fact'
  | 'workflow_convention';

export interface NeoTagSignal {
  id: string;
  kind: NeoTagSignalKind;
  source: NeoTagSignalSource;
  projectId: string;
  sourceConversationId: string;
  sourceTurnId: string;
  requesterUserId: string;
  userText: string;
  selectedMessageIds: string[];
  selectedArtifactIds: string[];
  currentWorkCardId?: string;
  createdAt: number;
}

export type NeoModelIntent =
  | {
      mode: 'inherit_current';
    }
  | {
      mode: 'adaptive_auto';
      provider?: string;
      model?: string;
      taskStrategy?: 'fast' | 'main' | 'deep' | 'vision' | string;
    }
  | {
      mode: 'fixed_model';
      provider: string;
      model: string;
    };

export interface NeoReadScope {
  mode: NeoReadScopeMode;
  projectId: string;
  conversationIds: string[];
  messageIds: string[];
  artifactIds: string[];
  fileGlobs: string[];
  memoryEntryIds: string[];
  notes: string[];
}

export interface NeoWriteScope {
  mode: NeoWriteScopeMode;
  projectId: string;
  allowedPaths: string[];
  canCreateFiles: boolean;
  canModifyFiles: boolean;
  canWriteProjectMemory: boolean;
  externalDestinations: string[];
  notes: string[];
}

export interface NeoMemoryPlanEntry {
  kind: NeoTagMemoryKind;
  text: string;
  sourceMessageIds: string[];
}

export interface NeoMemoryPlan {
  mode: 'none' | 'explicit_only';
  entries: NeoMemoryPlanEntry[];
  notes: string[];
}

export interface NeoExpectedOutput {
  kind: 'answer' | 'plan' | 'patch' | 'artifact' | 'decision_log' | 'memory_update' | 'other';
  title: string;
  description?: string;
}

export interface NeoWorkCard {
  id: string;
  projectId: string;
  sourceConversationId: string;
  sourceTurnId: string;
  requesterUserId: string;
  title: string;
  status: NeoWorkCardStatus;
  currentRevisionId: string;
  approvedRevisionId?: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface NeoWorkCardRevision {
  id: string;
  workCardId: string;
  revisionNumber: number;
  intent: NeoTagIntent;
  taskSummary: string;
  readScope: NeoReadScope;
  writeScope: NeoWriteScope;
  modelIntent: NeoModelIntent;
  memoryPlan: NeoMemoryPlan;
  expectedOutputs: NeoExpectedOutput[];
  risks: string[];
  assumptions: string[];
  createdByUserId: string;
  createdAt: number;
}

export interface NeoWorkCardApproval {
  id: string;
  workCardId: string;
  revisionId: string;
  projectId: string;
  requesterUserId: string;
  approvedByUserId: string;
  decision: NeoWorkCardApprovalDecision;
  approvedReadScope: NeoReadScope;
  approvedWriteScope: NeoWriteScope;
  approvedModelIntent: NeoModelIntent;
  approvedMemoryPlan: NeoMemoryPlan;
  feedback?: string | null;
  expiresAt?: number | null;
  createdAt: number;
  revokedAt?: number | null;
  supersededByRevisionId?: string | null;
}

export interface NeoWorkCardDelta {
  id: string;
  workCardId: string;
  runId: string;
  /** 本轮实际发生的会话（跨会话续接后 ≠ sourceConversationId；老数据无此值时回退 sourceConversationId）。 */
  conversationId?: string;
  completed: string[];
  changedFiles: string[];
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  memoryCandidates: string[];
  nextStep?: string;
  createdAt: number;
}

export interface NeoWorkCardResultReview {
  id: string;
  workCardId: string;
  projectId: string;
  actorUserId: string;
  decision: NeoWorkCardResultReviewDecision;
  feedback?: string | null;
  openQuestions: string[];
  createdAt: number;
}

export interface NeoMemoryCandidate {
  id: string;
  workCardId: string;
  projectId: string;
  revisionId?: string | null;
  deltaId?: string | null;
  kind: NeoTagMemoryKind;
  text: string;
  source: NeoMemoryCandidateSource;
  status: NeoMemoryCandidateStatus;
  createdAt: number;
  decidedByUserId?: string | null;
  decidedAt?: number | null;
  rejectionReason?: string | null;
  writtenAt?: number | null;
  writtenMemoryKey?: string | null;
}

export interface NeoTagRunContext {
  workCardId: string;
  projectId: string;
  sourceConversationId: string;
  sourceTurnId: string;
  /** 本轮实际执行的会话；缺省 = sourceConversationId（跨会话续接时不同）。 */
  targetConversationId?: string;
  approvedRevisionId: string;
  runId: string;
  contextPackId: string;
  modelIntent: NeoModelIntent;
  contextPack: NeoTagContextPack;
  promptLayer?: string;
}

export interface NeoTagContextPack {
  id: string;
  projectId: string;
  workCardId: string;
  workCardRevisionId: string;
  seedConversationId: string;
  seedTurnId: string;
  strategy: NeoContextPackStrategy;
  selectedMessages: Array<{ id: string; reason: string; score: number }>;
  selectedArtifacts: Array<{ id: string; reason: string; score: number }>;
  selectedMemoryEntryIds: string[];
  selectedFiles: Array<{ path: string; reason: string }>;
  excluded: Array<{ id: string; reason: string }>;
  expandableScopes: Array<{ scope: string; handle: string; reason: string }>;
  budget: { maxTokens: number; estimatedTokens: number };
  createdAt: number;
}

export interface NeoWorkCardRevisionDraftInput {
  intent: NeoTagIntent;
  taskSummary: string;
  readScope?: Partial<NeoReadScope>;
  writeScope?: Partial<NeoWriteScope>;
  modelIntent?: NeoModelIntent;
  memoryPlan?: Partial<NeoMemoryPlan>;
  expectedOutputs?: NeoExpectedOutput[];
  risks?: string[];
  assumptions?: string[];
}

export interface CreateNeoWorkCardDraftInput {
  projectId: string;
  sourceConversationId: string;
  sourceTurnId: string;
  requesterUserId: string;
  title: string;
  userText?: string;
  selectedMessageIds?: string[];
  selectedArtifactIds?: string[];
  revision: NeoWorkCardRevisionDraftInput;
}

export interface UpdateNeoWorkCardDraftRevisionInput {
  workCardId: string;
  updatedByUserId: string;
  title?: string;
  revision: NeoWorkCardRevisionDraftInput;
}

export interface NeoWorkCardListOptions {
  includeArchived?: boolean;
  statuses?: NeoWorkCardStatus[];
  limit?: number;
}

export interface ReviewNeoWorkCardRevisionInput {
  workCardId: string;
  revisionId?: string;
  reviewerUserId: string;
  feedback?: string | null;
  expiresAt?: number | null;
}

export interface CloseNeoWorkCardInput {
  workCardId: string;
  actorUserId: string;
  feedback?: string | null;
}

export interface AppendNeoWorkCardDeltaInput {
  workCardId: string;
  runId: string;
  conversationId?: string;
  completed?: string[];
  changedFiles?: string[];
  decisions?: string[];
  openQuestions?: string[];
  risks?: string[];
  memoryCandidates?: string[];
  nextStep?: string;
  markResultReview?: boolean;
}

export interface NeoWorkCardWithCurrentRevision {
  workCard: NeoWorkCard;
  revision: NeoWorkCardRevision;
}

export interface NeoWorkCardDetail {
  workCard: NeoWorkCard;
  currentRevision: NeoWorkCardRevision | null;
  approvedRevision: NeoWorkCardRevision | null;
  revisions: NeoWorkCardRevision[];
  approvals: NeoWorkCardApproval[];
  deltas: NeoWorkCardDelta[];
  resultReviews: NeoWorkCardResultReview[];
  memoryCandidates: NeoMemoryCandidate[];
}

export interface NeoTagWorkCardUpdatedEvent {
  type: 'work_card_updated';
  reason: NeoWorkCardUpdateReason;
  workCardId: string;
  projectId: string;
  sourceConversationId: string;
  status: NeoWorkCardStatus;
  detail: NeoWorkCardDetail;
  occurredAt: number;
}

export type NeoTagEvent = NeoTagWorkCardUpdatedEvent;

export interface CreateNeoWorkCardDraftRequest {
  projectId?: string | null;
  workspacePath?: string | null;
  sourceConversationId: string;
  requesterUserId: string;
  userText: string;
  title: string;
  selectedMessageIds?: string[];
  selectedArtifactIds?: string[];
  clientSourceMessageId?: string;
  revision: NeoWorkCardRevisionDraftInput;
}

export interface CreateNeoWorkCardDraftResult {
  detail: NeoWorkCardDetail;
  sourceTurnId: string;
}

/** @neo 跨会话续接（ADR-033）：在任意会话把一轮追加到既有 topic。 */
export interface ContinueNeoWorkCardRequest {
  workCardId: string;
  /** 续接发生的会话 = 本轮执行落点。 */
  conversationId: string;
  userText: string;
  requesterUserId: string;
  selectedArtifactIds?: string[];
  /** renderer 本地补显的用户消息 ID；host 落库同 ID 去重（同 createAndRun 的 clientSourceMessageId 机制）。 */
  clientSourceMessageId?: string;
}

export interface ContinueNeoWorkCardResult {
  detail: NeoWorkCardDetail;
  /** 本轮用户消息锚点 ID。 */
  roundTurnId: string;
}

export interface ListNeoWorkCardsBySourceInput {
  sourceConversationId: string;
}

export interface ListNeoWorkCardsByProjectInput extends NeoWorkCardListOptions {
  projectId: string;
}

/** 全局 topic 目录（账号菜单「Neo 协同」）：跨项目列全部工作卡。 */
export type ListAllNeoWorkCardsInput = NeoWorkCardListOptions;

export type UpdateNeoWorkCardDraftRevisionRequest = UpdateNeoWorkCardDraftRevisionInput;

export interface NeoWorkCardReviewActionInput {
  workCardId: string;
  actorUserId: string;
  revisionId?: string;
  feedback?: string | null;
  expiresAt?: number | null;
}

export interface NeoWorkCardCloseActionInput {
  workCardId: string;
  actorUserId: string;
  feedback?: string | null;
}

export interface NeoWorkCardAcceptResultInput {
  workCardId: string;
  actorUserId: string;
  feedback?: string | null;
}

export interface NeoWorkCardRequestChangesInput {
  workCardId: string;
  actorUserId: string;
  feedback?: string | null;
  openQuestions?: string[];
}

export interface NeoMemoryCandidateDecisionInput {
  candidateId: string;
  actorUserId: string;
  reason?: string | null;
}
