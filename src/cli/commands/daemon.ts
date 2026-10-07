// ============================================================================
// Daemon CLI — `neo daemon status` / `neo daemon stop`（ADR-083 常驻宿主客户端面）
// ============================================================================
// 轻量路由（同 doctor/policy：不加载 chat/run/serve）。status 直读本机数据目录的
// pid 文件 + durable_runs 名册（经 DurableRunRepository 挂在只读连接上），不走
// HTTP、不需要 auth——本机数据目录即权威；stop 对 pid 文件里的进程发 SIGTERM 并
// 等它退出（daemon 侧收到后先按 WEB_DAEMON 宽限排空，再走干净关库路径）。

import { Command } from 'commander';
import path from 'path';
import { getUserConfigDir } from '../../host/config/configPaths';
import { isDaemonPidAlive, readDaemonPidFile } from '../../host/daemon/daemonLock';
import type { ActiveRunRosterEntry } from '../../host/services/core/repositories/DurableRunRepository';
import { WEB_DAEMON } from '../../shared/constants/webServer';

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** 只读打开本机库读活跃 run 名册；库或表不存在时由调用方按「无在跑」口径处理。 */
async function loadActiveRunRoster(): Promise<ActiveRunRosterEntry[]> {
  const { ReadOnlySessionDatabase } = await import('../sessionDiagnostics/readOnlySessionDb');
  const db = new ReadOnlySessionDatabase(path.join(getUserConfigDir(), 'code-agent.db'));
  try {
    if (!db.hasTable('durable_runs')) return [];
    const { DurableRunRepository } = await import('../../host/services/core/repositories/DurableRunRepository');
    return await new DurableRunRepository(db.getNativeDatabase()).listActiveRunRoster();
  } finally {
    db.close();
  }
}

function printDaemonPidState(): void {
  const dataDir = getUserConfigDir();
  const pid = readDaemonPidFile(dataDir);
  if (pid == null) {
    write(`Daemon: not running (no readable pid file in ${dataDir})`);
  } else if (isDaemonPidAlive(pid)) {
    write(`Daemon: running (pid ${pid})`);
  } else {
    write(`Daemon: not running (stale pid file, pid ${pid})`);
  }
}

async function runStatus(): Promise<void> {
  printDaemonPidState();
  let runs: ActiveRunRosterEntry[];
  try {
    runs = await loadActiveRunRoster();
  } catch (error) {
    write(`Run roster: unavailable (${error instanceof Error ? error.message : String(error)}) — treating as none`);
    return;
  }
  if (runs.length === 0) {
    write('No runs in progress.');
    return;
  }
  write(`Runs in progress (${runs.length}):`);
  for (const run of runs) {
    write(`  ${run.runId}  status=${run.status}  session=${run.sessionId}  owner=${run.ownerId ?? 'none'}`);
  }
}

async function runStop(): Promise<void> {
  const dataDir = getUserConfigDir();
  const pid = readDaemonPidFile(dataDir);
  if (pid == null) {
    write(`Daemon: no readable pid file in ${dataDir} — nothing to stop.`);
    return;
  }
  if (!isDaemonPidAlive(pid)) {
    write(`Daemon: pid ${pid} is not running (stale pid file) — nothing to stop.`);
    return;
  }
  process.kill(pid, 'SIGTERM');
  write(`SIGTERM sent to daemon (pid ${pid}); waiting up to ${WEB_DAEMON.STOP_WAIT_MS / 1000}s (drain grace ${WEB_DAEMON.DRAIN_GRACE_MS / 1000}s)...`);
  const deadline = Date.now() + WEB_DAEMON.STOP_WAIT_MS;
  while (isDaemonPidAlive(pid)) {
    if (Date.now() >= deadline) {
      process.stderr.write(`Daemon (pid ${pid}) did not exit within ${WEB_DAEMON.STOP_WAIT_MS / 1000}s; still running.\n`);
      process.exitCode = 1;
      return;
    }
    await delay(WEB_DAEMON.POLL_INTERVAL_MS);
  }
  write('Daemon stopped.');
}

export const daemonCliCommand = new Command('daemon')
  .description('常驻宿主状态与优雅停止（ADR-083）')
  .action(runStatus);

daemonCliCommand
  .command('status')
  .description('Report daemon pid state and list in-progress runs from the local roster')
  .action(runStatus);

daemonCliCommand
  .command('stop')
  .description('SIGTERM the daemon (it drains in-flight runs first) and wait for it to exit')
  .action(runStop);
