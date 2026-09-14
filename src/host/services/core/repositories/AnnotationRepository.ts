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
      ORDER BY created_at DESC, rowid DESC
    `).all(experimentId, caseId) as AnnotationRow[];
  }

  /**
   * 一轮实验里的全部人工判定（N-EVAL-JUDGE-HUMANGOLD）。唯一消费方是
   * scripts/judge-calibration.ts --gold human_annotation。故意不在 SQL 里过滤 gold：
   * 表是 append-only，「取消进金标集」= 追加一条 calibration_split=null 的新行，
   * 只查 gold 行会把已撤销的旧金标当现行；金标成员资格由 calibration/humanGold.ts
   * 按每个 reviewer 的最新一条判（ai-review #1823 Important②）。
   */
  listForExperiment(experimentId: string): AnnotationRow[] {
    return this.db.prepare(`
      SELECT id, experiment_id, case_id, reviewer_id, overall, note, dims_json,
             consent_scope, calibration_split, supersedes_id, created_at
      FROM annotations
      WHERE experiment_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(experimentId) as AnnotationRow[];
  }
}
