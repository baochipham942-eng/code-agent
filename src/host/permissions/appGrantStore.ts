// ============================================================================
// 按应用的电脑操作授权
// 会话授权只活在本进程的 Map 里（这次对话）。始终允许进 app_permission_grants。
// 匹配走 computerAppsMatch：保留 bundle 与名字两侧，而不是只比 appKey。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import {
  appGrantKey,
  computerAppsMatch,
  type ComputerTargetApp,
} from './computerAppTarget';

interface AppGrantListItem {
  appKey: string;
  bundleId?: string;
  name: string;
  grantedAt: number;
}

interface GrantRow {
  app_key: string;
  bundle_id: string | null;
  app_name: string;
  granted_at: number;
}

class AppGrantRepository {
  private readonly upsertStmt: BetterSqlite3.Statement;
  private readonly deleteStmt: BetterSqlite3.Statement;
  private readonly listStmt: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO app_permission_grants (app_key, bundle_id, app_name, granted_at)
      VALUES (@appKey, @bundleId, @name, @grantedAt)
      ON CONFLICT(app_key) DO UPDATE SET
        bundle_id = excluded.bundle_id,
        app_name = excluded.app_name,
        granted_at = excluded.granted_at
    `);
    this.deleteStmt = db.prepare('DELETE FROM app_permission_grants WHERE app_key = ?');
    this.listStmt = db.prepare(
      'SELECT app_key, bundle_id, app_name, granted_at FROM app_permission_grants ORDER BY granted_at ASC',
    );
  }

  upsert(app: ComputerTargetApp, grantedAt: number): void {
    const bundleId = app.bundleId?.trim() || null;
    this.upsertStmt.run({
      appKey: appGrantKey(app),
      bundleId,
      name: app.name.trim(),
      grantedAt,
    });
  }

  delete(appKey: string): boolean {
    const result = this.deleteStmt.run(appKey);
    return result.changes > 0;
  }

  list(): AppGrantListItem[] {
    const rows = this.listStmt.all() as GrantRow[];
    return rows.map((row) => ({
      appKey: row.app_key,
      ...(row.bundle_id ? { bundleId: row.bundle_id } : {}),
      name: row.app_name,
      grantedAt: row.granted_at,
    }));
  }
}

class AppGrantStore {
  /** sessionId → 该对话里已允许的应用（完整身份，不是裸 key）。 */
  private readonly sessions = new Map<string, Map<string, ComputerTargetApp>>();

  constructor(private readonly repo: AppGrantRepository) {}

  mintSession(sessionId: string, app: ComputerTargetApp): void {
    const stored = normalizeApp(app);
    if (!stored) return;
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.sessions.set(sessionId, bucket);
    }
    bucket.set(appGrantKey(stored), stored);
  }

  mintStanding(app: ComputerTargetApp, grantedAt?: number): void {
    const stored = normalizeApp(app);
    if (!stored) return;
    this.repo.upsert(stored, grantedAt ?? Date.now());
  }

  match(sessionId: string, app: ComputerTargetApp): boolean {
    const bucket = this.sessions.get(sessionId);
    if (bucket) {
      for (const stored of bucket.values()) {
        if (computerAppsMatch(stored, app)) return true;
      }
    }
    return this.repo.list().some((row) => computerAppsMatch(
      { name: row.name, ...(row.bundleId ? { bundleId: row.bundleId } : {}) },
      app,
    ));
  }

  list(): AppGrantListItem[] {
    return this.repo.list();
  }

  revoke(appKey: string): boolean {
    return this.repo.delete(appKey);
  }
}

function normalizeApp(app: ComputerTargetApp): ComputerTargetApp | null {
  const name = app.name.trim();
  if (!name) return null;
  const bundleId = app.bundleId?.trim();
  return bundleId ? { name, bundleId } : { name };
}

let store: AppGrantStore | null = null;
let boundDb: BetterSqlite3.Database | null = null;

export function bindAppGrantDatabase(db: BetterSqlite3.Database, fresh = false): void {
  if (!fresh && store && boundDb === db) return;
  boundDb = db;
  store = new AppGrantStore(new AppGrantRepository(db));
}

function currentStore(): AppGrantStore | null {
  if (store) return store;
  try {
    // 懒取：静态 import databaseService 会在建表链路里转回来。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDatabase } = require('../services/core/databaseService') as typeof import('../services/core/databaseService');
    const db = getDatabase().getDb();
    if (!db) return null;
    bindAppGrantDatabase(db);
    return store;
  } catch {
    return null;
  }
}

export function mintAppGrantSession(sessionId: string, app: ComputerTargetApp): void {
  currentStore()?.mintSession(sessionId, app);
}

export function mintAppGrantStanding(app: ComputerTargetApp, grantedAt?: number): void {
  currentStore()?.mintStanding(app, grantedAt);
}

export function matchAppGrant(sessionId: string, app: ComputerTargetApp): boolean {
  return currentStore()?.match(sessionId, app) ?? false;
}

export function listAppGrants(): AppGrantListItem[] {
  return currentStore()?.list() ?? [];
}

export function revokeAppGrant(appKey: string): boolean {
  return currentStore()?.revoke(appKey) ?? false;
}
