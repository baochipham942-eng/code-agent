// N-MEM-PROJECTKEY：resolveProjectMemoryKey 的仓库身份键行为 pin。
// 同仓 worktree 同键、非 git 目录回落规范化路径、不存在路径不抛错。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { promisify } from 'node:util';
import { resolveProjectMemoryKey } from '../../../src/host/memory/projectMemoryKey';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('resolveProjectMemoryKey', () => {
  let tmpParent: string;

  beforeEach(async () => {
    tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-memory-key-'));
  });

  afterEach(async () => {
    await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it('resolves two worktrees of one git repo to the same memory key', async () => {
    const repoDir = path.join(tmpParent, 'repo');
    const worktreeDir = path.join(tmpParent, 'repo-wt');
    await fs.mkdir(repoDir, { recursive: true });
    await git(['init', '-q'], repoDir);
    await git(['-c', 'user.email=mem@test', '-c', 'user.name=mem', 'commit', '-q', '--allow-empty', '-m', 'init'], repoDir);
    await git(['worktree', 'add', '-q', '--detach', worktreeDir], repoDir);

    const repoKey = await resolveProjectMemoryKey(repoDir);
    const worktreeKey = await resolveProjectMemoryKey(worktreeDir);

    expect(worktreeKey).toBe(repoKey);
  });

  it('keeps subdirectories of the same repo isolated (PR#2177 ai-review Important)', async () => {
    // 裸 common-dir 键会让同仓子目录（dotfiles 仓下的项目、monorepo 的 packages/a 与 b）
    // 共享一个记忆分区串味；键必须带仓内相对路径。
    const repoDir = path.join(tmpParent, 'mono');
    const pkgA = path.join(repoDir, 'packages', 'a');
    const pkgB = path.join(repoDir, 'packages', 'b');
    await fs.mkdir(pkgA, { recursive: true });
    await fs.mkdir(pkgB, { recursive: true });
    await git(['init', '-q'], repoDir);

    const rootKey = await resolveProjectMemoryKey(repoDir);
    const keyA = await resolveProjectMemoryKey(pkgA);
    const keyB = await resolveProjectMemoryKey(pkgB);

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(rootKey);
  });

  it('gives unrelated repos different memory keys', async () => {
    const repoA = path.join(tmpParent, 'repo-a');
    const repoB = path.join(tmpParent, 'repo-b');
    for (const dir of [repoA, repoB]) {
      await fs.mkdir(dir, { recursive: true });
      await git(['init', '-q'], dir);
    }

    expect(await resolveProjectMemoryKey(repoA)).not.toBe(await resolveProjectMemoryKey(repoB));
  });

  it('falls back to the canonicalised path for a plain non-git directory', async () => {
    const plainDir = path.join(tmpParent, 'plain');
    await fs.mkdir(plainDir, { recursive: true });

    const key = await resolveProjectMemoryKey(plainDir);

    expect(key).toBe(await fs.realpath(plainDir));
  });

  it('never throws for a nonexistent path', async () => {
    const missing = path.join(tmpParent, 'does-not-exist');

    const key = await resolveProjectMemoryKey(missing);

    // 已存在的祖先解析符号链接（macOS /var→/private/var），不存在的尾段原样保留。
    expect(key).toBe(path.join(await fs.realpath(tmpParent), 'does-not-exist'));
  });
});
