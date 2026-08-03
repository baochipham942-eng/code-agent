import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';
import type { ProjectCapabilityKind } from '../../../src/shared/contract/project';

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

describe('project capability selections', () => {
  let db: BetterSqlite3.Database;
  let repo: ProjectRepository;
  let service: ProjectService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    seedProject(db, 'proj_alpha');
    seedProject(db, 'proj_beta');
    repo = new ProjectRepository(db);
    service = new ProjectService(() => repo);
  });

  afterEach(() => db.close());

  it('selects and lists a project connector', () => {
    const selected = service.selectCapability('proj_alpha', 'connector', 'mail', NOW + 1);

    expect(selected).toEqual({
      projectId: 'proj_alpha',
      kind: 'connector',
      capabilityId: 'mail',
      selectedAt: NOW + 1,
    });
    expect(service.listCapabilitySelections('proj_alpha')).toEqual([selected]);
  });

  it('unselects a project connector and reports repeated removal', () => {
    service.selectCapability('proj_alpha', 'connector', 'mail', NOW + 1);

    expect(service.unselectCapability('proj_alpha', 'connector', 'mail', NOW + 2))
      .toEqual({ removed: true });
    expect(service.unselectCapability('proj_alpha', 'connector', 'mail', NOW + 3))
      .toEqual({ removed: false });
    expect(service.listCapabilitySelections('proj_alpha')).toEqual([]);
  });

  it('keeps repeated selection idempotent', () => {
    const first = service.selectCapability('proj_alpha', 'connector', 'mail', NOW + 1);
    const repeated = service.selectCapability('proj_alpha', 'connector', 'mail', NOW + 2);

    expect(repeated).toEqual(first);
    expect(service.listCapabilitySelections('proj_alpha')).toHaveLength(1);
    expect(repo.getProject('proj_alpha')?.updatedAt).toBe(NOW + 1);
  });

  it.each(['skill', 'automation', 'unknown'])(
    'rejects unsupported or invalid kind %s',
    (kind) => {
      expect(() => service.selectCapability(
        'proj_alpha',
        kind as ProjectCapabilityKind,
        'capability_1',
        NOW + 1,
      )).toThrow(`Unsupported project capability selection kind: ${kind}`);
    },
  );

  it('rejects an empty capability id', () => {
    expect(() => service.selectCapability('proj_alpha', 'connector', '   ', NOW + 1))
      .toThrow('projectId and capabilityId are required');
  });

  it('isolates selections across projects', () => {
    service.selectCapability('proj_alpha', 'connector', 'mail', NOW + 1);
    service.selectCapability('proj_beta', 'connector', 'calendar', NOW + 2);

    expect(service.listCapabilitySelections('proj_alpha')?.map((item) => item.capabilityId))
      .toEqual(['mail']);
    expect(service.listCapabilitySelections('proj_beta')?.map((item) => item.capabilityId))
      .toEqual(['calendar']);
  });
});
