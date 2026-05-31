import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { ArtifactIssueRepository } from '../../../src/main/services/core/repositories/ArtifactIssueRepository';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';
import type { ArtifactIssue, EvalReplayQualityReport } from '../../../src/shared/contract/productClosure';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE artifact_issues (
      issue_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      trace_source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replay_key TEXT NOT NULL,
      source TEXT NOT NULL,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      run_id TEXT,
      case_id TEXT,
      owner TEXT,
      repair_instruction TEXT,
      anchors_json TEXT NOT NULL DEFAULT '[]',
      decision_trace_json TEXT,
      related_issue_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE artifact_issue_evidence (
      issue_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_source TEXT,
      sensitivity TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issue_id, evidence_id),
      FOREIGN KEY (issue_id) REFERENCES artifact_issues(issue_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE eval_replay_quality_reports (
      report_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      trace_source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replay_key TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      case_id TEXT,
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);
}

describe('ArtifactIssueRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: ArtifactIssueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repo = new ArtifactIssueRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('upserts artifact issues with evidence and trace identity', () => {
    const issue = makeIssue();
    repo.upsertIssue(issue);

    const loaded = repo.getIssue(issue.issueId);
    expect(loaded).toMatchObject({
      issueId: 'issue-1',
      artifactId: 'artifact-1',
      traceIdentity: {
        traceId: 'session:session-1',
        replayKey: 'session-1',
      },
      status: 'open',
      owner: 'release',
      evidenceRefs: [
        {
          evidenceId: 'evidence-1',
          kind: 'console_error',
          ref: 'telemetry:turn-1',
          sensitivity: 'metadata_only',
        },
      ],
    });
  });

  it('replaces evidence on issue upsert and lists by status', () => {
    const issue = makeIssue();
    repo.upsertIssue(issue);
    repo.upsertIssue({
      ...issue,
      status: 'fixed',
      updatedAt: 200,
      evidenceRefs: [{
        evidenceId: 'evidence-2',
        kind: 'verifier_check',
        ref: 'verifier:dashboard',
        summary: 'Verifier passed after repair.',
        sensitivity: 'public',
        createdAt: 200,
      }],
    });

    expect(repo.listIssues({ status: 'open' })).toEqual([]);
    expect(repo.listIssues({ status: 'fixed' })).toHaveLength(1);
    expect(repo.getIssue('issue-1')?.evidenceRefs).toHaveLength(1);
    expect(repo.getIssue('issue-1')?.evidenceRefs[0].evidenceId).toBe('evidence-2');
  });

  it('stores eval replay quality reports for trace lookup', () => {
    const traceIdentity = buildSessionTraceIdentity('session-1');
    const report: EvalReplayQualityReport = {
      reportId: 'report-1',
      traceIdentity,
      status: 'failed',
      gates: [{
        gateId: 'replay-completeness',
        name: 'Replay completeness',
        status: 'failed',
        summary: 'Missing tool calls.',
        failures: ['missing_tool_calls'],
      }],
      createdAt: 100,
      runId: 'run-1',
    };

    repo.upsertQualityReport(report);

    expect(repo.getQualityReport('report-1')).toEqual(report);
    expect(repo.listQualityReports(traceIdentity.traceId)).toEqual([report]);
  });
});

function makeIssue(): ArtifactIssue {
  return {
    issueId: 'issue-1',
    artifactId: 'artifact-1',
    artifactKind: 'dashboard',
    traceIdentity: buildSessionTraceIdentity('session-1'),
    source: 'artifact_verifier',
    code: 'console_error',
    severity: 'high',
    status: 'open',
    title: 'Dashboard console error',
    message: 'Generated dashboard logs an uncaught error.',
    createdAt: 100,
    updatedAt: 100,
    runId: 'run-1',
    owner: 'release',
    repairInstruction: 'Fix the chart render path.',
    evidenceRefs: [{
      evidenceId: 'evidence-1',
      kind: 'console_error',
      ref: 'telemetry:turn-1',
      summary: 'Uncaught TypeError.',
      sensitivity: 'metadata_only',
      createdAt: 100,
    }],
  };
}
