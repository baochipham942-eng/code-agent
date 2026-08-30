import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import {
  AnnotationRepository,
  type AnnotationRow,
} from '../../../src/host/services/core/repositories/AnnotationRepository';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function seedCase(db: Database.Database): void {
  db.prepare(`
    INSERT INTO experiments (id, name, timestamp, summary_json)
    VALUES ('run-1', 'run', 1, '{}')
  `).run();
  db.prepare(`
    INSERT INTO experiment_cases (id, experiment_id, case_id, status, score)
    VALUES ('row-1', 'run-1', 'case-1', 'failed', 0)
  `).run();
}

function row(overrides: Partial<AnnotationRow> = {}): AnnotationRow {
  return {
    id: 'annotation-1',
    experiment_id: 'run-1',
    case_id: 'case-1',
    reviewer_id: 'reviewer-1',
    overall: 'down',
    note: 'missing evidence',
    dims_json: JSON.stringify({ task_completed: 'no' }),
    consent_scope: 'metadata',
    calibration_split: null,
    supersedes_id: null,
    created_at: 100,
    ...overrides,
  };
}

describe('AnnotationRepository', () => {
  it('T1 keeps every review as a new row and rejects replacement by id', () => {
    const db = new Database(':memory:');
    try {
      applySchema(db, logger as never);
      seedCase(db);
      const repository = new AnnotationRepository(db);
      repository.insert(row());
      expect(() => repository.insert(row({ note: 'replacement' }))).toThrow();
      repository.insert(row({
        id: 'annotation-2',
        supersedes_id: 'annotation-1',
        note: 'new review',
        created_at: 200,
      }));

      const annotations = repository.listForCase('run-1', 'case-1');
      expect(annotations).toHaveLength(2);
      expect(annotations[0]).toMatchObject({
        id: 'annotation-2',
        supersedes_id: 'annotation-1',
      });
    } finally {
      db.close();
    }
  });

  it('T8 upgrades a database without annotations without changing experiment cases', () => {
    const db = new Database(':memory:');
    try {
      applySchema(db, logger as never);
      seedCase(db);
      db.exec('DROP TABLE annotations');

      applySchema(db, logger as never);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((value) => (value as { name: string }).name);
      expect(tables).toContain('annotations');
      expect(db.prepare('SELECT COUNT(*) AS count FROM experiment_cases').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps production annotation SQL append-only', () => {
    const repositorySource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/host/services/core/repositories/AnnotationRepository.ts'),
      'utf8',
    );
    const indexSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/host/services/core/database/indexes.ts'),
      'utf8',
    );
    expect(repositorySource).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    expect(repositorySource).not.toMatch(/UPDATE\s+annotations/i);
    expect(repositorySource).not.toMatch(/DELETE\s+FROM\s+annotations/i);
    expect(indexSource).toContain('idx_annotations_case ON annotations(experiment_id, case_id, created_at)');
  });
});
