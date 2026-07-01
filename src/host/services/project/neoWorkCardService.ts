import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../core/databaseService';
import { NeoWorkCardRepository } from '../core/repositories/NeoWorkCardRepository';
import type {
  AppendNeoWorkCardDeltaInput,
  CloseNeoWorkCardInput,
  CreateNeoWorkCardDraftInput,
  NeoMemoryCandidate,
  NeoMemoryCandidateDecisionInput,
  NeoExpectedOutput,
  NeoMemoryPlan,
  NeoMemoryPlanEntry,
  NeoModelIntent,
  NeoReadScope,
  NeoWorkCard,
  NeoWorkCardAcceptResultInput,
  NeoWorkCardApproval,
  NeoWorkCardDelta,
  NeoWorkCardDetail,
  NeoWorkCardListOptions,
  NeoWorkCardRequestChangesInput,
  NeoWorkCardResultReview,
  NeoWorkCardRevision,
  NeoWorkCardRevisionDraftInput,
  NeoWorkCardWithCurrentRevision,
  NeoWriteScope,
  ReviewNeoWorkCardRevisionInput,
  UpdateNeoWorkCardDraftRevisionInput,
} from '../../../shared/contract/tag';

type RepoProvider = () => NeoWorkCardRepository;

let cachedRepo: { db: BetterSqlite3.Database; repo: NeoWorkCardRepository } | null = null;

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function getDefaultRepo(): NeoWorkCardRepository {
  const dbService = getDatabase();
  if (!dbService.isReady) {
    throw new NeoWorkCardServiceError('UNAVAILABLE', 'Neo work card repository is not ready');
  }
  const db = dbService.getDb();
  if (!db) {
    throw new NeoWorkCardServiceError('UNAVAILABLE', 'Neo work card database is not available');
  }
  if (cachedRepo?.db !== db) {
    cachedRepo = { db, repo: new NeoWorkCardRepository(db) };
  }
  return cachedRepo.repo;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanNullableString(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter((item) => item.length > 0);
}

function normalizeModelIntent(input?: NeoModelIntent): NeoModelIntent {
  if (!input || input.mode === 'inherit_current') return { mode: 'inherit_current' };
  if (input.mode === 'adaptive_auto') {
    const provider = cleanNullableString(input.provider);
    const model = cleanNullableString(input.model);
    const taskStrategy = cleanNullableString(input.taskStrategy);
    return {
      mode: 'adaptive_auto',
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(taskStrategy ? { taskStrategy } : {}),
    };
  }
  const provider = cleanString(input.provider);
  const model = cleanString(input.model);
  if (!provider || !model) {
    throw new NeoWorkCardServiceError('INVALID_ARGS', 'fixed_model requires provider and model');
  }
  return { mode: 'fixed_model', provider, model };
}

function buildReadScope(args: {
  projectId: string;
  sourceConversationId: string;
  selectedMessageIds?: string[];
  selectedArtifactIds?: string[];
  input: NeoWorkCardRevisionDraftInput;
}): NeoReadScope {
  const readScope = args.input.readScope ?? {};
  const conversationIds = cleanStringArray(readScope.conversationIds);
  const messageIds = cleanStringArray(readScope.messageIds);
  const artifactIds = cleanStringArray(readScope.artifactIds);
  return {
    mode: readScope.mode ?? 'current_project',
    projectId: args.projectId,
    conversationIds: conversationIds.length > 0 ? conversationIds : [args.sourceConversationId],
    messageIds: messageIds.length > 0 ? messageIds : cleanStringArray(args.selectedMessageIds),
    artifactIds: artifactIds.length > 0 ? artifactIds : cleanStringArray(args.selectedArtifactIds),
    fileGlobs: cleanStringArray(readScope.fileGlobs),
    memoryEntryIds: cleanStringArray(readScope.memoryEntryIds),
    notes: cleanStringArray(readScope.notes),
  };
}

function buildWriteScope(projectId: string, input: NeoWorkCardRevisionDraftInput): NeoWriteScope {
  const writeScope = input.writeScope ?? {};
  return {
    mode: writeScope.mode ?? 'none',
    projectId,
    allowedPaths: cleanStringArray(writeScope.allowedPaths),
    canCreateFiles: writeScope.canCreateFiles ?? false,
    canModifyFiles: writeScope.canModifyFiles ?? false,
    canWriteProjectMemory: writeScope.canWriteProjectMemory ?? false,
    externalDestinations: cleanStringArray(writeScope.externalDestinations),
    notes: cleanStringArray(writeScope.notes),
  };
}

function buildMemoryPlan(input: NeoWorkCardRevisionDraftInput): NeoMemoryPlan {
  const memoryPlan = input.memoryPlan ?? {};
  const entries = Array.isArray(memoryPlan.entries)
    ? memoryPlan.entries
        .map((entry): NeoMemoryPlanEntry => ({
          kind: entry.kind,
          text: cleanString(entry.text),
          sourceMessageIds: cleanStringArray(entry.sourceMessageIds),
        }))
        .filter((entry) => entry.text.length > 0)
    : [];
  return {
    mode: memoryPlan.mode ?? 'none',
    entries,
    notes: cleanStringArray(memoryPlan.notes),
  };
}

function buildExpectedOutputs(input: NeoWorkCardRevisionDraftInput): NeoExpectedOutput[] {
  if (!Array.isArray(input.expectedOutputs)) return [];
  return input.expectedOutputs
    .map((output): NeoExpectedOutput => {
      const description = cleanNullableString(output.description);
      return {
        kind: output.kind,
        title: cleanString(output.title),
        ...(description ? { description } : {}),
      };
    })
    .filter((output) => output.title.length > 0);
}

function buildRevision(args: {
  id: string;
  workCardId: string;
  sourceConversationId: string;
  selectedMessageIds?: string[];
  selectedArtifactIds?: string[];
  projectId: string;
  revisionNumber: number;
  createdByUserId: string;
  createdAt: number;
  input: NeoWorkCardRevisionDraftInput;
}): NeoWorkCardRevision {
  const taskSummary = cleanString(args.input.taskSummary);
  if (!taskSummary) {
    throw new NeoWorkCardServiceError('INVALID_ARGS', 'revision.taskSummary is required');
  }
  return {
    id: args.id,
    workCardId: args.workCardId,
    revisionNumber: args.revisionNumber,
    intent: args.input.intent,
    taskSummary,
    readScope: buildReadScope(args),
    writeScope: buildWriteScope(args.projectId, args.input),
    modelIntent: normalizeModelIntent(args.input.modelIntent),
    memoryPlan: buildMemoryPlan(args.input),
    expectedOutputs: buildExpectedOutputs(args.input),
    risks: cleanStringArray(args.input.risks),
    assumptions: cleanStringArray(args.input.assumptions),
    createdByUserId: args.createdByUserId,
    createdAt: args.createdAt,
  };
}

function assertOpen(card: NeoWorkCard): void {
  if (card.status === 'archived' || card.status === 'cancelled') {
    throw new NeoWorkCardServiceError('INVALID_STATE', 'work card is closed');
  }
}

function shouldMoveToResultReview(card: NeoWorkCard, input: AppendNeoWorkCardDeltaInput): boolean {
  if (input.markResultReview === false) return false;
  if (input.markResultReview === true) return card.status !== 'draft' && card.status !== 'needs_review';
  return ['approved', 'queued', 'working', 'waiting_for_user'].includes(card.status);
}

export class NeoWorkCardServiceError extends Error {
  constructor(
    public readonly code: 'INVALID_ARGS' | 'NOT_FOUND' | 'INVALID_STATE' | 'CONFLICT' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'NeoWorkCardServiceError';
  }
}

export class NeoWorkCardService {
  constructor(private readonly repoProvider: RepoProvider = getDefaultRepo) {}

  createDraft(input: CreateNeoWorkCardDraftInput, now = Date.now()): NeoWorkCardWithCurrentRevision {
    const projectId = cleanString(input.projectId);
    const sourceConversationId = cleanString(input.sourceConversationId);
    const sourceTurnId = cleanString(input.sourceTurnId);
    const requesterUserId = cleanString(input.requesterUserId);
    const title = cleanString(input.title);
    if (!projectId || !sourceConversationId || !sourceTurnId || !requesterUserId || !title) {
      throw new NeoWorkCardServiceError(
        'INVALID_ARGS',
        'projectId, sourceConversationId, sourceTurnId, requesterUserId, and title are required',
      );
    }
    if (!input.revision) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'revision is required');
    }

    const workCardId = shortId('nwc');
    const revisionId = shortId('nwcr');
    const revision = buildRevision({
      id: revisionId,
      workCardId,
      sourceConversationId,
      selectedMessageIds: input.selectedMessageIds,
      selectedArtifactIds: input.selectedArtifactIds,
      projectId,
      revisionNumber: 1,
      createdByUserId: requesterUserId,
      createdAt: now,
      input: input.revision,
    });
    const workCard: NeoWorkCard = {
      id: workCardId,
      projectId,
      sourceConversationId,
      sourceTurnId,
      requesterUserId,
      title,
      status: 'draft',
      currentRevisionId: revisionId,
      approvedRevisionId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.repoProvider().createDraft(workCard, revision);
    return { workCard, revision };
  }

  get(workCardId: string): NeoWorkCardDetail | null {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(workCardId));
    if (!workCard) return null;
    const revisions = repo.listRevisions(workCard.id);
    const currentRevision = revisions.find((revision) => revision.id === workCard.currentRevisionId) ?? null;
    const approvedRevision = workCard.approvedRevisionId
      ? revisions.find((revision) => revision.id === workCard.approvedRevisionId) ?? null
      : null;
    return {
      workCard,
      currentRevision,
      approvedRevision,
      revisions,
      approvals: repo.listApprovals(workCard.id),
      deltas: repo.listDeltas(workCard.id),
      resultReviews: repo.listResultReviews(workCard.id),
      memoryCandidates: repo.listMemoryCandidates(workCard.id),
    };
  }

  listByProject(projectId: string, options: NeoWorkCardListOptions = {}): NeoWorkCard[] {
    const normalizedProjectId = cleanString(projectId);
    if (!normalizedProjectId) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'projectId is required');
    }
    return this.repoProvider().listByProject(normalizedProjectId, options);
  }

  listBySourceConversation(
    sourceConversationId: string,
    options: NeoWorkCardListOptions = {},
  ): NeoWorkCardDetail[] {
    const normalizedSourceConversationId = cleanString(sourceConversationId);
    if (!normalizedSourceConversationId) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'sourceConversationId is required');
    }
    return this.repoProvider()
      .listBySourceConversation(normalizedSourceConversationId, options)
      .map((card) => this.get(card.id))
      .filter((detail): detail is NeoWorkCardDetail => Boolean(detail));
  }

  updateDraftRevision(
    input: UpdateNeoWorkCardDraftRevisionInput,
    now = Date.now(),
  ): NeoWorkCardWithCurrentRevision {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    const updatedByUserId = cleanString(input.updatedByUserId);
    if (!updatedByUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'updatedByUserId is required');
    if (!input.revision) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'revision is required');
    }
    const nextRevision = buildRevision({
      id: shortId('nwcr'),
      workCardId: workCard.id,
      sourceConversationId: workCard.sourceConversationId,
      projectId: workCard.projectId,
      revisionNumber: repo.getLatestRevisionNumber(workCard.id) + 1,
      createdByUserId: updatedByUserId,
      createdAt: now,
      input: input.revision,
    });
    repo.appendRevisionAndUpdateCard(nextRevision, {
      title: cleanString(input.title) || undefined,
      status: 'draft',
      clearApprovedRevision: true,
      updatedAt: now,
    });
    const updated = repo.getWorkCard(workCard.id);
    if (!updated) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found after update');
    return { workCard: updated, revision: nextRevision };
  }

  approveRevision(input: ReviewNeoWorkCardRevisionInput, now = Date.now()): NeoWorkCardApproval {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    const revisionId = cleanString(input.revisionId) || workCard.currentRevisionId;
    if (revisionId !== workCard.currentRevisionId) {
      throw new NeoWorkCardServiceError('CONFLICT', 'only the current revision can be approved');
    }
    const revision = repo.getRevision(revisionId);
    if (revision?.workCardId !== workCard.id) {
      throw new NeoWorkCardServiceError('NOT_FOUND', 'revision not found');
    }
    const reviewerUserId = cleanString(input.reviewerUserId);
    if (!reviewerUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'reviewerUserId is required');

    const approval = this.buildApproval(workCard, revision, {
      decision: 'approved',
      approvedByUserId: reviewerUserId,
      feedback: input.feedback ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    });
    repo.createApproval(approval);
    repo.setApprovedRevision(workCard.id, revision.id, now);
    repo.insertMemoryCandidates(this.buildExplicitMemoryCandidates(workCard, revision, now));
    return approval;
  }

  rejectRevision(input: ReviewNeoWorkCardRevisionInput, now = Date.now()): NeoWorkCardApproval {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    const revisionId = cleanString(input.revisionId) || workCard.currentRevisionId;
    if (revisionId !== workCard.currentRevisionId) {
      throw new NeoWorkCardServiceError('CONFLICT', 'only the current revision can be rejected');
    }
    const revision = repo.getRevision(revisionId);
    if (revision?.workCardId !== workCard.id) {
      throw new NeoWorkCardServiceError('NOT_FOUND', 'revision not found');
    }
    const reviewerUserId = cleanString(input.reviewerUserId);
    if (!reviewerUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'reviewerUserId is required');

    repo.revokeApprovedApprovalsForWorkCard(workCard.id, now, null, input.feedback ?? null);
    const approval = this.buildApproval(workCard, revision, {
      decision: 'rejected',
      approvedByUserId: reviewerUserId,
      feedback: input.feedback ?? null,
      expiresAt: null,
      createdAt: now,
    });
    repo.createApproval(approval);
    repo.clearApprovedRevision(workCard.id, 'needs_review', now);
    return approval;
  }

  cancel(input: CloseNeoWorkCardInput, now = Date.now()): NeoWorkCard | null {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) return null;
    if (workCard.status === 'archived') {
      throw new NeoWorkCardServiceError('INVALID_STATE', 'archived work card cannot be cancelled');
    }
    const actorUserId = cleanString(input.actorUserId);
    if (!actorUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'actorUserId is required');
    repo.revokeApprovedApprovalsForWorkCard(workCard.id, now, null, input.feedback ?? 'Cancelled');
    repo.setStatus({
      workCardId: workCard.id,
      status: 'cancelled',
      updatedAt: now,
    });
    return repo.getWorkCard(workCard.id);
  }

  archive(input: string | CloseNeoWorkCardInput, now = Date.now()): NeoWorkCard | null {
    const repo = this.repoProvider();
    const workCardId = typeof input === 'string' ? input : input.workCardId;
    const workCard = repo.getWorkCard(cleanString(workCardId));
    if (!workCard) return null;
    if (typeof input !== 'string') {
      const actorUserId = cleanString(input.actorUserId);
      if (!actorUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'actorUserId is required');
      repo.appendResultReview(this.buildResultReview(workCard, {
        actorUserId,
        decision: 'archived',
        feedback: input.feedback ?? null,
        openQuestions: [],
        createdAt: now,
      }));
    }
    repo.archiveWorkCard(workCard.id, now);
    return repo.getWorkCard(workCard.id);
  }

  appendDelta(input: AppendNeoWorkCardDeltaInput, now = Date.now()): NeoWorkCardDelta {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    const runId = cleanString(input.runId);
    if (!runId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'runId is required');
    const delta = {
      id: shortId('nwcd'),
      workCardId: workCard.id,
      runId,
      completed: cleanStringArray(input.completed),
      changedFiles: cleanStringArray(input.changedFiles),
      decisions: cleanStringArray(input.decisions),
      openQuestions: cleanStringArray(input.openQuestions),
      risks: cleanStringArray(input.risks),
      memoryCandidates: cleanStringArray(input.memoryCandidates),
      nextStep: cleanString(input.nextStep) || undefined,
      createdAt: now,
    };
    repo.appendDelta(delta);
    repo.insertMemoryCandidates(this.buildResultReviewMemoryCandidates(workCard, delta, now));
    if (shouldMoveToResultReview(workCard, input)) {
      repo.setWorkCardStatus(workCard.id, 'in_result_review', now);
    }
    return delta;
  }

  setStatus(
    workCardId: string,
    status: NeoWorkCard['status'],
    now = Date.now(),
  ): NeoWorkCard {
    const repo = this.repoProvider();
    const normalizedWorkCardId = cleanString(workCardId);
    const workCard = repo.getWorkCard(normalizedWorkCardId);
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    repo.setWorkCardStatus(workCard.id, status, now);
    const updated = repo.getWorkCard(workCard.id);
    if (!updated) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found after status update');
    return updated;
  }

  acceptResult(input: NeoWorkCardAcceptResultInput, now = Date.now()): NeoWorkCardDetail {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    if (workCard.status !== 'in_result_review') {
      throw new NeoWorkCardServiceError('INVALID_STATE', 'work card result is not ready for review');
    }
    const actorUserId = cleanString(input.actorUserId);
    if (!actorUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'actorUserId is required');
    repo.appendResultReview(this.buildResultReview(workCard, {
      actorUserId,
      decision: 'accepted',
      feedback: input.feedback ?? null,
      openQuestions: [],
      createdAt: now,
    }));
    repo.setWorkCardStatus(workCard.id, 'completed', now);
    const detail = this.get(workCard.id);
    if (!detail) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found after accepting result');
    return detail;
  }

  requestChanges(input: NeoWorkCardRequestChangesInput, now = Date.now()): NeoWorkCardDetail {
    const repo = this.repoProvider();
    const workCard = repo.getWorkCard(cleanString(input.workCardId));
    if (!workCard) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
    assertOpen(workCard);
    if (workCard.status !== 'in_result_review') {
      throw new NeoWorkCardServiceError('INVALID_STATE', 'work card result is not ready for review');
    }
    const actorUserId = cleanString(input.actorUserId);
    if (!actorUserId) throw new NeoWorkCardServiceError('INVALID_ARGS', 'actorUserId is required');
    const openQuestions = cleanStringArray(input.openQuestions);
    repo.appendResultReview(this.buildResultReview(workCard, {
      actorUserId,
      decision: 'changes_requested',
      feedback: input.feedback ?? null,
      openQuestions,
      createdAt: now,
    }));
    repo.appendDelta({
      id: shortId('nwcd'),
      workCardId: workCard.id,
      runId: `review:${shortId('run')}`,
      completed: [],
      changedFiles: [],
      decisions: [],
      openQuestions,
      risks: [],
      memoryCandidates: [],
      nextStep: cleanString(input.feedback) || undefined,
      createdAt: now,
    });
    repo.setWorkCardStatus(workCard.id, workCard.approvedRevisionId ? 'working' : 'needs_review', now);
    const detail = this.get(workCard.id);
    if (!detail) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found after requesting changes');
    return detail;
  }

  approveMemoryCandidate(input: NeoMemoryCandidateDecisionInput, now = Date.now()): NeoMemoryCandidate {
    const repo = this.repoProvider();
    const candidateId = cleanString(input.candidateId);
    const actorUserId = cleanString(input.actorUserId);
    if (!candidateId || !actorUserId) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'candidateId and actorUserId are required');
    }
    const candidate = repo.writeMemoryCandidate(candidateId, actorUserId, now);
    if (!candidate) {
      throw new NeoWorkCardServiceError('INVALID_STATE', 'memory candidate is not pending');
    }
    return candidate;
  }

  rejectMemoryCandidate(input: NeoMemoryCandidateDecisionInput, now = Date.now()): NeoMemoryCandidate {
    const repo = this.repoProvider();
    const candidateId = cleanString(input.candidateId);
    const actorUserId = cleanString(input.actorUserId);
    if (!candidateId || !actorUserId) {
      throw new NeoWorkCardServiceError('INVALID_ARGS', 'candidateId and actorUserId are required');
    }
    const existing = repo.getMemoryCandidate(candidateId);
    if (!existing) throw new NeoWorkCardServiceError('NOT_FOUND', 'memory candidate not found');
    if (!repo.rejectMemoryCandidate(candidateId, actorUserId, input.reason ?? null, now)) {
      throw new NeoWorkCardServiceError('INVALID_STATE', 'memory candidate is not pending');
    }
    const rejected = repo.getMemoryCandidate(candidateId);
    if (!rejected) throw new NeoWorkCardServiceError('NOT_FOUND', 'memory candidate not found after rejecting');
    return rejected;
  }

  private buildApproval(
    workCard: NeoWorkCard,
    revision: NeoWorkCardRevision,
    args: {
      decision: NeoWorkCardApproval['decision'];
      approvedByUserId: string;
      feedback: string | null;
      expiresAt: number | null;
      createdAt: number;
    },
  ): NeoWorkCardApproval {
    return {
      id: shortId('nwca'),
      workCardId: workCard.id,
      revisionId: revision.id,
      projectId: workCard.projectId,
      requesterUserId: workCard.requesterUserId,
      approvedByUserId: args.approvedByUserId,
      decision: args.decision,
      approvedReadScope: revision.readScope,
      approvedWriteScope: revision.writeScope,
      approvedModelIntent: revision.modelIntent,
      approvedMemoryPlan: revision.memoryPlan,
      feedback: args.feedback,
      expiresAt: args.expiresAt,
      createdAt: args.createdAt,
      revokedAt: null,
      supersededByRevisionId: null,
    };
  }

  private buildResultReview(
    workCard: NeoWorkCard,
    args: {
      actorUserId: string;
      decision: NeoWorkCardResultReview['decision'];
      feedback: string | null;
      openQuestions: string[];
      createdAt: number;
    },
  ): NeoWorkCardResultReview {
    return {
      id: shortId('nwrr'),
      workCardId: workCard.id,
      projectId: workCard.projectId,
      actorUserId: args.actorUserId,
      decision: args.decision,
      feedback: args.feedback,
      openQuestions: args.openQuestions,
      createdAt: args.createdAt,
    };
  }

  private buildExplicitMemoryCandidates(
    workCard: NeoWorkCard,
    revision: NeoWorkCardRevision,
    createdAt: number,
  ): NeoMemoryCandidate[] {
    if (revision.memoryPlan.mode !== 'explicit_only') return [];
    if (!revision.writeScope.canWriteProjectMemory) return [];
    return revision.memoryPlan.entries.map((entry) => ({
      id: shortId('nwmc'),
      workCardId: workCard.id,
      projectId: workCard.projectId,
      revisionId: revision.id,
      deltaId: null,
      kind: entry.kind,
      text: entry.text,
      source: 'explicit_memory_plan',
      status: 'pending',
      createdAt,
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
      writtenAt: null,
      writtenMemoryKey: null,
    }));
  }

  private buildResultReviewMemoryCandidates(
    workCard: NeoWorkCard,
    delta: NeoWorkCardDelta,
    createdAt: number,
  ): NeoMemoryCandidate[] {
    return delta.memoryCandidates.map((text) => ({
      id: shortId('nwmc'),
      workCardId: workCard.id,
      projectId: workCard.projectId,
      revisionId: workCard.approvedRevisionId ?? workCard.currentRevisionId,
      deltaId: delta.id,
      kind: 'artifact_fact',
      text,
      source: 'result_review',
      status: 'pending',
      createdAt,
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
      writtenAt: null,
      writtenMemoryKey: null,
    }));
  }
}

let instance: NeoWorkCardService | null = null;

export function getNeoWorkCardService(): NeoWorkCardService {
  if (!instance) instance = new NeoWorkCardService();
  return instance;
}
