import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkWalShmConsistency,
  detectWalShmMismatch,
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

describe('checkWalShmConsistency', () => {
  it('没有 wal/shm 时静默通过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const logger = fakeLogger();
    try {
      expect(checkWalShmConsistency(path.join(dir, 'code-agent.db'), logger as never)).toBeNull();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 验收 #7：人为造一个尺寸不匹配的 shm，必须看到 ERROR，且**不做任何修复**
  it('陈旧 shm 报 ERROR 但绝不删除文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shm-'));
    const dbPath = path.join(dir, 'code-agent.db');
    const logger = fakeLogger();
    try {
      const walHeader = Buffer.alloc(32);
      walHeader.writeUInt32BE(0x377f0682, 0);
      walHeader.writeUInt32BE(PAGE, 8);
      fs.writeFileSync(`${dbPath}-wal`, Buffer.concat([walHeader, Buffer.alloc(9000 * FRAME)]));
      fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(REGION));

      const mismatch = checkWalShmConsistency(dbPath, logger as never);
      expect(mismatch?.expectedShmBytes).toBe(3 * REGION);
      expect(logger.error).toHaveBeenCalledOnce();
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      expect(fs.statSync(`${dbPath}-shm`).size).toBe(REGION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
