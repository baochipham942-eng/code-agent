import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { ExperimentRepository } from '../../../src/host/services/core/repositories/ExperimentRepository';

describe('ExperimentRepository', () => {
  let db: BetterSqlite3.Database;
  let repository: ExperimentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT,
        provider TEXT,
        scope TEXT,
        config_json TEXT,
        summary_json TEXT NOT NULL,
        source TEXT,
        git_commit TEXT
      );
      CREATE TABLE experiment_cases (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        score INTEGER NOT NULL,
        duration_ms INTEGER,
        data_json TEXT,
        FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
      );
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        overall TEXT,
        note TEXT,
        dims_json TEXT NOT NULL,
        consent_scope TEXT NOT NULL,
        calibration_split TEXT,
        supersedes_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
      );
    `);
    repository = new ExperimentRepository(db);
  });

  afterEach(() => db.close());

  it('重存同一 experiment 时保留 cases 和人工 annotations', () => {
    repository.insertExperiment({
      id: 'experiment-1',
      name: 'Original experiment',
      timestamp: 100,
      summary_json: '{"score":0}',
    });
    repository.insertExperimentCases('experiment-1', [{
      id: 'result-1',
      case_id: 'case-1',
      status: 'completed',
      score: 1,
    }]);
    db.prepare(`
      INSERT INTO annotations (
        id, experiment_id, case_id, reviewer_id, overall,
        note, dims_json, consent_scope, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'annotation-1',
      'experiment-1',
      'case-1',
      'reviewer-1',
      'up',
      '人工复核通过',
      '{}',
      'metadata',
      150,
    );

    repository.insertExperiment({
      id: 'experiment-1',
      name: 'Updated experiment',
      timestamp: 200,
      summary_json: '{"score":1}',
    });

    expect(repository.loadExperiment('experiment-1')).toMatchObject({
      experiment: {
        name: 'Updated experiment',
        timestamp: 200,
        summary_json: '{"score":1}',
      },
      cases: [{ id: 'result-1', case_id: 'case-1' }],
    });
    expect(db.prepare(
      'SELECT id, note FROM annotations WHERE experiment_id = ?',
    ).all('experiment-1')).toEqual([{
      id: 'annotation-1',
      note: '人工复核通过',
    }]);
  });
});
