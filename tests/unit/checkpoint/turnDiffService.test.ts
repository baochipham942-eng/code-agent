import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTurnDiff } from '../../../src/host/services/checkpoint/turnDiffService';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  }).trim();
}

describe('captureTurnDiff path normalization', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'turn-diff-realpath-'));
    tempDirs.push(repo);
    git(repo, ['init', '-q']);
    await writeFile(join(repo, 'tracked.txt'), 'before\n', 'utf8');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
    return repo;
  }

  it('captures a new file when macOS Git canonicalizes /var to /private/var', async () => {
    const lexicalRepo = await makeRepo();
    const canonicalRepo = await realpath(lexicalRepo);
    const modifiedPath = join(lexicalRepo, 'generated.txt');
    await writeFile(modifiedPath, 'line 1\nline 2\n', 'utf8');

    const gitRepoRoot = git(lexicalRepo, ['rev-parse', '--show-toplevel']);
    expect(gitRepoRoot).toBe(canonicalRepo);
    if (process.platform === 'darwin') {
      expect(lexicalRepo).toMatch(/^\/var\/folders\//);
      expect(gitRepoRoot).toMatch(/^\/private\/var\/folders\//);
    }

    const result = await captureTurnDiff(lexicalRepo, 'turn-macos-realpath', [modifiedPath]);

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]).toMatchObject({
      filePath: await realpath(modifiedPath),
      isNewFile: true,
      added: 2,
      removed: 0,
    });
  });

  it('preserves ordinary same-root tracked-file behavior', async () => {
    const repo = await makeRepo();
    const trackedPath = join(repo, 'tracked.txt');
    await writeFile(trackedPath, 'after\n', 'utf8');

    const result = await captureTurnDiff(repo, 'turn-same-root', [trackedPath]);

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]).toMatchObject({
      filePath: await realpath(trackedPath),
      oldText: 'before\n',
      newText: 'after\n',
      isNewFile: false,
      added: 1,
      removed: 1,
    });
  });

  it('does not throw when a candidate path does not exist', async () => {
    const repo = await makeRepo();
    const missingPath = join(repo, 'missing.txt');

    await expect(captureTurnDiff(repo, 'turn-missing', [missingPath])).resolves.toEqual({
      turnId: 'turn-missing',
      files: [],
    });
  });
});
