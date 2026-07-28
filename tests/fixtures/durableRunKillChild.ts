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
// 带上自己的 pid：调用方要断言的是「真正持有这个 run 的进程死了」，
// 而它未必是 spawn 出来的那个直接子进程（tsx CLI 会再套一层）。
process.stdout.write(`READY ${process.pid}\n`);
setInterval(() => undefined, 1_000);
