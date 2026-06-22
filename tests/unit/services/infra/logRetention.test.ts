import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanupDirByMtime,
  runLogRetention,
  DEFAULT_LOG_RETENTION_DAYS,
} from '../../../../src/main/services/infra/logRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'logret-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFileWithMtime(filePath: string, mtimeMs: number): void {
  fs.writeFileSync(filePath, 'x');
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

describe('cleanupDirByMtime', () => {
  it('删除超过保留期的文件，保留新文件', async () => {
    const now = 1_000 * DAY_MS;
    writeFileWithMtime(path.join(tmpRoot, 'old.log'), now - 40 * DAY_MS);
    writeFileWithMtime(path.join(tmpRoot, 'fresh.log'), now - 1 * DAY_MS);

    const deleted = await cleanupDirByMtime(tmpRoot, 30 * DAY_MS, now);

    expect(deleted).toBe(1);
    expect(fs.existsSync(path.join(tmpRoot, 'old.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'fresh.log'))).toBe(true);
  });

  it('目录不存在 → 返回 0，不抛出', async () => {
    const deleted = await cleanupDirByMtime(path.join(tmpRoot, 'nope'), 30 * DAY_MS, 1_000 * DAY_MS);
    expect(deleted).toBe(0);
  });

  it('不递归子目录（只清当前层文件）', async () => {
    const now = 1_000 * DAY_MS;
    const sub = path.join(tmpRoot, 'sub');
    fs.mkdirSync(sub);
    writeFileWithMtime(path.join(sub, 'old.log'), now - 40 * DAY_MS);

    const deleted = await cleanupDirByMtime(tmpRoot, 30 * DAY_MS, now);

    expect(deleted).toBe(0);
    expect(fs.existsSync(path.join(sub, 'old.log'))).toBe(true);
  });
});

describe('runLogRetention', () => {
  it('清理 agent 引擎子目录的过期运行日志 + 接上审计清理', async () => {
    const now = 1_000 * DAY_MS;
    const engineRoot = path.join(tmpRoot, 'agent-engines');
    for (const sub of ['claude-code', 'codex-cli']) {
      const dir = path.join(engineRoot, sub);
      fs.mkdirSync(dir, { recursive: true });
      writeFileWithMtime(path.join(dir, 'run-old.log'), now - 40 * DAY_MS);
      writeFileWithMtime(path.join(dir, 'run-old.last.md'), now - 40 * DAY_MS);
      writeFileWithMtime(path.join(dir, 'run-fresh.log'), now - 1 * DAY_MS);
    }
    const auditCleanup = vi.fn().mockResolvedValue(3);

    const result = await runLogRetention({
      retentionDays: 30,
      engineLogRoot: engineRoot,
      now,
      auditCleanup,
    });

    // 每个子目录删 2 个过期文件（.log + .last.md），共 2 子目录 = 4
    expect(result.engineDeleted).toBe(4);
    expect(result.auditDeleted).toBe(3);
    expect(auditCleanup).toHaveBeenCalledWith(30);
    // 新文件保留
    expect(fs.existsSync(path.join(engineRoot, 'claude-code', 'run-fresh.log'))).toBe(true);
  });

  it('审计清理抛错不影响引擎日志清理（best-effort）', async () => {
    const now = 1_000 * DAY_MS;
    const engineRoot = path.join(tmpRoot, 'agent-engines');
    const dir = path.join(engineRoot, 'claude-code');
    fs.mkdirSync(dir, { recursive: true });
    writeFileWithMtime(path.join(dir, 'run-old.log'), now - 40 * DAY_MS);

    const result = await runLogRetention({
      retentionDays: 30,
      engineLogRoot: engineRoot,
      now,
      auditCleanup: vi.fn().mockRejectedValue(new Error('boom')),
    });

    expect(result.auditDeleted).toBe(0);
    expect(result.engineDeleted).toBe(1);
  });

  it('默认保留天数为 30', () => {
    expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30);
  });
});
