// N-MEM-PROJECTKEY：resolveProjectMemoryKey 的仓库身份键行为 pin。
// 同仓 worktree 同键、非 git 目录回落规范化路径、不存在路径不抛错。
// N-MEM-KEYCACHE-BOUND：缓存容量上限（插入序淘汰）+ 回落值 TTL 过期的 pin。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { promisify } from 'node:util';

// 记录每次 execFile 的 options（按 cwd 归因），用于观察「是否重新解析」。
const execFileCalls = vi.hoisted(() => [] as Array<{ cwd?: string }>);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const customKey = Symbol.for('nodejs.util.promisify.custom');
  const realCustom = (actual.execFile as unknown as Record<symbol, (cmd: string, args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>>)[customKey];
  const spy = Object.assign(vi.fn(actual.execFile), {
    [customKey]: (cmd: string, args: string[], options: { cwd?: string }) => {
      execFileCalls.push(options);
      return realCustom(cmd, args, options);
    },
  });
  return { ...actual, execFile: spy };
});

vi.mock('../../../src/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants')>();
  return { ...actual, MEMORY: { ...actual.MEMORY, PROJECT_MEMORY_KEY_CACHE_MAX: 5 } };
});

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

  it('evicts the oldest entry once the cache exceeds its cap (N-MEM-KEYCACHE-BOUND)', async () => {
    // mock 帽=5：灌 6 条回落键后最旧的 plain-0 被淘汰，再解析它要重新起 git。
    const callsFor = (cwd: string) => execFileCalls.filter((c) => c.cwd === cwd).length;
    const dirs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const dir = path.join(tmpParent, `plain-${i}`);
      await fs.mkdir(dir, { recursive: true });
      dirs.push(dir);
    }
    for (const dir of dirs) await resolveProjectMemoryKey(dir);

    const before = callsFor(dirs[0]);
    await resolveProjectMemoryKey(dirs[0]);

    expect(callsFor(dirs[0])).toBeGreaterThan(before);
  });

  it('keeps hot entries from being evicted (LRU touch on hit)', async () => {
    // 先灌 plain-0，再灌 4 条把缓存顶到帽边；命中 plain-0 提位，
    // 再灌第 6 条时被淘汰的应是次旧的 plain-1 而不是 plain-0。
    const callsFor = (cwd: string) => execFileCalls.filter((c) => c.cwd === cwd).length;
    const dirs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const dir = path.join(tmpParent, `lru-${i}`);
      await fs.mkdir(dir, { recursive: true });
      dirs.push(dir);
    }
    for (const dir of dirs.slice(0, 5)) await resolveProjectMemoryKey(dir);
    await resolveProjectMemoryKey(dirs[0]); // 提位：lru-0 变最新
    const zeroBefore = callsFor(dirs[0]);
    const oneBefore = callsFor(dirs[1]);

    await resolveProjectMemoryKey(dirs[5]); // 触发淘汰
    await resolveProjectMemoryKey(dirs[0]);
    await resolveProjectMemoryKey(dirs[1]);

    expect(callsFor(dirs[0])).toBe(zeroBefore); // 仍命中
    expect(callsFor(dirs[1])).toBeGreaterThan(oneBefore); // 被淘汰后重新解析
  });

  it('re-resolves fallback entries after TTL but keeps git keys permanent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const callsFor = (cwd: string) => execFileCalls.filter((c) => c.cwd === cwd).length;

      const plain = path.join(tmpParent, 'ttl-plain');
      await fs.mkdir(plain, { recursive: true });
      await resolveProjectMemoryKey(plain);
      const plainFirst = callsFor(plain);
      await resolveProjectMemoryKey(plain);
      expect(callsFor(plain)).toBe(plainFirst); // TTL 内命中

      vi.advanceTimersByTime(61_000);
      await resolveProjectMemoryKey(plain);
      expect(callsFor(plain)).toBeGreaterThan(plainFirst); // 过期重新解析

      const repoDir = path.join(tmpParent, 'ttl-repo');
      await fs.mkdir(repoDir, { recursive: true });
      await git(['init', '-q'], repoDir);
      await resolveProjectMemoryKey(repoDir);
      const repoFirst = callsFor(repoDir);
      vi.advanceTimersByTime(24 * 3_600_000);
      await resolveProjectMemoryKey(repoDir);
      expect(callsFor(repoDir)).toBe(repoFirst); // git 键永久缓存
    } finally {
      vi.useRealTimers();
    }
  });
});
