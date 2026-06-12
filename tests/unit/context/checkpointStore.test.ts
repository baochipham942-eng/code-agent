import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeCheckpointFile } from '../../../src/main/context/checkpoint';

describe('writeCheckpointFile cross-device fallback (audit C-M4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to copy+unlink when rename throws EXDEV', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ckpt-store-'));
    const target = path.join(dir, 'checkpoint.md');
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(exdev);

    await writeCheckpointFile(target, 'content-after-exdev');

    expect(renameSpy).toHaveBeenCalled();
    expect(await readFile(target, 'utf-8')).toBe('content-after-exdev');
    // tmp 文件不能残留
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('rethrows non-EXDEV rename failures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ckpt-store-'));
    const target = path.join(dir, 'checkpoint.md');
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(eperm);

    await expect(writeCheckpointFile(target, 'x')).rejects.toThrow('EPERM');
    await rm(dir, { recursive: true, force: true });
  });
});
