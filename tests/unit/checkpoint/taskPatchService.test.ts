// ============================================================================
// taskPatchService —— 任务取消/丢弃前的 workspace patch 快照
// 真实 git fixture + 真实 FS。getUserConfigDir 被 mock 到临时目录，避免污染 ~/.code-agent。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// getUserConfigDir 指向临时目录（patch 落到 <tmp>/trashed-task-patches/）
const cfgState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/host/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/config/configPaths')>(
    '../../../src/host/config/configPaths'
  );
  return {
    ...actual,
    getUserConfigDir: () => cfgState.dir,
  };
});

import {
  captureWorkspacePatch,
  getTrashedPatchDir,
} from '../../../src/host/services/checkpoint/taskPatchService';

function git(repo: string, args: string): void {
  execSync(`git ${args}`, {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpatch-repo-'));
  git(repo, 'init -q');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
  git(repo, 'add tracked.txt');
  git(repo, 'commit -q -m init');
  return repo;
}

describe('taskPatchService.captureWorkspacePatch', () => {
  let repo: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    cfgState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpatch-cfg-'));
    cleanup.push(cfgState.dir);
    repo = makeRepo();
    cleanup.push(repo);
  });

  afterEach(() => {
    while (cleanup.length) {
      const p = cleanup.pop()!;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('① tracked 改动进 patch', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\nmodified line\n');

    const out = await captureWorkspacePatch(repo, 'task-1', 'cancel');

    expect(out).toBeTruthy();
    const content = fs.readFileSync(out!, 'utf-8');
    expect(content).toContain('diff --git');
    expect(content).toContain('tracked.txt');
    expect(content).toContain('modified line');
    // 头部元信息
    expect(content).toContain('# taskId: task-1');
    expect(content).toContain('# reason: cancel');
  });

  it('② untracked 文件进 patch', async () => {
    fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'fresh content\n');

    const out = await captureWorkspacePatch(repo, 'task-2', 'delete');

    expect(out).toBeTruthy();
    const content = fs.readFileSync(out!, 'utf-8');
    expect(content).toContain('brand-new.txt');
    expect(content).toContain('fresh content');
  });

  it('③ 无任何改动时返回 null、不写空文件', async () => {
    const out = await captureWorkspacePatch(repo, 'task-3', 'cancel');
    expect(out).toBeNull();
    // 目录可能根本没被创建，或为空
    const dir = getTrashedPatchDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files.length).toBe(0);
  });

  it('④ 非 git 目录返回 null、不抛错', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpatch-plain-'));
    cleanup.push(plain);
    fs.writeFileSync(path.join(plain, 'foo.txt'), 'x');

    const out = await captureWorkspacePatch(plain, 'task-4', 'worktree-cleanup');
    expect(out).toBeNull();
  });

  it('⑤ 生成的 patch 能被 git apply 还原（tracked + untracked）', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\nappended\n');
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new file body\n');

    const out = await captureWorkspacePatch(repo, 'task-5', 'cancel');
    expect(out).toBeTruthy();

    // 在一个干净的 clone 上验证 patch 可 apply
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpatch-clone-'));
    cleanup.push(clone);
    execSync(`git clone -q '${repo}' '${clone}'`, { stdio: 'pipe' });
    // clone 自带初始 commit（tracked.txt=original），尚未含本次改动
    git(clone, `apply '${out}'`);

    expect(fs.readFileSync(path.join(clone, 'tracked.txt'), 'utf-8')).toContain('appended');
    expect(fs.existsSync(path.join(clone, 'added.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(clone, 'added.txt'), 'utf-8')).toContain('new file body');
  });

  it('⑥ 不存在的目录返回 null、不抛错', async () => {
    const out = await captureWorkspacePatch(
      path.join(os.tmpdir(), 'definitely-not-here-xyz'),
      'task-6',
      'delete'
    );
    expect(out).toBeNull();
  });
});
