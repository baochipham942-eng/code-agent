// ============================================================================
// WAL / -shm 一致性保障（发现过小就**补大**，不删除）
// ----------------------------------------------------------------------------
// 2026-07-31 事故：覆盖安装时 0.27.0 的 webServer 被 SIGKILL，留下一个 32KB 的陈旧
// `-shm`（1 个 wal-index region）。下次启动 VACUUM 把 6 万+ 页刷进 WAL，SQLite 映射到
// 第 2、3 个 region 时越过了 shm 文件 EOF → pagein EINVAL → SIGBUS，启动直接崩。
//
// **仍然刻意不删陈旧 shm**：判断「没有其他连接持有这个 shm」不可靠——本项目已知一个
// data dir 可能被两个 host 共写。判错就是删掉别人正在映射的 shm，制造出与本次事故
// 一模一样的 SIGBUS。
//
// 2026-08-08 拍板取「丙案」：**把 shm 补大到应有尺寸**（ftruncate 扩大）。
// 关键性质——扩大一个文件**不会**让任何已有 mmap 失效：既有映射的页偏移不变，扩大只是
// 在原 EOF 之后追加可映射的页。所以这一步**不需要先证明自己独占**，与"删除"这个动作
// 的风险结构完全不同。补出来的空洞读回全零，正是一个刚扩容的 wal-index region 应有的
// 样子；SQLite 会按 WAL 自行重建索引内容。
//
// 修不动（只读挂载、权限不足等）时不抛异常：照旧记 ERROR，退回「只报警」的老行为。
// ============================================================================

import * as fs from 'fs';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

/** WAL 文件头长度（magic/format/pageSize/ckptSeq/salt×2/checksum×2） */
const WAL_HEADER_BYTES = 32;
/** 每个 WAL 帧的帧头长度 */
const WAL_FRAME_HEADER_BYTES = 24;
/** wal-index（-shm）按固定大小的 region 增长 */
const SHM_REGION_BYTES = 32768;
/** 第一个 region 的哈希表要给 wal-index 头让位，容量比后续 region 少 */
const SHM_FRAMES_FIRST_REGION = 4062;
const SHM_FRAMES_PER_REGION = 4096;

export interface WalShmMismatch {
  walBytes: number;
  shmBytes: number;
  pageBytes: number;
  walFrames: number;
  expectedShmBytes: number;
}

/** WAL 帧数 → wal-index 至少需要多大 */
export function expectedShmBytes(walFrames: number): number {
  if (walFrames <= SHM_FRAMES_FIRST_REGION) return SHM_REGION_BYTES;
  const extra = Math.ceil((walFrames - SHM_FRAMES_FIRST_REGION) / SHM_FRAMES_PER_REGION);
  return (1 + extra) * SHM_REGION_BYTES;
}

/**
 * 纯判定：shm 比 WAL 帧数所需的还小 = 危险（映射会越过 EOF → SIGBUS）。
 * shm 偏大无害（只是没被截断），不报。
 */
export function detectWalShmMismatch(input: {
  walBytes: number;
  shmBytes: number;
  pageBytes: number;
}): WalShmMismatch | null {
  const { walBytes, shmBytes, pageBytes } = input;
  if (pageBytes <= 0) return null;
  const walFrames = walBytes > WAL_HEADER_BYTES
    ? Math.floor((walBytes - WAL_HEADER_BYTES) / (WAL_FRAME_HEADER_BYTES + pageBytes))
    : 0;
  const expected = expectedShmBytes(walFrames);
  if (shmBytes >= expected) return null;
  return { walBytes, shmBytes, pageBytes, walFrames, expectedShmBytes: expected };
}

/** 读 WAL 头里的 page size（offset 8，大端 u32）。读不到返回 0。 */
function readWalPageBytes(walPath: string): number {
  let fd: number | null = null;
  try {
    fd = fs.openSync(walPath, 'r');
    const header = Buffer.alloc(WAL_HEADER_BYTES);
    if (fs.readSync(fd, header, 0, WAL_HEADER_BYTES, 0) < WAL_HEADER_BYTES) return 0;
    return header.readUInt32BE(8);
  } catch {
    return 0;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 开库前的一致性保障：发现 -shm 比 WAL 所需的小，就把它补大到应有尺寸（永不删除、永不抛）。
 * 返回 mismatch 详情供调用方（诊断/测试）使用；返回 null 表示本来就一致。
 */
export function ensureWalShmConsistency(dbPath: string, logger: Logger): WalShmMismatch | null {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  let walBytes: number;
  let shmBytes: number;
  try {
    walBytes = fs.statSync(walPath).size;
    shmBytes = fs.statSync(shmPath).size;
  } catch {
    return null; // 没有 wal/shm（干净关闭过）= 无从比对，也无风险
  }

  const mismatch = detectWalShmMismatch({
    walBytes,
    shmBytes,
    pageBytes: readWalPageBytes(walPath),
  });
  if (!mismatch) return null;

  const context = `wal=${mismatch.walBytes}B shm=${mismatch.shmBytes}B `
    + `(expected >= ${mismatch.expectedShmBytes}B) pageSize=${mismatch.pageBytes}B `
    + `walFrames=${mismatch.walFrames} db=${dbPath}`;

  try {
    fs.truncateSync(shmPath, mismatch.expectedShmBytes);
    logger.warn(
      '[DatabaseService] stale -shm was smaller than the WAL requires (signature of the 2026-07-31 SIGBUS) — '
      + 'grown to the required size before opening. Growing never invalidates another process\'s existing '
      + `mapping, so this needs no exclusivity proof (deleting the file would). ${context}`,
    );
  } catch (error) {
    logger.error(
      '[DatabaseService] WAL/-shm size mismatch detected before opening the database and the repair '
      + '(growing the wal-index) failed — the next large write may map past EOF and SIGBUS. '
      + `${context} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return mismatch;
}
