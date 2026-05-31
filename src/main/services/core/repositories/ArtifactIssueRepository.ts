import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../index';
import type {
  ArtifactEvidenceRef,
  ArtifactIssue,
  ArtifactIssueStatus,
  EvalReplayQualityReport,
} from '../../../../shared/contract/productClosure';
import type { UnifiedTraceIdentity } from '../../../../shared/contract/reviewQueue';

type SQLiteRow = Record<string, unknown>;

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
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

function mapTraceIdentity(row: SQLiteRow): UnifiedTraceIdentity {
  const traceSource = row.trace_source as UnifiedTraceIdentity['traceSource'];
  return {
    traceId: row.trace_id as string,
    traceSource,
    source: traceSource,
    sessionId: row.session_id as string,
    replayKey: row.replay_key as string,
  };
}

export interface ArtifactIssueListFilter {
  status?: ArtifactIssueStatus;
  sessionId?: string;
  traceId?: string;
  artifactId?: string;
  limit?: number;
}

export class ArtifactIssueRepository {
  constructor(private db: BetterSqlite3.Database) {}

  upsertIssue(issue: ArtifactIssue): void {
    const tx = this.db.transaction((nextIssue: ArtifactIssue) => {
      this.db
        .prepare(`
          INSERT OR REPLACE INTO artifact_issues (
            issue_id, artifact_id, artifact_kind,
            trace_id, trace_source, session_id, replay_key,
            source, code, severity, status, title, message,
            run_id, case_id, owner, repair_instruction,
            anchors_json, decision_trace_json, related_issue_ids_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          nextIssue.issueId,
          nextIssue.artifactId,
          nextIssue.artifactKind,
          nextIssue.traceIdentity.traceId,
          nextIssue.traceIdentity.traceSource,
          nextIssue.traceIdentity.sessionId,
          nextIssue.traceIdentity.replayKey,
          nextIssue.source,
          nextIssue.code,
          nextIssue.severity,
          nextIssue.status,
          nextIssue.title,
          nextIssue.message,
          nextIssue.runId ?? null,
          nextIssue.caseId ?? null,
          nextIssue.owner ?? null,
          nextIssue.repairInstruction ?? null,
          serialize(nextIssue.anchors ?? []),
          nextIssue.decisionTrace ? serialize(nextIssue.decisionTrace) : null,
          serialize(nextIssue.relatedIssueIds ?? []),
          nextIssue.createdAt,
          nextIssue.updatedAt,
        );

      this.db.prepare('DELETE FROM artifact_issue_evidence WHERE issue_id = ?').run(nextIssue.issueId);
      const insertEvidence = this.db.prepare(`
        INSERT INTO artifact_issue_evidence (
          issue_id, evidence_id, kind, ref, summary, data_source, sensitivity, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const evidence of nextIssue.evidenceRefs) {
        insertEvidence.run(
          nextIssue.issueId,
          evidence.evidenceId,
          evidence.kind,
          evidence.ref,
          evidence.summary,
          evidence.dataSource ?? null,
          evidence.sensitivity,
          evidence.createdAt,
        );
      }
    });
    tx(issue);
  }

  getIssue(issueId: string): ArtifactIssue | null {
    const row = this.db.prepare('SELECT * FROM artifact_issues WHERE issue_id = ?').get(issueId) as SQLiteRow | undefined;
    return row ? this.mapIssueRow(row, this.getEvidence(issueId)) : null;
  }

  listIssues(filter: ArtifactIssueListFilter = {}): ArtifactIssue[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      args.push(filter.sessionId);
    }
    if (filter.traceId) {
      clauses.push('trace_id = ?');
      args.push(filter.traceId);
    }
    if (filter.artifactId) {
      clauses.push('artifact_id = ?');
      args.push(filter.artifactId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
    const rows = this.db
      .prepare(`SELECT * FROM artifact_issues ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, limit) as SQLiteRow[];
    return rows.map((row) => this.mapIssueRow(row, this.getEvidence(row.issue_id as string)));
  }

  updateIssueStatus(issueId: string, status: ArtifactIssueStatus, updatedAt: number): boolean {
    const result = this.db
      .prepare('UPDATE artifact_issues SET status = ?, updated_at = ? WHERE issue_id = ?')
      .run(status, updatedAt, issueId);
    return result.changes > 0;
  }

  upsertQualityReport(report: EvalReplayQualityReport): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO eval_replay_quality_reports (
          report_id, trace_id, trace_source, session_id, replay_key,
          status, run_id, case_id, report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        report.reportId,
        report.traceIdentity.traceId,
        report.traceIdentity.traceSource,
        report.traceIdentity.sessionId,
        report.traceIdentity.replayKey,
        report.status,
        report.runId ?? null,
        report.caseId ?? null,
        serialize(report),
        report.createdAt,
        report.updatedAt ?? null,
      );
  }

  getQualityReport(reportId: string): EvalReplayQualityReport | null {
    const row = this.db.prepare('SELECT report_json FROM eval_replay_quality_reports WHERE report_id = ?').get(reportId) as
      | { report_json?: string }
      | undefined;
    return row?.report_json ? deserialize<EvalReplayQualityReport | null>(row.report_json, null) : null;
  }

  listQualityReports(traceId: string, limit = 20): EvalReplayQualityReport[] {
    const rows = this.db
      .prepare('SELECT report_json FROM eval_replay_quality_reports WHERE trace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(traceId, Math.max(1, Math.min(limit, 100))) as Array<{ report_json?: string }>;
    return rows
      .map((row) => row.report_json ? deserialize<EvalReplayQualityReport | null>(row.report_json, null) : null)
      .filter((report): report is EvalReplayQualityReport => report !== null);
  }

  clearAll(): void {
    this.db.exec('DELETE FROM artifact_issue_evidence');
    this.db.exec('DELETE FROM artifact_issues');
    this.db.exec('DELETE FROM eval_replay_quality_reports');
  }

  private getEvidence(issueId: string): ArtifactEvidenceRef[] {
    const rows = this.db
      .prepare('SELECT * FROM artifact_issue_evidence WHERE issue_id = ? ORDER BY created_at ASC')
      .all(issueId) as SQLiteRow[];
    return rows.map((row) => ({
      evidenceId: row.evidence_id as string,
      kind: row.kind as ArtifactEvidenceRef['kind'],
      ref: row.ref as string,
      summary: row.summary as string,
      dataSource: (row.data_source as string | null) ?? undefined,
      sensitivity: row.sensitivity as ArtifactEvidenceRef['sensitivity'],
      createdAt: row.created_at as number,
    }));
  }

  private mapIssueRow(row: SQLiteRow, evidenceRefs: ArtifactEvidenceRef[]): ArtifactIssue {
    return {
      issueId: row.issue_id as string,
      artifactId: row.artifact_id as string,
      artifactKind: row.artifact_kind as string,
      traceIdentity: mapTraceIdentity(row),
      source: row.source as ArtifactIssue['source'],
      code: row.code as string,
      severity: row.severity as ArtifactIssue['severity'],
      status: row.status as ArtifactIssue['status'],
      title: row.title as string,
      message: row.message as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      runId: (row.run_id as string | null) ?? undefined,
      caseId: (row.case_id as string | null) ?? undefined,
      owner: (row.owner as string | null) ?? undefined,
      repairInstruction: (row.repair_instruction as string | null) ?? undefined,
      anchors: deserialize<ArtifactIssue['anchors']>(row.anchors_json, []),
      evidenceRefs,
      decisionTrace: deserialize<ArtifactIssue['decisionTrace']>(row.decision_trace_json, undefined),
      relatedIssueIds: deserialize<ArtifactIssue['relatedIssueIds']>(row.related_issue_ids_json, []),
    };
  }
}

let cached: { db: BetterSqlite3.Database; repo: ArtifactIssueRepository } | null = null;

export function getArtifactIssueRepository(): ArtifactIssueRepository | null {
  const dbService = getDatabase();
  if (!dbService.isReady) return null;
  const db = dbService.getDb();
  if (!db) return null;
  if (cached?.db !== db) {
    cached = { db, repo: new ArtifactIssueRepository(db) };
  }
  return cached.repo;
}
