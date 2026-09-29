// ============================================================================
// 数据目录权限扫层（FB-238）
// 存量敏感文件/目录在启动时被收紧到 0600/0700；断言幂等（第二跑零 chmod）、
// win32 直接返回不碰 fs、目录内软链不跟（链外目标不被 chmod）。
// ============================================================================

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// chmod/lstat/readdir 调用计数：幂等断言「第二跑零 chmod」与 win32「不碰 fs」靠它
const fsCalls = vi.hoisted(() => ({ chmod: 0, lstat: 0, readdir: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const chmod = async (...args: Parameters<typeof actual.chmod>) => {
    fsCalls.chmod += 1;
    return actual.chmod(...args);
  };
  const lstat = async (...args: Parameters<typeof actual.lstat>) => {
    fsCalls.lstat += 1;
    return actual.lstat(...args);
  };
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    fsCalls.readdir += 1;
    return actual.readdir(...args);
  };
  return { ...actual, chmod, lstat, readdir };
});

// 日志文件汇避开被扫目录，别让 logger 的 warn 在数据目录里现造 logs/
const originalLogDir = process.env.CODE_AGENT_LOG_DIR;

import { ensureDataDirPermissions } from '../../../../src/host/config/dataDirPermissions';

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

function seedFile(p: string, content = 'x', m = 0o644): void {
  writeFileSync(p, content);
  chmodSync(p, m);
}

function seedDir(p: string, m = 0o755): void {
  mkdirSync(p);
  chmodSync(p, m);
}

describe('ensureDataDirPermissions', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    fsCalls.chmod = 0;
    fsCalls.lstat = 0;
    fsCalls.readdir = 0;
    process.env.CODE_AGENT_LOG_DIR = join(tmpdir(), 'neo-datadir-perms-logger-sink');
    root = mkdtempSync(join(tmpdir(), 'neo-datadir-perms-'));
    dataDir = join(root, 'data');
    seedDir(dataDir);
  });

  afterEach(() => {
    if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
    else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('收紧顶层敏感文件与敏感目录（含目录内一层文件），非敏感条目不动', async () => {
    seedFile(join(dataDir, '.env'));
    seedFile(join(dataDir, '.env.bak-x'));
    seedFile(join(dataDir, 'config.json.bak-y'));
    seedFile(join(dataDir, 'code-agent.db'));
    seedFile(join(dataDir, 'secure-storage.json'));
    seedFile(join(dataDir, '.secure-key'));
    seedFile(join(dataDir, '.dev-token'));
    seedFile(join(dataDir, 'readme.txt')); // 非敏感对照：不许动
    seedDir(join(dataDir, 'backup-z'));
    seedFile(join(dataDir, 'backup-z', 'code-agent.db.snapshot'));
    seedDir(join(dataDir, 'backup-z', 'nested'));
    seedFile(join(dataDir, 'backup-z', 'nested', 'deep.txt')); // 更深层：不递归
    seedDir(join(dataDir, 'logs'));
    seedFile(join(dataDir, 'logs', 'code-agent-2026-09-29.log'));

    await ensureDataDirPermissions(dataDir);

    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, '.env'))).toBe(0o600);
    expect(mode(join(dataDir, '.env.bak-x'))).toBe(0o600);
    expect(mode(join(dataDir, 'config.json.bak-y'))).toBe(0o600);
    expect(mode(join(dataDir, 'code-agent.db'))).toBe(0o600);
    expect(mode(join(dataDir, 'secure-storage.json'))).toBe(0o600);
    expect(mode(join(dataDir, '.secure-key'))).toBe(0o600);
    expect(mode(join(dataDir, '.dev-token'))).toBe(0o600);
    expect(mode(join(dataDir, 'readme.txt'))).toBe(0o644);
    expect(mode(join(dataDir, 'backup-z'))).toBe(0o700);
    expect(mode(join(dataDir, 'backup-z', 'code-agent.db.snapshot'))).toBe(0o600);
    expect(mode(join(dataDir, 'backup-z', 'nested'))).toBe(0o755);
    expect(mode(join(dataDir, 'backup-z', 'nested', 'deep.txt'))).toBe(0o644);
    expect(mode(join(dataDir, 'logs'))).toBe(0o700);
    expect(mode(join(dataDir, 'logs', 'code-agent-2026-09-29.log'))).toBe(0o600);
  });

  it('幂等：同一目录第二跑零 chmod 调用', async () => {
    seedFile(join(dataDir, '.env'));
    seedDir(join(dataDir, 'logs'));
    seedFile(join(dataDir, 'logs', 'code-agent-today.log'));

    await ensureDataDirPermissions(dataDir);
    expect(fsCalls.chmod).toBeGreaterThan(0);

    fsCalls.chmod = 0;
    await ensureDataDirPermissions(dataDir);
    expect(fsCalls.chmod).toBe(0);
  });

  it('win32 直接返回：不抛错也不碰 fs', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await expect(ensureDataDirPermissions(dataDir)).resolves.toBeUndefined();
      expect(fsCalls.chmod).toBe(0);
      expect(fsCalls.lstat).toBe(0);
      expect(fsCalls.readdir).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('目录内软链跳过：链外目标的 mode 不被改写', async () => {
    const outsideFile = join(root, 'outside-secret');
    seedFile(outsideFile, 'secret', 0o644);
    const outsideDir = join(root, 'outside-logs');
    seedDir(outsideDir, 0o755);
    // 敏感命名的软链也要跳过：chmod 会沿链打到链外目标
    symlinkSync(outsideFile, join(dataDir, '.env.bak-link'));
    symlinkSync(outsideDir, join(dataDir, 'logs-link'));

    await expect(ensureDataDirPermissions(dataDir)).resolves.toBeUndefined();

    expect(mode(outsideFile)).toBe(0o644);
    expect(mode(outsideDir)).toBe(0o755);
  });

  it('目录不存在时只 warn 不抛', async () => {
    await expect(ensureDataDirPermissions(join(root, 'no-such-dir'))).resolves.toBeUndefined();
  });
});
