// ============================================================================
// Daemon Lock — ADR-083 常驻宿主的 pid 文件 + 单实例锁
// ============================================================================
// 同一数据目录只允许一个执行体（webServer 服务态）。锁文件是 <dataDir>/daemon.pid，
// 内容只有持有者 pid。dev 槽各有独立数据目录，pid 文件互不冲突。
//
// 语义：
//   - acquire：原子创建（'wx'，存在即失败）。文件里是活 pid → 让位退出；死 pid
//     （陈旧锁，持有者崩了没来得及释放）→ 收走重试接管。
//   - 并发竞态：两个同时拉起的实例，只有一个能赢下 'wx'；输家读到赢家的 pid
//     （或读到空文件 = 赢家刚建文件还没写完 pid，按「有实例正在启动」处理）退出。
//     接管陈旧锁时先复读再删（read-verify-unlink）：read 和 unlink 之间可能正好
//     有并发者接管了同一个死 pid，删别人的活锁会把单实例闸打穿。
//   - release：删 pid 文件；失败不挡退出——残留文件按陈旧锁被下次接管。
//
// 本模块只管锁，不问端口（端口冲突仍由 portCleanup / EADDRINUSE 路径处理），
// 也不 spawn / kill 任何进程（那是 CLI daemon stop 的事）。
// ============================================================================

import fs from 'fs';
import path from 'path';

/** pid 文件名（落在数据目录根下，与 .dev-token 同级）。 */
const DAEMON_PID_FILE = 'daemon.pid';

/** 接管陈旧锁的重试次数：每次循环要么赢下 wx、要么明确让位，3 次足够覆盖并发窗口。 */
const ACQUIRE_ATTEMPTS = 3;

type PidFileContent = { kind: 'ok'; pid: number } | { kind: 'unreadable' } | { kind: 'missing' };

function readPidFile(pidPath: string): PidFileContent {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error; // 权限等异常上抛：吞掉会静默放行双实例
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? { kind: 'ok', pid } : { kind: 'unreadable' };
}

/** pid 是否活着。EPERM = 进程在、只是不归我们管（见 webShutdownFinalizers 同款判据）。 */
export function isDaemonPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读 pid 文件给客户端面（`neo daemon status/stop`）用：无文件或内容不可读 → null。 */
export function readDaemonPidFile(dataDir: string): number | null {
  const content = readPidFile(path.join(dataDir, DAEMON_PID_FILE));
  return content.kind === 'ok' ? content.pid : null;
}

/**
 * 获取单实例锁。成功返回 { acquired: true, pid }；失败返回
 * { acquired: false, existingPid }——existingPid 是现有实例的 pid，null 表示
 * pid 文件在但读不出 pid（有实例正在启动）。调用方（webServer）拿到 false 后
 * 报出 pid 并退出。
 */
export function acquireDaemonLock(dataDir: string, pid: number = process.pid): { acquired: true; pid: number } | { acquired: false; existingPid: number | null } {
  fs.mkdirSync(dataDir, { recursive: true });
  const pidPath = path.join(dataDir, DAEMON_PID_FILE);
  let lastSeenPid: number | null = null;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const fd = fs.openSync(pidPath, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return { acquired: true, pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = readPidFile(pidPath);
    if (existing.kind === 'missing') continue; // 持有者刚好释放，重试 wx
    if (existing.kind === 'unreadable') return { acquired: false, existingPid: null };
    lastSeenPid = existing.pid;
    if (isDaemonPidAlive(existing.pid)) return { acquired: false, existingPid: existing.pid };
    try {
      const current = readPidFile(pidPath);
      if (current.kind !== 'ok' || current.pid !== existing.pid) continue;
      fs.unlinkSync(pidPath);
    } catch {
      continue; // ENOENT：已被并发者收走，重试
    }
  }
  return { acquired: false, existingPid: lastSeenPid };
}

/** 释放锁（shutdown 用）：删 pid 文件。ENOENT / 其他失败都不挡退出。 */
export function releaseDaemonLock(dataDir: string): void {
  try {
    fs.unlinkSync(path.join(dataDir, DAEMON_PID_FILE));
  } catch {
    // 残留 pid 文件按陈旧锁被下次启动接管，不是停机路径上值得报错的事。
  }
}
