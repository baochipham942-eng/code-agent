import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectWalShmMismatch,
  ensureWalShmConsistency,
  expectedShmBytes,
} from '../../../src/host/services/core/database/walShmConsistency';

const PAGE = 4096;
const FRAME = 24 + PAGE;
const REGION = 32768;

function walBytesFor(frames: number): number {
  return 32 + frames * FRAME;
}

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe('expectedShmBytes', () => {
  it('第一个 region 容 4062 帧，之后每 region 4096 帧', () => {
    expect(expectedShmBytes(0)).toBe(REGION);
    expect(expectedShmBytes(4062)).toBe(REGION);
    expect(expectedShmBytes(4063)).toBe(2 * REGION);
    expect(expectedShmBytes(4062 + 4096)).toBe(2 * REGION);
    expect(expectedShmBytes(4062 + 4096 + 1)).toBe(3 * REGION);
  });
});

describe('detectWalShmMismatch', () => {
  it('shm 够大时不报', () => {
    expect(detectWalShmMismatch({ walBytes: walBytesFor(100), shmBytes: REGION, pageBytes: PAGE })).toBeNull();
  });

  it('shm 偏大无害，不报', () => {
    expect(detectWalShmMismatch({ walBytes: walBytesFor(100), shmBytes: 4 * REGION, pageBytes: PAGE })).toBeNull();
  });

  // 事故现场：shm=32KB（1 region）但 WAL 已涨到需要 3 个 region
  it('shm 小于 WAL 帧数所需时报出，并给出期望值', () => {
    const mismatch = detectWalShmMismatch({ walBytes: walBytesFor(9000), shmBytes: REGION, pageBytes: PAGE });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.walFrames).toBe(9000);
    expect(mismatch?.expectedShmBytes).toBe(3 * REGION);
  });

  it('page size 读不到（0）时不猜，直接不报', () => {
    expect(detectWalShmMismatch({ walBytes: walBytesFor(9000), shmBytes: REGION, pageBytes: 0 })).toBeNull();
  });
});

describe('ensureWalShmConsistency', () => {
  /** 造一个「WAL 需要 3 个 region，shm 只有 1 个」的事故现场 */
  function seedStaleShm(dir: string): string {
    const dbPath = path.join(dir, 'code-agent.db');
    const walHeader = Buffer.alloc(32);
    walHeader.writeUInt32BE(0x377f0682, 0);
    walHeader.writeUInt32BE(PAGE, 8);
    fs.writeFileSync(`${dbPath}-wal`, Buffer.concat([walHeader, Buffer.alloc(9000 * FRAME)]));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(REGION));
    return dbPath;
  }

  it('没有 wal/shm 时静默通过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const logger = fakeLogger();
    try {
      expect(ensureWalShmConsistency(path.join(dir, 'code-agent.db'), logger as never)).toBeNull();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 丙案：补大到应有尺寸；文件必须还在（删除才是危险动作）
  it('陈旧 shm 被补大到应有尺寸，且绝不删除文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const logger = fakeLogger();
    try {
      const dbPath = seedStaleShm(dir);

      const mismatch = ensureWalShmConsistency(dbPath, logger as never);

      expect(mismatch?.expectedShmBytes).toBe(3 * REGION);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      expect(fs.statSync(`${dbPath}-shm`).size).toBe(3 * REGION);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('补大后再跑一次不再判为 mismatch（幂等）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const logger = fakeLogger();
    try {
      const dbPath = seedStaleShm(dir);
      ensureWalShmConsistency(dbPath, logger as never);

      expect(ensureWalShmConsistency(dbPath, logger as never)).toBeNull();
      expect(logger.warn).toHaveBeenCalledOnce(); // 第二次不再补、不再喊
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('补不动（只读目录）时退回只报 ERROR，不抛', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const logger = fakeLogger();
    try {
      const dbPath = seedStaleShm(dir);
      fs.chmodSync(`${dbPath}-shm`, 0o444);

      expect(() => ensureWalShmConsistency(dbPath, logger as never)).not.toThrow();
      expect(logger.error).toHaveBeenCalledOnce();
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
    } finally {
      try { fs.chmodSync(path.join(dir, 'code-agent.db-shm'), 0o644); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
