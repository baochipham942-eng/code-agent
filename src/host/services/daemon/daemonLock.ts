// ============================================================================
// Daemon Lock — ADR-083 常驻宿主的 pid 文件 + 单实例锁
// ============================================================================
// 同一数据目录只允许一个执行体（webServer 服务态）。锁文件是 <dataDir>/daemon.pid，
// 内容是 JSON 记录 { pid, startTime }：startTime 是持锁瞬间 `ps lstart` 的进程
// 启动标记，用来防 pid 复用——活着的 pid 未必还是当年写文件的那个进程。旧版
// 纯 pid 文本按 startTime=null 解析。dev 槽各有独立数据目录，pid 文件互不冲突。
//
// 语义：
//   - acquire：原子创建（'wx'，存在即失败）。文件里是活守护（标记吻合）或
//     身份未知的活 pid → 让位退出（fail-closed：宁可不起，不删、不碰证明
//     不了归属的进程）；死 pid（陈旧锁，持有者崩了没来得及释放）或标记不符
//     的活 pid（pid 已被复用，那不是写这份文件的守护）→ 收走重试接管。
//   - 并发竞态：两个同时拉起的实例，只有一个能赢下 'wx'；输家读到赢家的记录
//     （或读到空文件 = 赢家刚建文件还没写完 pid，按「有实例正在启动」处理）退出。
//     接管陈旧锁时先复读再删（read-verify-unlink）：read 和 unlink 之间可能正好
//     有并发者接管了同一个死 pid，删别人的活锁会把单实例闸打穿。
//   - release：只有「文件还是本进程写的、且身份仍吻合」才删——崩溃/重启过的
//     进程跑迟到的 shutdown 回调也删不掉接任者的锁。失败不挡退出：残留文件
//     按陈旧锁被下次接管。
//
// 本模块只管锁，不问端口（端口冲突仍由 portCleanup / EADDRINUSE 路径处理），
// 也不 kill 任何进程（那是 CLI daemon stop 的事）；唯一的子进程调用是只读的
// `ps lstart`，用于进程身份比对。
// ============================================================================

import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

/** pid 文件名（落在数据目录根下，与 .dev-token 同级）。 */
const DAEMON_PID_FILE = 'daemon.pid';

/** 接管陈旧锁的重试次数：每次循环要么赢下 wx、要么明确让位，3 次足够覆盖并发窗口。 */
const ACQUIRE_ATTEMPTS = 3;

interface DaemonPidRecord {
  pid: number;
  /** 持锁时捕获的进程启动标记；旧版文件 / 读不出的平台为 null。 */
  startTime: string | null;
}

type PidFileContent = { kind: 'ok'; record: DaemonPidRecord } | { kind: 'unreadable' } | { kind: 'missing' };

/** 读进程启动标记（`ps lstart`，macOS/Linux 可用）。pid 被操作系统复用后该值会变，
 * 是「还是同一个进程」的判据；平台不支持 / 读不出 → null，调用方按身份未知
 * fail-closed，不把陌生活进程当成我们的守护。 */
function readProcessStartTime(pid: number): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return start || null;
  } catch {
    return null;
  }
}

function readPidFile(pidPath: string): PidFileContent {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error; // 权限等异常上抛：吞掉会静默放行双实例
  }
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = parsed as { pid?: unknown; startTime?: unknown };
      const startTime = candidate.startTime === undefined ? null : candidate.startTime;
      if (typeof candidate.pid === 'number' && Number.isInteger(candidate.pid) && candidate.pid > 0
        && (typeof startTime === 'string' || startTime === null)) {
        return { kind: 'ok', record: { pid: candidate.pid, startTime } };
      }
    }
  } catch {
    // 内容不是 JSON：走下面的旧版纯 pid 解析。
  }
  // 旧版纯 pid 文件：活进程按「身份未知」处理——可让位、不可接管、不可发信号。
  const pid = Number.parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0
    ? { kind: 'ok', record: { pid, startTime: null } }
    : { kind: 'unreadable' };
}

/** pid 是否活着。EPERM = 进程在、只是不归我们管（见 webShutdownFinalizers 同款判据）。 */
function isDaemonPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type DaemonPidState = 'dead' | 'owned' | 'foreign' | 'unknown';

/** pid 记录四态判别，只读、绝不发信号：
 * dead=进程不在；owned=活着且启动标记吻合（就是写文件的守护）；foreign=活着但
 * 标记不符（pid 已被复用）；unknown=活着但无法验证（无标记 / 平台读不出标记）。 */
export function inspectDaemonPid(record: DaemonPidRecord): DaemonPidState {
  if (!isDaemonPidAlive(record.pid)) return 'dead';
  if (!record.startTime) return 'unknown';
  const actualStartTime = readProcessStartTime(record.pid);
  if (!actualStartTime) return 'unknown';
  return actualStartTime === record.startTime ? 'owned' : 'foreign';
}

/** 读 pid 文件记录给客户端面（`neo daemon status/stop`）用：无文件或内容不可读 → null。 */
export function readDaemonPidRecord(dataDir: string): DaemonPidRecord | null {
  const content = readPidFile(path.join(dataDir, DAEMON_PID_FILE));
  return content.kind === 'ok' ? content.record : null;
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
      fs.writeSync(fd, JSON.stringify({ pid, startTime: readProcessStartTime(pid) } satisfies DaemonPidRecord));
      fs.closeSync(fd);
      return { acquired: true, pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = readPidFile(pidPath);
    if (existing.kind === 'missing') continue; // 持有者刚好释放，重试 wx
    if (existing.kind === 'unreadable') return { acquired: false, existingPid: null };
    lastSeenPid = existing.record.pid;
    const state = inspectDaemonPid(existing.record);
    // owned：活守护在场，让位。unknown：活 pid 但证明不了身份——fail-closed 让位，
    // 绝不删除或发信号（pid 复用会误伤无辜进程）。只有 dead / foreign 可接管：
    // 前者是陈旧锁，后者活着但已不是写这份文件的守护。
    if (state === 'owned' || state === 'unknown') return { acquired: false, existingPid: existing.record.pid };
    try {
      const current = readPidFile(pidPath);
      if (current.kind !== 'ok'
        || current.record.pid !== existing.record.pid
        || current.record.startTime !== existing.record.startTime) continue;
      fs.unlinkSync(pidPath);
    } catch {
      continue; // ENOENT：已被并发者收走，重试
    }
  }
  return { acquired: false, existingPid: lastSeenPid };
}

/** 释放锁（shutdown 用）：删 pid 文件。ENOENT / 其他失败都不挡退出。 */
export function releaseDaemonLock(dataDir: string): void {
  const pidPath = path.join(dataDir, DAEMON_PID_FILE);
  const record = readPidFile(pidPath);
  if (record.kind !== 'ok' || record.record.pid !== process.pid) return;
  // startTime 为 null 的记录是本进程在取不到标记的平台上自己写的，pid 相等即足以
  // 证明归属；有标记的记录再比对当前身份，防止迟到的 shutdown 回调删掉接任者的锁。
  if (record.record.startTime !== null && inspectDaemonPid(record.record) !== 'owned') return;
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // 残留 pid 文件按陈旧锁被下次启动接管，不是停机路径上值得报错的事。
  }
}
