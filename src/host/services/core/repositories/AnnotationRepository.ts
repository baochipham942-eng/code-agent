// Failure notes are stored as data. Any future model consumer must sanitize them at that boundary.
import type BetterSqlite3 from 'better-sqlite3';

export interface AnnotationRow {
  id: string;
  experiment_id: string;
  case_id: string;
  reviewer_id: string;
  overall: 'up' | 'down' | null;
  note: string | null;
  dims_json: string;
  consent_scope: 'metadata' | 'turn_excerpt' | 'full_session';
  calibration_split: string | null;
  supersedes_id: string | null;
  created_at: number;
}

export class AnnotationRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insert(row: AnnotationRow): void {
    this.db.prepare(`
      INSERT INTO annotations (
        id, experiment_id, case_id, reviewer_id, overall, note, dims_json,
        consent_scope, calibration_split, supersedes_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.experiment_id,
      row.case_id,
      row.reviewer_id,
      row.overall,
      row.note,
      row.dims_json,
      row.consent_scope,
      row.calibration_split,
      row.supersedes_id,
      row.created_at,
    );
  }

  listForCase(experimentId: string, caseId: string): AnnotationRow[] {
    return this.db.prepare(`
      SELECT id, experiment_id, case_id, reviewer_id, overall, note, dims_json,
             consent_scope, calibration_split, supersedes_id, created_at
      FROM annotations
      WHERE experiment_id = ? AND case_id = ?
      ORDER BY created_at DESC
    `).all(experimentId, caseId) as AnnotationRow[];
  }
}
