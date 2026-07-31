// ============================================================================
// WAL / -shm 一致性检查（只报警，不修复）
// ----------------------------------------------------------------------------
// 2026-07-31 事故：覆盖安装时 0.27.0 的 webServer 被 SIGKILL，留下一个 32KB 的陈旧
// `-shm`（1 个 wal-index region）。下次启动 VACUUM 把 6 万+ 页刷进 WAL，SQLite 映射到
// 第 2、3 个 region 时越过了 shm 文件 EOF → pagein EINVAL → SIGBUS，启动直接崩。
//
// **刻意不做自动修复**（删陈旧 shm）：判断"没有其他连接持有这个 shm"不可靠——本项目
// 已知一个 data dir 可能被两个 host 共写且尚未修复。判错就是删掉别人正在映射的 shm，
// 制造出与本次事故一模一样的 SIGBUS。这个门比它防的 bug 更难写对。
//
// 所以这里只做一件事：开库前发现尺寸对不上就记 ERROR，让下次同类事故一眼可判。
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
 * 开库前的一致性检查。**只记 ERROR，不做任何修复**，永不抛。
 * 返回 mismatch 详情供调用方（诊断/测试）使用。
 */
export function checkWalShmConsistency(dbPath: string, logger: Logger): WalShmMismatch | null {
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

  logger.error(
    '[DatabaseService] WAL/-shm size mismatch detected before opening the database — '
    + 'the wal-index is smaller than the WAL requires. This is the signature of the 2026-07-31 SIGBUS '
    + '(stale -shm left behind by a SIGKILL\'d webServer). NOT auto-repaired on purpose: deleting a -shm '
    + 'another live connection is mapping would cause the very same crash. '
    + `wal=${mismatch.walBytes}B shm=${mismatch.shmBytes}B (expected >= ${mismatch.expectedShmBytes}B) `
    + `pageSize=${mismatch.pageBytes}B walFrames=${mismatch.walFrames} db=${dbPath}`,
  );
  return mismatch;
}
