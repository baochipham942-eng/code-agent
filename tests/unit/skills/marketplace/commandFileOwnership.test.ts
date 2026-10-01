// ============================================================================
// commandFileOwnership Tests — prompt command 副本归属校验与 TOCTOU 收口
// （N-SKILL-SCAN-VERSION-RESCAN，ai-review R4/R5 Important 2）
// fs/promises 部分 mock 只在 readFile 上包一层钩子，用来在「读副本 → rename 隔离」
// 窗口内注入用户改写，钉死 rename-隔离 + 二次校验的防护。
// ============================================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  afterDestRead: undefined as undefined | ((filePath: string) => Promise<void>),
  failNextQuarantineRm: false,
  failNextRestoreRename: false,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: vi.fn(),
  }),
}));

vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: (async (filePath: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) => {
      const content = await actual.readFile(filePath, options as never);
      await mocks.afterDestRead?.(String(filePath));
      return content;
    }) as typeof actual.readFile,
    rm: (async (filePath: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (mocks.failNextQuarantineRm && String(filePath).includes('.neo-owncheck-')) {
        mocks.failNextQuarantineRm = false;
        throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
      }
      return actual.rm(filePath, options as never);
    }) as typeof actual.rm,
    rename: (async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      // restore rename = 隔离名回原名；隔离化 rename = 原名进隔离名
      if (mocks.failNextRestoreRename
        && String(oldPath).includes('.neo-owncheck-')
        && !String(newPath).includes('.neo-owncheck-')) {
        mocks.failNextRestoreRename = false;
        throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
      }
      return actual.rename(oldPath, newPath);
    }) as typeof actual.rename,
  };
});

import { removeCommandFileIfOwnedByPlugin } from '../../../../src/host/skills/marketplace/commandFileOwnership';

const SOURCE_CONTENT = '---\ndescription: plugin version\n---\nplugin';

describe('removeCommandFileIfOwnedByPlugin', () => {
  let tempRoot: string;
  let sourceRoot: string;
  let dest: string;

  beforeEach(async () => {
    mocks.afterDestRead = undefined;
    mocks.failNextQuarantineRm = false;
    mocks.failNextRestoreRename = false;
    mocks.logWarn.mockClear();
    mocks.logError.mockClear();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-ownership-'));
    sourceRoot = path.join(tempRoot, 'plugin');
    await fs.mkdir(path.join(sourceRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'commands', 'inspect.md'), SOURCE_CONTENT, 'utf8');
    dest = path.join(tempRoot, 'shared-commands', 'inspect.md');
    await fs.mkdir(path.dirname(dest), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });



  it('副本与源一致 → removed，文件删除', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).resolves.toBe('removed');
    await expect(fs.access(dest)).rejects.toThrow();
  });

  it('副本被用户改写 → not-owned，文件保留并 warn', async () => {
    await fs.writeFile(dest, 'user rewrote', 'utf8');
    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).resolves.toBe('not-owned');
    expect(await fs.readFile(dest, 'utf8')).toBe('user rewrote');
    expect(mocks.logWarn.mock.calls.some((call) => String(call[0]).includes('not owned'))).toBe(true);
  });

  it('插件源文件缺失 → not-owned，文件保留', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    await fs.rm(path.join(sourceRoot, 'commands', 'inspect.md'));
    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).resolves.toBe('not-owned');
    expect(await fs.readFile(dest, 'utf8')).toBe(SOURCE_CONTENT);
  });

  it('副本本就不存在 → gone', async () => {
    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).resolves.toBe('gone');
  });

  it('commandPaths 缺对应项 → not-owned', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: [] }, 0, 'inspect')).resolves.toBe('not-owned');
    expect(await fs.readFile(dest, 'utf8')).toBe(SOURCE_CONTENT);
  });

  it('TOCTOU：读副本后、删除前用户在窗口内改写 → 校验不过不删，用户内容保留', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    mocks.afterDestRead = async (filePath) => {
      // 模块读完副本内容（一致）后、rename 隔离前，用户把同路径文件改写
      if (filePath === dest) {
        await fs.writeFile(dest, 'user rewrote in the toctou window', 'utf8');
      }
    };

    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).resolves.toBe('not-owned');

    expect(await fs.readFile(dest, 'utf8')).toBe('user rewrote in the toctou window');
    // 隔离文件不残留
    const siblings = await fs.readdir(path.dirname(dest));
    expect(siblings.filter((name) => name.includes('.neo-owncheck-'))).toEqual([]);
    expect(mocks.logWarn.mock.calls.some((call) => String(call[0]).includes('not owned'))).toBe(true);
  });

  it('隔离后 rm 失败 → 隔离文件 rename 回原路径，原始错误上抛，无隔离残留', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    mocks.failNextQuarantineRm = true;

    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).rejects.toThrow(/unlink/);

    expect(await fs.readFile(dest, 'utf8')).toBe(SOURCE_CONTENT);
    const siblings = await fs.readdir(path.dirname(dest));
    expect(siblings.filter((name) => name.includes('.neo-owncheck-'))).toEqual([]);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('隔离后 rm 失败且恢复 rename 也失败 → error 留痕，仍上抛原始 rm 错误', async () => {
    await fs.writeFile(dest, SOURCE_CONTENT, 'utf8');
    mocks.failNextQuarantineRm = true;
    mocks.failNextRestoreRename = true;

    await expect(removeCommandFileIfOwnedByPlugin(dest, { sourceRootDir: sourceRoot, commandPaths: ['commands/inspect.md'] }, 0, 'inspect')).rejects.toThrow(/unlink/);

    expect(
      mocks.logError.mock.calls.some((call) => String(call[0]).includes('restore quarantined command file')),
    ).toBe(true);
  });
});
