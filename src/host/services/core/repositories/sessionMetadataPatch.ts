import type BetterSqlite3 from 'better-sqlite3';

export interface SessionMetadataPatchOptions {
  modelConfig?: { provider: string; model: string };
  updatedAt?: number;
}

export function patchSessionMetadataAtomically(
  db: BetterSqlite3.Database,
  sessionId: string,
  patch: Record<string, unknown>,
  options?: SessionMetadataPatchOptions,
): boolean {
  const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as
    | { metadata: string | null }
    | undefined;
  if (!row) return false;

  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.metadata ? JSON.parse(row.metadata) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // 损坏的 metadata 视为空对象，补丁后修复为合法 JSON。
  }

  let changed = Boolean(options?.modelConfig);
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in merged) {
        delete merged[key];
        changed = true;
      }
    } else {
      merged[key] = value;
      changed = true;
    }
  }
  if (!changed) return true;

  db.prepare(`
    UPDATE sessions
    SET metadata = ?,
        model_provider = COALESCE(?, model_provider),
        model_name = COALESCE(?, model_name),
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(merged),
    options?.modelConfig?.provider ?? null,
    options?.modelConfig?.model ?? null,
    options?.updatedAt ?? Date.now(),
    sessionId,
  );
  return true;
}
