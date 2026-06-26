import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { gitWorktreeModule } from '../../../../../src/host/tools/modules/shell/gitWorktree';

const execFileAsync = promisify(execFile);

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir,
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

describe('gitWorktreeModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-worktree-evidence-'));
    await git(tmpDir, ['init']);
    await git(tmpDir, ['config', 'user.email', 'test@example.com']);
    await git(tmpDir, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'one\n', 'utf-8');
    await git(tmpDir, ['add', 'a.txt']);
    await git(tmpDir, ['commit', '-m', 'initial']);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns structured worktrees and process-output artifact for list', async () => {
    const handler = await gitWorktreeModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        action: 'list',
        count: 1,
      });
      expect(result.meta?.worktrees).toEqual([
        expect.objectContaining({ path: await fs.realpath(tmpDir), head: expect.any(String), branch: expect.any(String) }),
      ]);
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-output',
        sourceTool: 'git_worktree',
        metadata: {
          action: 'list',
          count: 1,
        },
      });
    }
  });
});
