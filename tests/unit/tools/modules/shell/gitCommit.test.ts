import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { gitCommitModule } from '../../../../../src/host/tools/modules/shell/gitCommit';

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

describe('gitCommitModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-evidence-'));
    await git(tmpDir, ['init']);
    await git(tmpDir, ['config', 'user.email', 'test@example.com']);
    await git(tmpDir, ['config', 'user.name', 'Test User']);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports dirty status with changedFiles and branch', async () => {
    await fs.writeFile(path.join(tmpDir, 'new.txt'), 'hello\n', 'utf-8');
    const handler = await gitCommitModule.createHandler();
    const result = await handler.execute({ action: 'status' }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        action: 'status',
        status: 'dirty',
        clean: false,
        untracked: 1,
        changedFiles: ['new.txt'],
      });
      expect(typeof result.meta?.branch).toBe('string');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-output',
        sourceTool: 'git_commit',
        metadata: expect.objectContaining({
          action: 'status',
          status: 'dirty',
          clean: false,
        }),
      });
    }
  });

  it('reports commit hash, branch, and status after commit', async () => {
    await fs.writeFile(path.join(tmpDir, 'new.txt'), 'hello\n', 'utf-8');
    await git(tmpDir, ['add', 'new.txt']);

    const handler = await gitCommitModule.createHandler();
    const result = await handler.execute({ action: 'commit', message: 'add new' }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        action: 'commit',
        amend: false,
        message: 'add new',
        status: 'committed',
      });
      expect(result.meta?.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof result.meta?.branch).toBe('string');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-output',
        sourceTool: 'git_commit',
        metadata: expect.objectContaining({
          action: 'commit',
          status: 'committed',
        }),
      });
    }
  });
});
