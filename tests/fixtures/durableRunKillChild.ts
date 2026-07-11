import Database from 'better-sqlite3';
import { DurableRunRepository } from '../../src/host/services/core/repositories/DurableRunRepository';
import { DurableRunKernel } from '../../src/host/runtime/durableRunKernel';

const dbPath = process.argv[2];
if (!dbPath) throw new Error('database path is required');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const repository = new DurableRunRepository(db);
repository.migrate();
const kernel = new DurableRunKernel({
  stores: repository,
  ownerId: 'native-host',
  processInstanceId: `child-${process.pid}`,
  leaseDurationMs: 100,
});

await kernel.createNativeRun({ runId: 'run-killed', sessionId: 'session-killed', now: Date.now() });
process.stdout.write('READY\n');
setInterval(() => undefined, 1_000);
