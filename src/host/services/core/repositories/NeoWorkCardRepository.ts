// ============================================================================
// NeoWorkCardRepository - Neo Tag P0 work card persistence
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../databaseService';
import type {
  NeoExpectedOutput,
  NeoMemoryCandidate,
  NeoMemoryCandidateSource,
  NeoMemoryCandidateStatus,
  NeoMemoryPlan,
  NeoModelIntent,
  NeoReadScope,
  NeoTagIntent,
  NeoTagMemoryKind,
  NeoWorkCard,
  NeoWorkCardApproval,
  NeoWorkCardApprovalDecision,
  NeoWorkCardDelta,
  NeoWorkCardListOptions,
  NeoWorkCardResultReview,
  NeoWorkCardResultReviewDecision,
  NeoWorkCardRevision,
  NeoWorkCardStatus,
  NeoWriteScope,
} from '../../../../shared/contract/tag';

type SQLiteRow = Record<string, unknown>;

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return 'null';
  }
}

function deserialize<T>(json: unknown, fallback: T): T {
  if (typeof json !== 'string' || json.length === 0) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToWorkCard(row: SQLiteRow): NeoWorkCard {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceConversationId: String(row.source_conversation_id),
    sourceTurnId: String(row.source_turn_id),
    requesterUserId: String(row.requester_user_id),
    title: String(row.title),
    status: row.status as NeoWorkCardStatus,
    currentRevisionId: String(row.current_revision_id),
    approvedRevisionId: row.approved_revision_id == null ? null : String(row.approved_revision_id),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
  };
}

function rowToRevision(row: SQLiteRow): NeoWorkCardRevision {
  return {
    id: String(row.id),
    workCardId: String(row.work_card_id),
    revisionNumber: Number(row.revision_number) || 0,
    intent: row.intent as NeoTagIntent,
    taskSummary: String(row.task_summary),
    readScope: deserialize<NeoReadScope>(row.read_scope_json, {} as NeoReadScope),
    writeScope: deserialize<NeoWriteScope>(row.write_scope_json, {} as NeoWriteScope),
    modelIntent: deserialize<NeoModelIntent>(row.model_intent_json, { mode: 'inherit_current' }),
    memoryPlan: deserialize<NeoMemoryPlan>(row.memory_plan_json, { mode: 'none', entries: [], notes: [] }),
    expectedOutputs: deserialize<NeoExpectedOutput[]>(row.expected_outputs_json, []),
    risks: deserialize<string[]>(row.risks_json, []),
    assumptions: deserialize<string[]>(row.assumptions_json, []),
    createdByUserId: String(row.created_by_user_id),
    createdAt: Number(row.created_at) || 0,
  };
}

function rowToApproval(row: SQLiteRow): NeoWorkCardApproval {
  return {
    id: String(row.id),
    workCardId: String(row.work_card_id),
    revisionId: String(row.revision_id),
    projectId: String(row.project_id),
    requesterUserId: String(row.requester_user_id),
    approvedByUserId: String(row.approved_by_user_id),
    decision: row.decision as NeoWorkCardApprovalDecision,
    approvedReadScope: deserialize<NeoReadScope>(row.approved_read_scope_json, {} as NeoReadScope),
    approvedWriteScope: deserialize<NeoWriteScope>(row.approved_write_scope_json, {} as NeoWriteScope),
    approvedModelIntent: deserialize<NeoModelIntent>(row.approved_model_intent_json, { mode: 'inherit_current' }),
    approvedMemoryPlan: deserialize<NeoMemoryPlan>(row.approved_memory_plan_json, { mode: 'none', entries: [], notes: [] }),
    feedback: row.feedback == null ? null : String(row.feedback),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at) || 0,
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    supersededByRevisionId: row.superseded_by_revision_id == null ? null : String(row.superseded_by_revision_id),
  };
}

function rowToDelta(row: SQLiteRow): NeoWorkCardDelta {
  return {
    id: String(row.id),
    workCardId: String(row.work_card_id),
    runId: String(row.run_id),
    conversationId: row.conversation_id == null ? undefined : String(row.conversation_id),
    completed: deserialize<string[]>(row.completed_json, []),
    changedFiles: deserialize<string[]>(row.changed_files_json, []),
    decisions: deserialize<string[]>(row.decisions_json, []),
    openQuestions: deserialize<string[]>(row.open_questions_json, []),
    risks: deserialize<string[]>(row.risks_json, []),
    memoryCandidates: deserialize<string[]>(row.memory_candidates_json, []),
    nextStep: row.next_step == null ? undefined : String(row.next_step),
    createdAt: Number(row.created_at) || 0,
  };
}

function rowToResultReview(row: SQLiteRow): NeoWorkCardResultReview {
  return {
    id: String(row.id),
    workCardId: String(row.work_card_id),
    projectId: String(row.project_id),
    actorUserId: String(row.actor_user_id),
    decision: row.decision as NeoWorkCardResultReviewDecision,
    feedback: row.feedback == null ? null : String(row.feedback),
    openQuestions: deserialize<string[]>(row.open_questions_json, []),
    createdAt: Number(row.created_at) || 0,
  };
}

function rowToMemoryCandidate(row: SQLiteRow): NeoMemoryCandidate {
  return {
    id: String(row.id),
    workCardId: String(row.work_card_id),
    projectId: String(row.project_id),
    revisionId: row.revision_id == null ? null : String(row.revision_id),
    deltaId: row.delta_id == null ? null : String(row.delta_id),
    kind: row.kind as NeoTagMemoryKind,
    text: String(row.text),
    source: row.source as NeoMemoryCandidateSource,
    status: row.status as NeoMemoryCandidateStatus,
    createdAt: Number(row.created_at) || 0,
    decidedByUserId: row.decided_by_user_id == null ? null : String(row.decided_by_user_id),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    rejectionReason: row.rejection_reason == null ? null : String(row.rejection_reason),
    writtenAt: row.written_at == null ? null : Number(row.written_at),
    writtenMemoryKey: row.written_memory_key == null ? null : String(row.written_memory_key),
  };
}

export interface AppendNeoWorkCardRevisionOptions {
  title?: string;
  status: NeoWorkCardStatus;
  updatedAt: number;
  clearApprovedRevision?: boolean;
  revokeApprovedApprovalsFeedback?: string | null;
}

export interface UpdateNeoWorkCardDraftRowInput {
  workCardId: string;
  title?: string;
  status: NeoWorkCardStatus;
  currentRevisionId: string;
  approvedRevisionId: string | null;
  updatedAt: number;
}

export interface SetNeoWorkCardStatusInput {
  workCardId: string;
  status: NeoWorkCardStatus;
  updatedAt: number;
  archivedAt?: number | null;
}

export class NeoWorkCardRepository {
  constructor(private db: BetterSqlite3.Database) {}

  createDraft(card: NeoWorkCard, revision: NeoWorkCardRevision): void {
    const tx = this.db.transaction(() => {
      this.insertWorkCardRow(card);
      this.insertRevisionRow(revision);
    });
    tx();
  }

  insertWorkCard(card: NeoWorkCard): void {
    this.insertWorkCardRow(card);
  }

  getWorkCard(workCardId: string): NeoWorkCard | null {
    const row = this.db.prepare('SELECT * FROM neo_work_cards WHERE id = ?').get(workCardId) as SQLiteRow | undefined;
    return row ? rowToWorkCard(row) : null;
  }

  listByProject(projectId: string, options: NeoWorkCardListOptions = {}): NeoWorkCard[] {
    const clauses = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      args.push(...options.statuses);
    }
    const boundedLimit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = this.db
      .prepare(`
        SELECT * FROM neo_work_cards
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(...args, boundedLimit) as SQLiteRow[];
    return rows.map(rowToWorkCard);
  }

  // 全局 topic 目录（账号菜单「Neo 协同」）：跨项目列全部工作卡，不按 projectId 过滤
  listAll(options: NeoWorkCardListOptions = {}): NeoWorkCard[] {
    const clauses = ['1 = 1'];
    const args: unknown[] = [];
    if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      args.push(...options.statuses);
    }
    const boundedLimit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = this.db
      .prepare(`
        SELECT * FROM neo_work_cards
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(...args, boundedLimit) as SQLiteRow[];
    return rows.map(rowToWorkCard);
  }

  listBySourceConversation(sourceConversationId: string, options: NeoWorkCardListOptions = {}): NeoWorkCard[] {
    const clauses = ['source_conversation_id = ?'];
    const args: unknown[] = [sourceConversationId];
    if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      args.push(...options.statuses);
    }
    const boundedLimit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = this.db
      .prepare(`
        SELECT * FROM neo_work_cards
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(...args, boundedLimit) as SQLiteRow[];
    return rows.map(rowToWorkCard);
  }

  updateDraft(input: UpdateNeoWorkCardDraftRowInput): boolean {
    const result = this.db.prepare(`
      UPDATE neo_work_cards
         SET title = COALESCE(?, title),
             status = ?,
             current_revision_id = ?,
             approved_revision_id = ?,
             updated_at = ?,
             archived_at = NULL
       WHERE id = ?
    `).run(
      input.title ?? null,
      input.status,
      input.currentRevisionId,
      input.approvedRevisionId,
      input.updatedAt,
      input.workCardId,
    );
    return result.changes > 0;
  }

  appendRevision(revision: NeoWorkCardRevision): void {
    this.insertRevisionRow(revision);
  }

  appendRevisionAndUpdateCard(
    revision: NeoWorkCardRevision,
    options: AppendNeoWorkCardRevisionOptions,
  ): void {
    const tx = this.db.transaction(() => {
      this.insertRevisionRow(revision);
      if (options.clearApprovedRevision) {
        this.revokeApprovedApprovalsForWorkCard(
          revision.workCardId,
          options.updatedAt,
          revision.id,
          options.revokeApprovedApprovalsFeedback ?? null,
        );
      }
      this.db.prepare(`
        UPDATE neo_work_cards
           SET title = COALESCE(?, title),
               status = ?,
               current_revision_id = ?,
               approved_revision_id = CASE WHEN ? THEN NULL ELSE approved_revision_id END,
               updated_at = ?,
               archived_at = NULL
         WHERE id = ?
      `).run(
        options.title ?? null,
        options.status,
        revision.id,
        options.clearApprovedRevision ? 1 : 0,
        options.updatedAt,
        revision.workCardId,
      );
    });
    tx();
  }

  getRevision(revisionId: string): NeoWorkCardRevision | null {
    const row = this.db.prepare('SELECT * FROM neo_work_card_revisions WHERE id = ?').get(revisionId) as SQLiteRow | undefined;
    return row ? rowToRevision(row) : null;
  }

  listRevisions(workCardId: string): NeoWorkCardRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM neo_work_card_revisions WHERE work_card_id = ? ORDER BY revision_number ASC')
      .all(workCardId) as SQLiteRow[];
    return rows.map(rowToRevision);
  }

  getLatestRevisionNumber(workCardId: string): number {
    const row = this.db
      .prepare('SELECT MAX(revision_number) AS max_revision FROM neo_work_card_revisions WHERE work_card_id = ?')
      .get(workCardId) as { max_revision?: number | null } | undefined;
    return Number(row?.max_revision) || 0;
  }

  createApproval(approval: NeoWorkCardApproval): void {
    this.insertApprovalRow(approval);
  }

  setApprovedRevision(workCardId: string, revisionId: string, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE neo_work_cards
         SET approved_revision_id = ?,
             status = 'approved',
             updated_at = ?
       WHERE id = ?
    `).run(revisionId, updatedAt, workCardId);
    return result.changes > 0;
  }

  clearApprovedRevision(workCardId: string, status: NeoWorkCardStatus, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE neo_work_cards
         SET approved_revision_id = NULL,
             status = ?,
             updated_at = ?
       WHERE id = ?
    `).run(status, updatedAt, workCardId);
    return result.changes > 0;
  }

  setWorkCardStatus(workCardId: string, status: NeoWorkCardStatus, updatedAt: number): boolean {
    const result = this.db
      .prepare('UPDATE neo_work_cards SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, workCardId);
    return result.changes > 0;
  }

  setStatus(input: SetNeoWorkCardStatusInput): boolean {
    const result = this.db.prepare(`
      UPDATE neo_work_cards
         SET status = ?,
             approved_revision_id = CASE WHEN ? IN ('cancelled', 'archived') THEN NULL ELSE approved_revision_id END,
             updated_at = ?,
             archived_at = ?
       WHERE id = ?
    `).run(
      input.status,
      input.status,
      input.updatedAt,
      input.status === 'archived' ? input.archivedAt ?? input.updatedAt : null,
      input.workCardId,
    );
    return result.changes > 0;
  }

  archiveWorkCard(workCardId: string, archivedAt: number): boolean {
    return this.setStatus({
      workCardId,
      status: 'archived',
      updatedAt: archivedAt,
      archivedAt,
    });
  }

  revokeApprovedApprovalsForWorkCard(
    workCardId: string,
    revokedAt: number,
    supersededByRevisionId: string | null,
    feedback: string | null,
  ): number {
    const result = this.db.prepare(`
      UPDATE neo_work_card_approvals
         SET decision = 'revoked',
             revoked_at = ?,
             superseded_by_revision_id = ?,
             feedback = COALESCE(?, feedback)
       WHERE work_card_id = ?
         AND decision = 'approved'
    `).run(revokedAt, supersededByRevisionId, feedback, workCardId);
    return result.changes;
  }

  listApprovals(workCardId: string): NeoWorkCardApproval[] {
    const rows = this.db
      .prepare('SELECT * FROM neo_work_card_approvals WHERE work_card_id = ? ORDER BY created_at ASC')
      .all(workCardId) as SQLiteRow[];
    return rows.map(rowToApproval);
  }

  appendDelta(delta: NeoWorkCardDelta): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO neo_work_card_deltas (
          id, work_card_id, run_id, conversation_id, completed_json, changed_files_json, decisions_json,
          open_questions_json, risks_json, memory_candidates_json, next_step, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delta.id,
        delta.workCardId,
        delta.runId,
        delta.conversationId ?? null,
        serialize(delta.completed),
        serialize(delta.changedFiles),
        serialize(delta.decisions),
        serialize(delta.openQuestions),
        serialize(delta.risks),
        serialize(delta.memoryCandidates),
        delta.nextStep ?? null,
        delta.createdAt,
      );
      this.db
        .prepare('UPDATE neo_work_cards SET updated_at = ? WHERE id = ?')
        .run(delta.createdAt, delta.workCardId);
    });
    tx();
  }

  appendResultReview(review: NeoWorkCardResultReview): void {
    this.db.prepare(`
      INSERT INTO neo_work_card_result_reviews (
        id, work_card_id, project_id, actor_user_id, decision, feedback, open_questions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.id,
      review.workCardId,
      review.projectId,
      review.actorUserId,
      review.decision,
      review.feedback ?? null,
      serialize(review.openQuestions),
      review.createdAt,
    );
  }

  insertMemoryCandidate(candidate: NeoMemoryCandidate): void {
    this.insertMemoryCandidateRow(candidate);
  }

  insertMemoryCandidates(candidates: NeoMemoryCandidate[]): void {
    if (candidates.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const candidate of candidates) {
        if (!this.hasMemoryCandidate(candidate.workCardId, candidate.source, candidate.text)) {
          this.insertMemoryCandidateRow(candidate);
        }
      }
    });
    tx();
  }

  listDeltas(workCardId: string, limit = 50): NeoWorkCardDelta[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare('SELECT * FROM neo_work_card_deltas WHERE work_card_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(workCardId, boundedLimit) as SQLiteRow[];
    return rows.map(rowToDelta);
  }

  listResultReviews(workCardId: string, limit = 50): NeoWorkCardResultReview[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare('SELECT * FROM neo_work_card_result_reviews WHERE work_card_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(workCardId, boundedLimit) as SQLiteRow[];
    return rows.map(rowToResultReview);
  }

  listMemoryCandidates(workCardId: string, limit = 100): NeoMemoryCandidate[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db
      .prepare('SELECT * FROM neo_memory_candidates WHERE work_card_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(workCardId, boundedLimit) as SQLiteRow[];
    return rows.map(rowToMemoryCandidate);
  }

  getMemoryCandidate(candidateId: string): NeoMemoryCandidate | null {
    const row = this.db.prepare('SELECT * FROM neo_memory_candidates WHERE id = ?').get(candidateId) as
      | SQLiteRow
      | undefined;
    return row ? rowToMemoryCandidate(row) : null;
  }

  rejectMemoryCandidate(candidateId: string, actorUserId: string, reason: string | null, decidedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE neo_memory_candidates
         SET status = 'rejected',
             decided_by_user_id = ?,
             decided_at = ?,
             rejection_reason = ?
       WHERE id = ?
         AND status = 'pending'
    `).run(actorUserId, decidedAt, reason, candidateId);
    return result.changes > 0;
  }

  writeMemoryCandidate(candidateId: string, actorUserId: string, writtenAt: number): NeoMemoryCandidate | null {
    const candidate = this.getMemoryCandidate(candidateId);
    if (candidate?.status !== 'pending') return null;
    const projectPath = this.getProjectWorkspacePath(candidate.projectId) ?? candidate.projectId;
    const memoryKey = `neo.${candidate.workCardId}.${candidate.id}`;
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_knowledge (id, project_path, key, value, source, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'explicit', 1, ?, ?)
        ON CONFLICT(project_path, key) DO UPDATE SET
          value = excluded.value,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `).run(
        `pk_${candidate.id}`,
        projectPath,
        memoryKey,
        serialize({
          text: candidate.text,
          kind: candidate.kind,
          source: candidate.source,
          workCardId: candidate.workCardId,
          candidateId: candidate.id,
        }),
        writtenAt,
        writtenAt,
      );
      this.db.prepare(`
        UPDATE neo_memory_candidates
           SET status = 'written',
               decided_by_user_id = ?,
               decided_at = ?,
               written_at = ?,
               written_memory_key = ?
         WHERE id = ?
      `).run(actorUserId, writtenAt, writtenAt, memoryKey, candidate.id);
    });
    tx();
    return this.getMemoryCandidate(candidate.id);
  }

  clearAll(): void {
    this.db.exec('DELETE FROM neo_memory_candidates');
    this.db.exec('DELETE FROM neo_work_card_result_reviews');
    this.db.exec('DELETE FROM neo_work_card_deltas');
    this.db.exec('DELETE FROM neo_work_card_approvals');
    this.db.exec('DELETE FROM neo_work_card_revisions');
    this.db.exec('DELETE FROM neo_work_cards');
  }

  private insertWorkCardRow(card: NeoWorkCard): void {
    this.db.prepare(`
      INSERT INTO neo_work_cards (
        id, project_id, source_conversation_id, source_turn_id, requester_user_id,
        title, status, current_revision_id, approved_revision_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.id,
      card.projectId,
      card.sourceConversationId,
      card.sourceTurnId,
      card.requesterUserId,
      card.title,
      card.status,
      card.currentRevisionId,
      card.approvedRevisionId ?? null,
      card.createdAt,
      card.updatedAt,
      card.archivedAt ?? null,
    );
  }

  private insertRevisionRow(revision: NeoWorkCardRevision): void {
    this.db.prepare(`
      INSERT INTO neo_work_card_revisions (
        id, work_card_id, revision_number, intent, task_summary,
        read_scope_json, write_scope_json, model_intent_json, memory_plan_json,
        expected_outputs_json, risks_json, assumptions_json, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.id,
      revision.workCardId,
      revision.revisionNumber,
      revision.intent,
      revision.taskSummary,
      serialize(revision.readScope),
      serialize(revision.writeScope),
      serialize(revision.modelIntent),
      serialize(revision.memoryPlan),
      serialize(revision.expectedOutputs),
      serialize(revision.risks),
      serialize(revision.assumptions),
      revision.createdByUserId,
      revision.createdAt,
    );
  }

  private insertApprovalRow(approval: NeoWorkCardApproval): void {
    this.db.prepare(`
      INSERT INTO neo_work_card_approvals (
        id, work_card_id, revision_id, project_id, requester_user_id, approved_by_user_id,
        decision, approved_read_scope_json, approved_write_scope_json, approved_model_intent_json,
        approved_memory_plan_json, feedback, expires_at, created_at, revoked_at, superseded_by_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.id,
      approval.workCardId,
      approval.revisionId,
      approval.projectId,
      approval.requesterUserId,
      approval.approvedByUserId,
      approval.decision,
      serialize(approval.approvedReadScope),
      serialize(approval.approvedWriteScope),
      serialize(approval.approvedModelIntent),
      serialize(approval.approvedMemoryPlan),
      approval.feedback ?? null,
      approval.expiresAt ?? null,
      approval.createdAt,
      approval.revokedAt ?? null,
      approval.supersededByRevisionId ?? null,
    );
  }

  private insertMemoryCandidateRow(candidate: NeoMemoryCandidate): void {
    this.db.prepare(`
      INSERT INTO neo_memory_candidates (
        id, work_card_id, project_id, revision_id, delta_id, kind, text, source, status,
        created_at, decided_by_user_id, decided_at, rejection_reason, written_at, written_memory_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id,
      candidate.workCardId,
      candidate.projectId,
      candidate.revisionId ?? null,
      candidate.deltaId ?? null,
      candidate.kind,
      candidate.text,
      candidate.source,
      candidate.status,
      candidate.createdAt,
      candidate.decidedByUserId ?? null,
      candidate.decidedAt ?? null,
      candidate.rejectionReason ?? null,
      candidate.writtenAt ?? null,
      candidate.writtenMemoryKey ?? null,
    );
  }

  private hasMemoryCandidate(workCardId: string, source: NeoMemoryCandidateSource, text: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM neo_memory_candidates
       WHERE work_card_id = ? AND source = ? AND text = ?
       LIMIT 1
    `).get(workCardId, source, text) as SQLiteRow | undefined;
    return Boolean(row);
  }

  private getProjectWorkspacePath(projectId: string): string | null {
    const row = this.db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as
      | { workspace_path?: string | null }
      | undefined;
    return row?.workspace_path ?? null;
  }
}

let cached: { db: BetterSqlite3.Database; repo: NeoWorkCardRepository } | null = null;

export function getNeoWorkCardRepository(): NeoWorkCardRepository | null {
  const dbService = getDatabase();
  if (!dbService.isReady) return null;
  const db = dbService.getDb();
  if (!db) return null;
  if (cached?.db !== db) {
    cached = { db, repo: new NeoWorkCardRepository(db) };
  }
  return cached.repo;
}
