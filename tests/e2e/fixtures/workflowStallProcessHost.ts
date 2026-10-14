// N-WF-STALL-RESTART 进程级夹具：两个真实 OS 进程先后打开同一个 sqlite 文件，
// 证明 workflow stall 的 (run_id, epoch) 去重跨进程存活——重启后不重播已送达的 epoch。
// 形状照抄 backgroundSubagentProcessHost.ts：argv = <phase> <data-dir>，结果走 stdout
// 单行 JSON marker，由父进程（tests/unit/agent/workflowStallDetector.restart.test.ts）
// 解析；announce 相位打印完 marker 后故意不收尾，等父进程 SIGKILL 模拟 host 被杀。
//
// 相位：
//   announce  首个进程：startRun → 虚拟时钟推过 N_HARD_MS → epoch 1 已播报且落库 → marker → 挂住等杀
//   restart   新进程同一 DB 文件：startRun → 再推过 N_HARD_MS → 断言 epoch 1 不重播、下一条是
//             epoch 2、库里恰为 {1,2}
//   degraded  降级变体：A) 表缺失（journal 读抛）→ 降级 warn + 模型面静默；
//             B) journal 为 null（DB 未就绪）→ in-process epoch 继续播报 + 降级 warn
//
// 变异开关 WF_STALL_MUTATION=skip-journal-seed：restart 相位给检测器传 journal: null
// （模拟「重启后不读 journal」的回归），epoch 1 会被重播，让驱动测试变红。

import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const [phase, dataDir] = process.argv.slice(2);
const mutation = process.env.WF_STALL_MUTATION ?? '';
if (!phase || !dataDir) {
  throw new Error('usage: workflowStallProcessHost <announce|restart|degraded> <data-dir>');
}
if (mutation && mutation !== 'skip-journal-seed') {
  throw new Error(`unknown WF_STALL_MUTATION ${mutation}; expected skip-journal-seed`);
}

await mkdir(dataDir, { recursive: true });

const { default: Database } = await import('better-sqlite3');
// 真表来自生产 schema（不手抄 DDL，与 tests/utils/applyTestSessionSchema.ts 同款做法）。
const { applySchema } = await import('../../../src/host/services/core/database/schema');
const { WorkflowJournalRepository } = await import(
  '../../../src/host/services/core/repositories/WorkflowJournalRepository'
);
const { WorkflowStallDetector } = await import('../../../src/host/agent/workflowStallDetector');
const { WORKFLOW_STALL_THRESHOLDS } = await import('../../../src/shared/constants');

const RUN_ID = 'wf-stall-restart-proc';
const noticesPath = path.join(dataDir, 'notices.jsonl');
const silentSchemaLogger = {
  debug() {}, info() {}, warn() {}, error() {},
} as unknown as Parameters<typeof applySchema>[1];

if (phase === 'announce') await announcePhase();
else if (phase === 'restart') await restartPhase();
else if (phase === 'degraded') await degradedPhase();
else throw new Error(`unknown phase: ${phase}`);

/** 虚拟时钟 + 定时器队列：把 10 分钟阈值压成同步推进，不真等。 */
function createVirtualClock(startAt: number) {
  type StallTimer = ReturnType<typeof setTimeout>;
  let current = startAt;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, delayMs: number): StallTimer => {
    const id = (sequence += 1);
    timers.set(id, { at: current + Math.max(0, delayMs), callback });
    // 虚拟句柄只回喂给 clearTimer；unref 由检测器用 ?. 安全调用。
    return { id } as unknown as StallTimer;
  };
  const clearTimer = (timer: StallTimer): void => {
    timers.delete((timer as unknown as { id: number }).id);
  };
  const advance = (ms: number): void => {
    const target = current + ms;
    for (;;) {
      let dueId = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === -1) break;
      const timer = timers.get(dueId)!;
      timers.delete(dueId);
      current = Math.max(current, timer.at);
      timer.callback();
    }
    current = target;
  };
  return { now: () => current, setTimer, clearTimer, advance };
}

interface CapturedWarning {
  message: string;
  details?: Record<string, unknown>;
}

function createCapturingLogger() {
  const warnings: CapturedWarning[] = [];
  return {
    warnings,
    logger: {
      warn: (message: string, details?: Record<string, unknown>) => warnings.push({ message, details }),
    },
  };
}

function openJournalDb(): {
  db: InstanceType<typeof Database>;
  journal: InstanceType<typeof WorkflowJournalRepository>;
} {
  const db = new Database(path.join(dataDir, 'workflow-stall.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  applySchema(db, silentSchemaLogger);
  return { db, journal: new WorkflowJournalRepository(db) };
}

function readDbEpochs(db: InstanceType<typeof Database>): number[] {
  const rows = db
    .prepare('SELECT epoch FROM workflow_stall_notices WHERE run_id = ? ORDER BY epoch')
    .all(RUN_ID) as Array<{ epoch: number }>;
  return rows.map((row) => row.epoch);
}

function readNoticeEpochs(): number[] {
  try {
    const text = readFileSync(noticesPath, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { epoch: number }).epoch);
  } catch {
    return [];
  }
}

// onStallNotice 在虚拟时钟同步推进里触发，落盘用同步写，marker 才不会读到半程文件。
function recordNotice(phaseTag: string, notice: { epoch: number; idleSeconds: number }): void {
  appendFileSync(noticesPath, `${JSON.stringify({ phase: phaseTag, pid: process.pid, ...notice })}\n`);
}

function check(condition: boolean, message: string): void {
  if (condition) return;
  process.stdout.write(`${JSON.stringify({
    marker: 'fixture-assertion-failed',
    phase,
    pid: process.pid,
    message,
  })}\n`);
  process.exit(1);
}

function marker(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function announcePhase(): Promise<never> {
  const { db, journal } = openJournalDb();
  const clock = createVirtualClock(1_000_000);
  const { warnings, logger } = createCapturingLogger();
  const announced: number[] = [];
  const detector = new WorkflowStallDetector({
    journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger,
    onStallNotice: (notice) => {
      announced.push(notice.epoch);
      recordNotice('announce', notice);
    },
  });
  detector.startRun(RUN_ID);
  clock.advance(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2);

  const dbEpochs = readDbEpochs(db);
  check(announced.join(',') === '1', `announce phase expected epoch 1 announced, got [${announced.join(',')}]`);
  check(dbEpochs.join(',') === '1', `announce phase expected durable epochs [1], got [${dbEpochs.join(',')}]`);
  marker({
    marker: 'announce-done',
    pid: process.pid,
    runId: RUN_ID,
    announced,
    dbEpochs,
    noticesEpochs: readNoticeEpochs(),
    warnings,
  });
  // 故意不收尾、不 close：父进程 SIGKILL 模拟 host 崩溃——已提交的 sqlite 写必须自己活下来。
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
  throw new Error('unreachable');
}

async function restartPhase(): Promise<void> {
  const { db, journal } = openJournalDb();
  const mutationActive = mutation === 'skip-journal-seed';
  const clock = createVirtualClock(5_000_000);
  const { warnings, logger } = createCapturingLogger();
  const announced: number[] = [];
  const detector = new WorkflowStallDetector({
    // 变异：跳过 journal 种子读（journal: null）→ 回归为「重启后重播 epoch 1」。
    journal: mutationActive ? null : journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger,
    onStallNotice: (notice) => {
      announced.push(notice.epoch);
      recordNotice('restart', notice);
    },
  });
  detector.startRun(RUN_ID);
  clock.advance(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2);

  const dbEpochs = readDbEpochs(db);
  check(!announced.includes(1), `restart re-announced epoch 1: [${announced.join(',')}]`);
  check(announced.join(',') === '2', `restart expected next announcement at epoch 2, got [${announced.join(',')}]`);
  check(
    dbEpochs.join(',') === '1,2',
    `restart expected durable epochs [1,2] (previous max + 1), got [${dbEpochs.join(',')}]`,
  );
  marker({
    marker: 'restart-done',
    pid: process.pid,
    runId: RUN_ID,
    announced,
    dbEpochs,
    noticesEpochs: readNoticeEpochs(),
    warnings,
    mutation: mutation || null,
  });
  detector.stopAll();
  db.close();
  process.exit(0);
}

async function degradedPhase(): Promise<void> {
  // A) 表缺失：真实 repository 读 getMaxStallEpoch 直接抛（sqlite 层「no such table」），
  //    检测器降级 warn；后续写入同样抛 → 模型面保持静默（announce=false 是既有行为）。
  const rawDb = new Database(path.join(dataDir, 'degraded-no-table.sqlite'));
  rawDb.pragma('busy_timeout = 5000');
  const rawJournal = new WorkflowJournalRepository(rawDb);
  let readError: string | null = null;
  try {
    rawJournal.getMaxStallEpoch(RUN_ID);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  check(readError !== null, 'expected getMaxStallEpoch to throw on a table-less db');

  const clockA = createVirtualClock(9_000_000);
  const captureA = createCapturingLogger();
  const announcedA: number[] = [];
  const detectorA = new WorkflowStallDetector({
    journal: rawJournal,
    now: clockA.now,
    setTimer: clockA.setTimer,
    clearTimer: clockA.clearTimer,
    logger: captureA.logger,
    onStallNotice: (notice) => {
      announcedA.push(notice.epoch);
      recordNotice('degraded-missing-table', notice);
    },
  });
  detectorA.startRun(RUN_ID);
  clockA.advance(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2);
  const missingTableDowngrades = captureA.warnings.filter(
    (warning) => warning.message === 'workflow stall detector downgraded to in-process epochs',
  );
  check(
    announcedA.length === 0,
    `missing-table degrade must stay model-face silent, announced [${announcedA.join(',')}]`,
  );
  check(
    missingTableDowngrades.some((warning) => String(warning.details?.reason).includes('journal read failed')),
    `missing-table degrade must warn the downgrade message with a read-failure reason, got ${JSON.stringify(captureA.warnings)}`,
  );
  detectorA.stopAll();
  rawDb.close();

  // B) DB 未就绪（getWorkflowJournalRepository() 返回 null 的生产降级形状）：journal 传 null，
  //    检测器继续用 in-process epoch 播报 + 降级 warn。
  const clockB = createVirtualClock(11_000_000);
  const captureB = createCapturingLogger();
  const announcedB: number[] = [];
  const detectorB = new WorkflowStallDetector({
    journal: null,
    now: clockB.now,
    setTimer: clockB.setTimer,
    clearTimer: clockB.clearTimer,
    logger: captureB.logger,
    onStallNotice: (notice) => {
      announcedB.push(notice.epoch);
      recordNotice('degraded-null-journal', notice);
    },
  });
  detectorB.startRun(RUN_ID);
  clockB.advance(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2);
  check(
    announcedB.join(',') === '1',
    `null-journal degrade should announce epoch 1 in-process, got [${announcedB.join(',')}]`,
  );
  check(
    captureB.warnings.some(
      (warning) => warning.message === 'workflow stall detector downgraded to in-process epochs'
        && warning.details?.reason === 'workflow journal repository is unavailable',
    ),
    `null-journal degrade must warn the downgrade message, got ${JSON.stringify(captureB.warnings)}`,
  );
  detectorB.stopAll();

  marker({
    marker: 'degraded-done',
    pid: process.pid,
    runId: RUN_ID,
    missingTable: { announced: announcedA, warnings: captureA.warnings, readError },
    nullJournal: { announced: announcedB, warnings: captureB.warnings },
  });
  process.exit(0);
}
