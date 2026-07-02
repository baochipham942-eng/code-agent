import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { NeoWorkCardRepository } from '../../../src/host/services/core/repositories/NeoWorkCardRepository';
import { NeoWorkCardService } from '../../../src/host/services/project/neoWorkCardService';
import type {
  CreateNeoWorkCardDraftInput,
  NeoWorkCardRevisionDraftInput,
} from '../../../src/shared/contract/tag';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

const NOW = 1_800_000_000_000;

function seedProject(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO projects (
      id, name, workspace_path, workspace_key, status, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)
  `).run(id, id, `/work/${id}`, `key_${id}`, NOW, NOW);
}

function revision(overrides: Partial<NeoWorkCardRevisionDraftInput> = {}): NeoWorkCardRevisionDraftInput {
  return {
    intent: 'implement',
    taskSummary: 'Implement the backend contract',
    readScope: {
      mode: 'current_project',
      fileGlobs: ['src/shared/contract/tag.ts'],
      messageIds: ['msg_1'],
    },
    writeScope: {
      mode: 'current_project',
      allowedPaths: ['src/host/services/project/neoWorkCardService.ts'],
      canCreateFiles: true,
      canModifyFiles: true,
      canWriteProjectMemory: false,
    },
    modelIntent: { mode: 'adaptive_auto', taskStrategy: 'main' },
    memoryPlan: { mode: 'none', entries: [], notes: [] },
    expectedOutputs: [{ kind: 'patch', title: 'Backend contract' }],
    risks: ['schema migration'],
    assumptions: ['P0 local runtime only'],
    ...overrides,
  };
}

function draft(projectId = 'proj_alpha'): CreateNeoWorkCardDraftInput {
  return {
    projectId,
    sourceConversationId: 'conv_1',
    sourceTurnId: 'turn_1',
    requesterUserId: 'user_requester',
    title: 'Neo Tag P0 backend',
    selectedMessageIds: ['msg_selected'],
    selectedArtifactIds: ['artifact_selected'],
    revision: revision(),
  };
}

function projectKnowledgeCount(db: BetterSqlite3.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM project_knowledge').get() as { count: number };
  return row.count;
}

describe('NeoWorkCardService', () => {
  let db: BetterSqlite3.Database;
  let repo: NeoWorkCardRepository;
  let service: NeoWorkCardService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    seedProject(db, 'proj_alpha');
    seedProject(db, 'proj_beta');
    repo = new NeoWorkCardRepository(db);
    service = new NeoWorkCardService(() => repo);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and reads a draft work card with its current revision', () => {
    const created = service.createDraft(draft(), NOW);

    const detail = service.get(created.workCard.id)!;

    expect(created.workCard.status).toBe('draft');
    expect(created.revision.revisionNumber).toBe(1);
    expect(detail.workCard.currentRevisionId).toBe(created.revision.id);
    expect(detail.currentRevision?.taskSummary).toBe('Implement the backend contract');
    expect(detail.currentRevision?.readScope.fileGlobs).toEqual(['src/shared/contract/tag.ts']);
    expect(detail.approvedRevision).toBeNull();
  });

  it('lists work cards by project and status scope', () => {
    const alpha = service.createDraft(draft('proj_alpha'), NOW);
    const beta = service.createDraft(draft('proj_beta'), NOW + 1);
    service.approveRevision({
      workCardId: alpha.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 2);

    expect(service.listByProject('proj_alpha').map((card) => card.id)).toEqual([alpha.workCard.id]);
    expect(service.listByProject('proj_beta').map((card) => card.id)).toEqual([beta.workCard.id]);
    expect(service.listByProject('proj_alpha', { statuses: ['approved'] }).map((card) => card.id)).toEqual([
      alpha.workCard.id,
    ]);
    expect(service.listByProject('proj_alpha', { statuses: ['draft'] })).toEqual([]);
  });

  it('lists all work cards across projects for the global topic directory (listAll, BUG2)', () => {
    const alpha = service.createDraft(draft('proj_alpha'), NOW);
    const beta = service.createDraft(draft('proj_beta'), NOW + 1);

    // 全局目录：不按 projectId 过滤，最近活动在前
    expect(service.listAll().map((card) => card.id)).toEqual([beta.workCard.id, alpha.workCard.id]);

    // 归档默认排除，includeArchived 才带上
    service.archive(beta.workCard.id, NOW + 2);
    expect(service.listAll().map((card) => card.id)).toEqual([alpha.workCard.id]);
    expect(service.listAll({ includeArchived: true }).map((card) => card.id)).toEqual([
      beta.workCard.id,
      alpha.workCard.id,
    ]);
  });

  it('lists work card details by source conversation', () => {
    const first = service.createDraft(draft('proj_alpha'), NOW);
    const second = service.createDraft({
      ...draft('proj_alpha'),
      sourceConversationId: 'conv_1',
      sourceTurnId: 'turn_2',
      title: 'Second Neo work card',
    }, NOW + 1);
    service.createDraft({
      ...draft('proj_alpha'),
      sourceConversationId: 'conv_2',
      sourceTurnId: 'turn_3',
      title: 'Other conversation',
    }, NOW + 2);

    expect(service.listBySourceConversation('conv_1').map((detail) => detail.workCard.id)).toEqual([
      second.workCard.id,
      first.workCard.id,
    ]);
  });

  it('approves the current revision and records an approval scope snapshot', () => {
    const created = service.createDraft(draft(), NOW);

    const approval = service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
      feedback: 'go',
    }, NOW + 1);

    const detail = service.get(created.workCard.id)!;
    expect(approval.decision).toBe('approved');
    expect(detail.workCard.status).toBe('approved');
    expect(detail.workCard.approvedRevisionId).toBe(created.revision.id);
    expect(detail.approvedRevision?.id).toBe(created.revision.id);
    expect(detail.approvals[0].approvedModelIntent).toEqual({ mode: 'adaptive_auto', taskStrategy: 'main' });
  });

  it('creates a new revision and revokes stale approval when draft fields change', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    const updated = service.updateDraftRevision({
      workCardId: created.workCard.id,
      title: 'Neo Tag P0 backend revised',
      updatedByUserId: 'user_editor',
      revision: revision({ taskSummary: 'Implement backend contract with approval invalidation' }),
    }, NOW + 2);

    const detail = service.get(created.workCard.id)!;
    expect(updated.revision.revisionNumber).toBe(2);
    expect(detail.workCard.title).toBe('Neo Tag P0 backend revised');
    expect(detail.workCard.status).toBe('draft');
    expect(detail.workCard.currentRevisionId).toBe(updated.revision.id);
    expect(detail.workCard.approvedRevisionId).toBeNull();
    expect(detail.revisions).toHaveLength(2);
    expect(detail.approvals[0]).toMatchObject({
      revisionId: created.revision.id,
      decision: 'revoked',
      revokedAt: NOW + 2,
      supersededByRevisionId: updated.revision.id,
    });
  });

  it('rejects the current revision and clears any approved revision', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    const rejection = service.rejectRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_reviewer',
      feedback: 'narrow the scope',
    }, NOW + 2);

    const detail = service.get(created.workCard.id)!;
    expect(rejection.decision).toBe('rejected');
    expect(detail.workCard.status).toBe('needs_review');
    expect(detail.workCard.approvedRevisionId).toBeNull();
    expect(detail.approvals.map((approval) => approval.decision)).toEqual(['revoked', 'rejected']);
  });

  it('cancels an approved work card and prevents more deltas', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    const cancelled = service.cancel({
      workCardId: created.workCard.id,
      actorUserId: 'user_requester',
      feedback: 'stop',
    }, NOW + 2)!;

    const detail = service.get(created.workCard.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.approvedRevisionId).toBeNull();
    expect(detail.approvals[0]).toMatchObject({ decision: 'revoked', revokedAt: NOW + 2 });
    expect(() => service.appendDelta({ workCardId: created.workCard.id, runId: 'run_1' }, NOW + 3)).toThrow(
      'work card is closed',
    );
  });

  it('archives without hard deleting the work card history', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    const archived = service.archive(created.workCard.id, NOW + 2)!;

    expect(archived.status).toBe('archived');
    expect(service.listByProject('proj_alpha')).toEqual([]);
    expect(service.listByProject('proj_alpha', { includeArchived: true }).map((card) => card.id)).toEqual([
      created.workCard.id,
    ]);
    const detail = service.get(created.workCard.id)!;
    expect(detail.workCard.archivedAt).toBe(NOW + 2);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.approvals).toHaveLength(1);
  });

  it('appends deltas without replacing revisions', () => {
    const created = service.createDraft(draft(), NOW);

    const delta = service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_1',
      completed: ['contract'],
      changedFiles: ['src/shared/contract/tag.ts'],
      decisions: ['work card is first-class'],
      nextStep: 'wire IPC',
    }, NOW + 1);

    const detail = service.get(created.workCard.id)!;
    expect(delta.workCardId).toBe(created.workCard.id);
    expect(detail.workCard.updatedAt).toBe(NOW + 1);
    expect(detail.deltas).toHaveLength(1);
    expect(detail.deltas[0].completed).toEqual(['contract']);
    expect(detail.revisions).toHaveLength(1);
  });

  it('moves completed work into result review and only completes after accepting result', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_result',
      completed: ['implemented result review flow'],
      changedFiles: ['src/host/services/project/neoWorkCardService.ts'],
      risks: ['manual runtime not wired in P0'],
    }, NOW + 2);

    expect(service.get(created.workCard.id)?.workCard.status).toBe('in_result_review');

    const accepted = service.acceptResult({
      workCardId: created.workCard.id,
      actorUserId: 'user_reviewer',
      feedback: 'looks good',
    }, NOW + 3);

    expect(accepted.workCard.status).toBe('completed');
    expect(accepted.resultReviews).toHaveLength(1);
    expect(accepted.resultReviews[0]).toMatchObject({
      decision: 'accepted',
      feedback: 'looks good',
    });
  });

  it('records result review feedback and returns the card to working when changes are requested', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);
    service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_result',
      completed: ['first pass'],
      openQuestions: ['should memory diff mention source?'],
    }, NOW + 2);

    const changed = service.requestChanges({
      workCardId: created.workCard.id,
      actorUserId: 'user_reviewer',
      feedback: 'tighten the memory diff',
      openQuestions: ['show pending vs written'],
    }, NOW + 3);

    expect(changed.workCard.status).toBe('working');
    expect(changed.resultReviews[0]).toMatchObject({
      decision: 'changes_requested',
      feedback: 'tighten the memory diff',
      openQuestions: ['show pending vs written'],
    });
    expect(changed.deltas.at(-1)?.openQuestions).toEqual(['show pending vs written']);
  });

  it('creates explicit memory candidates but does not write project memory before user approval', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);
    service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_result',
      memoryCandidates: ['Result review says result cards require explicit acceptance before completion'],
    }, NOW + 2);

    const detail = service.get(created.workCard.id)!;

    expect(detail.memoryCandidates).toHaveLength(1);
    expect(detail.memoryCandidates[0]).toMatchObject({
      source: 'result_review',
      status: 'pending',
    });
    expect(projectKnowledgeCount(db)).toBe(0);
  });

  it('writes explicit memory plan candidates only after the user approves the memory diff', () => {
    const created = service.createDraft({
      ...draft(),
      revision: revision({
        writeScope: {
          mode: 'current_project',
          allowedPaths: [],
          canCreateFiles: false,
          canModifyFiles: false,
          canWriteProjectMemory: true,
        },
        memoryPlan: {
          mode: 'explicit_only',
          entries: [{
            kind: 'workflow_convention',
            text: 'Neo Tag P0 memory candidates require explicit user confirmation before writing project memory.',
            sourceMessageIds: ['msg_1'],
          }],
          notes: ['candidate only'],
        },
      }),
    }, NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_approver',
    }, NOW + 1);

    const pending = service.get(created.workCard.id)!.memoryCandidates[0];
    expect(pending).toMatchObject({
      source: 'explicit_memory_plan',
      status: 'pending',
    });
    expect(projectKnowledgeCount(db)).toBe(0);

    const written = service.approveMemoryCandidate({
      candidateId: pending.id,
      actorUserId: 'user_reviewer',
    }, NOW + 2);

    expect(written.status).toBe('written');
    expect(projectKnowledgeCount(db)).toBe(1);
    expect(service.get(created.workCard.id)!.memoryCandidates[0]).toMatchObject({
      status: 'written',
      writtenMemoryKey: `neo.${created.workCard.id}.${pending.id}`,
    });
  });
});
