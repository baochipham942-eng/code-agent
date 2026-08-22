import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackFileMutationSideEffects } from '../../../src/host/agent/runtime/toolFileMutationTracking';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

describe('trackFileMutationSideEffects', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('discovers a file written by Bash and records it in the shared mutation tracker', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'turn-diff-bash-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('bash', [
      '-lc',
      'for n in $(seq 1 3); do printf "bash line %s\\n" "$n"; done > "$1"',
      'bash',
      join(repo, 'bash-output.txt'),
    ]);

    const trackedFiles: string[] = [];
    await trackFileMutationSideEffects({
      ctx: {
        workingDirectory: repo,
        nudgeManager: { trackModifiedFile: (filePath: string) => trackedFiles.push(filePath) },
        artifact: ArtifactState.forTest(),
      } as any,
      toolCall: {
        id: 'tool-bash',
        name: 'Bash',
        arguments: { command: 'write bash-output.txt' },
      },
      normalizedResult: { success: true, result: 'ok' } as any,
      toolResult: { toolCallId: 'tool-bash', success: true, duration: 1 },
    });

    expect(trackedFiles).toContain(join(await realpath(repo), 'bash-output.txt'));
  });

  it('clears the blocked-tool repair counter after a successful target file mutation', async () => {
    const trackedFiles: string[] = [];
    const ctx: any = {
      workingDirectory: '/repo/app',
      nudgeManager: {
        trackModifiedFile: (filePath: string) => trackedFiles.push(filePath),
      },
      artifact: ArtifactState.forTest({
        repairGuard: {
        targetFile: '/repo/app/game.html',
        attempts: 1,
        phase: 'targeted_repair',
        noProgressTurns: 3,
      },
      }),
      onEvent: vi.fn(),
    };

    await trackFileMutationSideEffects({
      ctx,
      toolCall: {
        id: 'tool-1',
        name: 'Write',
        arguments: {
          path: '/repo/app/game.html',
          content: '<html></html>',
        },
      },
      normalizedResult: { success: true, result: 'Updated file: /repo/app/game.html' } as any,
      toolResult: {
        toolCallId: 'tool-1',
        success: true,
        duration: 1,
      },
    });

    expect(trackedFiles).toEqual(['/repo/app/game.html']);
    expect(ctx.artifact.repairGuard.patched).toBe(true);
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(0);
  });
});
