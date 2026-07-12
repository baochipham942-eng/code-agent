import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { initializeDurableRun } from '../../../src/host/app/initializeDurableRun';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { applyDurableRunMigrationDraft } from '../../../src/host/services/core/database/migrations/durableRun';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const [phase, dataDir] = process.argv.slice(2);
if (!phase || !dataDir) throw new Error('rollout phase and data dir are required');
await mkdir(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'rollout.sqlite'));
applyDurableRunMigrationDraft(db);
const repository = new DurableRunRepository(db);
const mode = phase.split(':')[0]!;
const action = phase.split(':')[1]!;
const runtime = await initializeDurableRun({
  registry: new RunRegistry(),
  repository: mode === 'legacy' ? null : repository,
  dataDir,
  ownerId: `rollout-${mode}`,
  processInstanceId: `rollout-${mode}-${process.pid}`,
  env: { CODE_AGENT_DURABLE_RUN_MODE: mode },
  leaseDurationMs: 60_000,
  now: Date.now(),
});
if (action === 'create') {
  await runtime.kernel!.createNativeRun({
    runId: 'rollback-roundtrip-run', sessionId: 'rollback-roundtrip-session', now: Date.now(),
  });
}
const rowCount = Number((db.prepare('SELECT COUNT(*) AS count FROM durable_runs').get() as { count: number }).count);
const tableCount = Number((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'durable_run%'").get() as { count: number }).count);
const pass = rowCount === 1 && tableCount === 6
  && (mode === 'legacy' ? runtime.kernel === null : runtime.kernel !== null);
process.stdout.write(JSON.stringify({ phase, mode: runtime.policy.mode, rowCount, tableCount, pass }));
await runtime.shutdown();
db.close();
