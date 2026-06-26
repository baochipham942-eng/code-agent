import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { gitDiffModule } from '../../../../../src/host/tools/modules/shell/gitDiff';

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

describe('gitDiffModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-diff-evidence-'));
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

  it('adds changedFiles, diff summary, and virtual artifact for unstaged diff', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'one\ntwo\n', 'utf-8');
    const handler = await gitDiffModule.createHandler();
    const result = await handler.execute({ action: 'diff' }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('diff --git');
      expect(result.meta).toMatchObject({
        action: 'diff',
        type: 'unstaged',
        changedFiles: ['a.txt'],
        diffSummary: {
          files: ['a.txt'],
          fileCount: 1,
          additions: 1,
          deletions: 0,
          hunks: 1,
          truncated: false,
        },
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'git_diff',
        mimeType: 'text/x-diff',
        metadata: {
          type: 'unstaged',
        },
      });
    }
  });

  it('adds commitHash and artifact for show', async () => {
    const handler = await gitDiffModule.createHandler();
    const result = await handler.execute({ action: 'show', stat_only: true }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.type).toBe('show');
      expect(result.meta?.commit).toBe('HEAD');
      expect(result.meta?.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-output',
        sourceTool: 'git_diff',
      });
    }
  });
});
