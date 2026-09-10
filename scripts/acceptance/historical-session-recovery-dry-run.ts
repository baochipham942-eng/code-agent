// Read-only operator diagnostic. This entry point cannot apply a recovery.
// Run with: npx tsx scripts/acceptance/historical-session-recovery-dry-run.ts DB ACTOR_ID WORKSPACE
import Database from 'better-sqlite3';
import { HistoricalSessionRecoveryRepository } from '../../src/host/services/core/repositories/HistoricalSessionRecoveryRepository';

const [databasePath, actorUserId, workspace] = process.argv.slice(2);
if (!databasePath || !actorUserId || !workspace || process.argv.length !== 5) {
  throw new Error('Usage: historical-session-recovery-dry-run.ts DB ACTOR_ID WORKSPACE');
}
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  db.pragma('query_only = ON');
  const rows = db.prepare('SELECT id, project_id FROM sessions WHERE working_directory = ? AND COALESCE(is_deleted, 0) = 0 ORDER BY id')
    .all(workspace) as Array<{ id: string; project_id: string | null }>;
  const service = new HistoricalSessionRecoveryRepository(db);
  const results = db.transaction(() => rows.map((row) => ({ sourceSessionId: row.id,
    ...service.recover(actorUserId, { sessionId: row.id, projectId: row.project_id, action: 'inspect' }),
  })))();
  process.stdout.write(`${JSON.stringify({ mode: 'readonly-dry-run', identity: 'operator-supplied; apply requires verified host authentication',
    selected: results.length, ready: results.filter((result) => result.status === 'ready').length, results }, null, 2)}\n`);
} finally { db.close(); }
