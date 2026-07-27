import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { ExperimentAdapter } from '../../../src/host/evaluation/experimentAdapter';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import {
  ConversationBranchRepository,
  ExperimentRepository,
  SessionRepository,
} from '../../../src/host/services/core/repositories';
import type { TestRunSummary } from '../../../src/host/testing/types';

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createFixture() {
  const db = new Database(':memory:');
  applySchema(db, logger() as never);
  applySessionsMigrations(db, logger() as never);
  applyConversationBranchSchema(db);

  const sessions = new SessionRepository(db);
  const experiments = new ExperimentRepository(db);
  const branches = new ConversationBranchRepository(db);

  db.prepare(`
    INSERT INTO projects (id, name, status, created_at, updated_at)
    VALUES ('project-1', 'Project 1', 'active', 1, 1)
  `).run();
  sessions.createSession({
    id: 'session-1',
    userId: 'owner-1',
    title: 'Evaluated branch',
    modelConfig: { provider: 'anthropic', model: 'claude-test' },
    projectId: 'project-1',
    engine: {
      kind: 'claude_code',
      runId: 'provider-runtime-run-secret',
      externalSessionId: 'provider-external-session-secret',
    },
    createdAt: 1,
    updatedAt: 1,
  });
  sessions.addMessage('session-1', {
    id: 'u1',
    role: 'user',
    content: 'question',
    timestamp: 10,
  });
  sessions.addMessage('session-1', {
    id: 'a1',
    role: 'assistant',
    content: 'answer',
    timestamp: 20,
  });

  const writer = {
    insertExperiment: experiments.insertExperiment.bind(experiments),
    insertExperimentCases: experiments.insertExperimentCases.bind(experiments),
    getDb: () => db,
    getSession: sessions.getSession.bind(sessions),
    replayConversationBranch: (
      sessionId: string,
      boundary: { ownerUserId: string | null; projectId: string | null },
    ) => branches.replay(sessionId, boundary),
    recordConversationEvaluationAttribution: branches.recordEvaluationAttribution.bind(branches),
  };

  return { db, sessions, experiments, branches, writer };
}

function summary(score = 0.82): TestRunSummary {
  return {
    runId: 'canonical-eval-run-1',
    startTime: 100,
    endTime: 200,
    duration: 100,
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    partial: 0,
    averageScore: score,
    results: [{
      testId: 'case-1',
      description: 'case one',
      status: 'passed',
      duration: 100,
      startTime: 100,
      endTime: 200,
      toolExecutions: [],
      responses: ['answer'],
      errors: [],
      turnCount: 1,
      score,
      sessionId: 'session-1',
    }],
    environment: {
      model: 'claude-test',
      provider: 'anthropic',
      workingDirectory: '/tmp/project-1',
    },
    performance: {
      avgResponseTime: 100,
      maxResponseTime: 100,
      totalToolCalls: 0,
      totalTurns: 1,
    },
    gitCommit: 'abc123',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExperimentAdapter conversation evaluation attribution', () => {
  it('persists canonical case attribution against the exact immutable branch boundary', async () => {
    const fixture = createFixture();
    try {
      const adapter = new ExperimentAdapter(fixture.writer as never);

      await adapter.persistTestRun(summary());

      const attributions = fixture.branches.listEvaluationAttributions('session-1', {
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      });
      const replay = fixture.branches.replay('session-1', {
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      });

      expect(attributions).toEqual([
        expect.objectContaining({
          evaluationId: 'canonical-eval:canonical-eval-run-1:case-1',
          runId: 'canonical-eval-run-1',
          metric: 'canonical_score_100',
          value: 82,
          entryIds: replay.messages.map((message) => message.entryId),
          createdAt: 200,
        }),
      ]);
      expect(JSON.stringify(attributions)).not.toContain('provider-runtime-run-secret');
      expect(JSON.stringify(attributions)).not.toContain('provider-external-session-secret');

      await adapter.persistTestRun(summary());
      expect(fixture.branches.listEvaluationAttributions('session-1', {
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      })).toHaveLength(1);

      await expect(adapter.persistTestRun(summary(0.5))).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      const persisted = fixture.experiments.loadExperiment('canonical-eval-run-1');
      expect(persisted).toBeDefined();
      expect(JSON.parse(persisted!.experiment.summary_json)).toMatchObject({
        avgScore: 0.82,
        canonical: { averageScore100: 82 },
      });
      expect(fixture.branches.listEvaluationAttributions('session-1', {
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      })).toHaveLength(1);
    } finally {
      fixture.db.close();
    }
  });

  it('rolls back the experiment and append-only event when the projected session boundary is stale', async () => {
    const fixture = createFixture();
    try {
      const eventCountRow = (
        fixture.db.prepare('SELECT COUNT(*) AS count FROM conversation_branch_events').get()
      ) as { count: number };
      const eventCountBefore = Number(eventCountRow.count);
      const staleBoundaryWriter = {
        ...fixture.writer,
        getSession: () => ({
          ...fixture.sessions.getSession('session-1'),
          projectId: 'wrong-project',
        }),
      };
      const adapter = new ExperimentAdapter(staleBoundaryWriter as never);

      await expect(adapter.persistTestRun(summary())).rejects.toThrow(/PROJECT_MISMATCH/);

      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM experiments').get()).toEqual({
        count: 0,
      });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM experiment_cases').get()).toEqual({
        count: 0,
      });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM conversation_branch_events').get()).toEqual({
        count: eventCountBefore,
      });
    } finally {
      fixture.db.close();
    }
  });
});
