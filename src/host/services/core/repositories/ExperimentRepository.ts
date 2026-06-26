// ============================================================================
// ExperimentRepository - 评测实验数据（experiments + experiment_cases 表）
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

export class ExperimentRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insertExperiment(experiment: {
    id: string;
    name: string;
    timestamp: number;
    model?: string;
    provider?: string;
    scope?: string;
    config_json?: string;
    summary_json: string;
    source?: string;
    git_commit?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO experiments (id, name, timestamp, model, provider, scope, config_json, summary_json, source, git_commit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      experiment.id,
      experiment.name,
      experiment.timestamp,
      experiment.model || null,
      experiment.provider || null,
      experiment.scope || 'full',
      experiment.config_json || null,
      experiment.summary_json,
      experiment.source || 'test-runner',
      experiment.git_commit || null,
    );
  }

  insertExperimentCases(experimentId: string, cases: Array<{
    id: string;
    case_id: string;
    session_id?: string;
    status: string;
    score: number;
    duration_ms?: number;
    data_json?: string;
  }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO experiment_cases (id, experiment_id, case_id, session_id, status, score, duration_ms, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items: typeof cases) => {
      for (const c of items) {
        stmt.run(c.id, experimentId, c.case_id, c.session_id || null, c.status, c.score, c.duration_ms || null, c.data_json || null);
      }
    });

    insertMany(cases);
  }

  listExperiments(limit: number = 50): Array<{
    id: string;
    name: string;
    timestamp: number;
    model: string | null;
    provider: string | null;
    scope: string;
    config_json: string | null;
    summary_json: string;
    source: string;
    git_commit: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM experiments ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as SQLiteRow[];

    return rows.map(row => ({
      id: row.id as string,
      name: row.name as string,
      timestamp: row.timestamp as number,
      model: row.model as string | null,
      provider: row.provider as string | null,
      scope: (row.scope as string) || 'full',
      config_json: row.config_json as string | null,
      summary_json: row.summary_json as string,
      source: (row.source as string) || 'test-runner',
      git_commit: (row.git_commit as string) || null,
    }));
  }

  loadExperiment(id: string): {
    experiment: {
      id: string;
      name: string;
      timestamp: number;
      model: string | null;
      provider: string | null;
      scope: string;
      config_json: string | null;
      summary_json: string;
      source: string;
      git_commit: string | null;
    };
    cases: Array<{
      id: string;
      experiment_id: string;
      case_id: string;
      session_id: string | null;
      status: string;
      score: number;
      duration_ms: number | null;
      data_json: string | null;
    }>;
  } | undefined {
    const expRow = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as SQLiteRow | undefined;
    if (!expRow) return undefined;

    const caseRows = this.db.prepare(
      'SELECT * FROM experiment_cases WHERE experiment_id = ?'
    ).all(id) as SQLiteRow[];

    return {
      experiment: {
        id: expRow.id as string,
        name: expRow.name as string,
        timestamp: expRow.timestamp as number,
        model: expRow.model as string | null,
        provider: expRow.provider as string | null,
        scope: (expRow.scope as string) || 'full',
        config_json: expRow.config_json as string | null,
        summary_json: expRow.summary_json as string,
        source: (expRow.source as string) || 'test-runner',
        git_commit: (expRow.git_commit as string) || null,
      },
      cases: caseRows.map(row => ({
        id: row.id as string,
        experiment_id: row.experiment_id as string,
        case_id: row.case_id as string,
        session_id: (row.session_id as string) || null,
        status: row.status as string,
        score: row.score as number,
        duration_ms: row.duration_ms as number | null,
        data_json: row.data_json as string | null,
      })),
    };
  }

  updateExperimentSummary(id: string, summaryJson: string): void {
    this.db.prepare('UPDATE experiments SET summary_json = ? WHERE id = ?').run(summaryJson, id);
  }

  deleteExperiment(id: string): boolean {
    this.db.prepare('DELETE FROM experiment_cases WHERE experiment_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
