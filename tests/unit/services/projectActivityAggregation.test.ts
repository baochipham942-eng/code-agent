import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';
import type { NeoWorkCardStatus } from '../../../src/shared/contract/tag';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

const NOW = 1_800_000_000_000;

function seedProject(db: BetterSqlite3.Database, id: string, updatedAt = NOW): void {
  db.prepare(`
    INSERT INTO projects (
      id, name, workspace_path, workspace_key, status, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)
  `).run(id, id, `/work/${id}`, `key_${id}`, NOW, updatedAt);
}

function seedSession(
  db: BetterSqlite3.Database,
  id: string,
  projectId: string,
  updatedAt: number,
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, title, model_provider, model_name, project_id, created_at, updated_at
    ) VALUES (?, ?, 'p', 'm', ?, ?, ?)
  `).run(id, id, projectId, NOW, updatedAt);
}

function seedWorkCard(
  db: BetterSqlite3.Database,
  id: string,
  projectId: string,
  status: NeoWorkCardStatus,
  updatedAt: number,
): void {
  db.prepare(`
    INSERT INTO neo_work_cards (
      id, project_id, source_conversation_id, source_turn_id, requester_user_id,
      title, status, current_revision_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'user_1', ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    `conversation_${id}`,
    `turn_${id}`,
    id,
    status,
    `revision_${id}`,
    NOW,
    updatedAt,
  );
}

describe('project activity aggregation', () => {
  let db: BetterSqlite3.Database;
  let service: ProjectService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    const repo = new ProjectRepository(db);
    service = new ProjectService(() => repo);
  });

  afterEach(() => db.close());

  it('returns zero active topics and no activity for an empty project', () => {
    seedProject(db, 'proj_empty');

    expect(service.listProjectsWithActivity()).toEqual([
      expect.objectContaining({
        id: 'proj_empty',
        activeTopicCount: 0,
        lastActivityAt: null,
      }),
    ]);
  });

  it('counts only non-terminal topics and uses the newest topic or session activity', () => {
    seedProject(db, 'proj_alpha');
    seedProject(db, 'proj_beta');
    seedWorkCard(db, 'draft', 'proj_alpha', 'draft', NOW + 10);
    seedWorkCard(db, 'working', 'proj_alpha', 'working', NOW + 20);
    seedWorkCard(db, 'completed', 'proj_alpha', 'completed', NOW + 30);
    seedWorkCard(db, 'failed', 'proj_alpha', 'failed', NOW + 40);
    seedWorkCard(db, 'cancelled', 'proj_alpha', 'cancelled', NOW + 50);
    seedWorkCard(db, 'archived', 'proj_alpha', 'archived', NOW + 60);
    seedSession(db, 'session_alpha', 'proj_alpha', NOW + 70);
    seedSession(db, 'session_beta', 'proj_beta', NOW + 80);

    const projects = service.listProjectsWithActivity();

    expect(projects.map((project) => project.id)).toEqual(['proj_beta', 'proj_alpha']);
    expect(projects.find((project) => project.id === 'proj_alpha')).toEqual(
      expect.objectContaining({
        activeTopicCount: 2,
        lastActivityAt: NOW + 70,
      }),
    );
    expect(projects.find((project) => project.id === 'proj_beta')).toEqual(
      expect.objectContaining({
        activeTopicCount: 0,
        lastActivityAt: NOW + 80,
      }),
    );
  });
});
