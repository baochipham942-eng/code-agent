import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-040 C2a：pdftoppm 解析顺序。
//
// 守的是「随包的 poppler 必须优先于系统 PATH」。这条不守住，最直接的后果不是崩，
// 而是**开发机上永远看不到用户的处境**——开发机装了 brew poppler，怎么测都是好的；
// 用户机没有，整份 deck 退到 qlmanage 只出 1 张缩略图，第 2 页起选不了。
//
// resolveHelperBinary 找不到时返回候选列表的第一项（一个不存在的路径）而不是 null
// （runtimeAssetResolver.ts firstExisting），所以调用方的 existsSync 检查是承重的，
// 这里一并钉住——去掉它，随包缺席时会拿一个不存在的路径去执行。

const execSyncMock = vi.hoisted(() => vi.fn());
const resolveHelperBinaryMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ execSync: execSyncMock }));
vi.mock('../../../../../../src/host/runtime/runtimeAssetResolver', () => ({
  resolveHelperBinary: resolveHelperBinaryMock,
}));

let workDir: string;
let bundledPath: string;

beforeEach(() => {
  execSyncMock.mockReset();
  resolveHelperBinaryMock.mockReset();
  workDir = mkdtempSync(join(tmpdir(), 'pdftoppm-resolve-'));
  bundledPath = join(workDir, 'poppler', 'bin', 'pdftoppm');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function createBundled(): void {
  mkdirSync(join(workDir, 'poppler', 'bin'), { recursive: true });
  writeFileSync(bundledPath, '#!/bin/sh\n');
}

async function resolve(): Promise<string | null> {
  const { resolvePdftoppm } = await import('../../../../../../src/host/tools/media/ppt/visualReview');
  return resolvePdftoppm();
}

describe('resolvePdftoppm：随包优先于系统 PATH', () => {
  it('随包 sidecar 存在 → 返回随包那份，且不问系统 PATH', async () => {
    createBundled();
    resolveHelperBinaryMock.mockReturnValue(bundledPath);

    expect(await resolve()).toBe(bundledPath);
    // 命中随包时不该再 which——开发机上 which 会命中 brew 的那份，
    // 用它就等于永远测不到用户的处境
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('查的是 poppler/bin/pdftoppm 这个相对位置（与 fetch-poppler.sh 的产出对齐）', async () => {
    createBundled();
    resolveHelperBinaryMock.mockReturnValue(bundledPath);
    await resolve();

    expect(resolveHelperBinaryMock).toHaveBeenCalledWith(join('poppler', 'bin', 'pdftoppm'));
  });

  it('随包缺席（resolveHelperBinary 返回不存在的路径）→ 回落系统 PATH', async () => {
    resolveHelperBinaryMock.mockReturnValue(join(workDir, 'nonexistent', 'pdftoppm'));
    execSyncMock.mockReturnValue('/usr/local/bin/pdftoppm\n');

    expect(await resolve()).toBe('/usr/local/bin/pdftoppm');
    expect(String(execSyncMock.mock.calls[0][0])).toBe('which pdftoppm');
  });

  it('随包和系统都没有 → 返回 null（让降级链继续，不是抛错）', async () => {
    resolveHelperBinaryMock.mockReturnValue(join(workDir, 'nonexistent', 'pdftoppm'));
    execSyncMock.mockImplementation(() => { throw new Error('not found'); });

    expect(await resolve()).toBeNull();
  });

  it('系统 which 返回空串 → 返回 null，不返回空路径', async () => {
    resolveHelperBinaryMock.mockReturnValue(join(workDir, 'nonexistent', 'pdftoppm'));
    execSyncMock.mockReturnValue('\n');

    expect(await resolve()).toBeNull();
  });
});
