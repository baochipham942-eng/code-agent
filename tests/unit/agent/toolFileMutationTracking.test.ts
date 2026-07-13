import { describe, expect, it, vi } from 'vitest';
import { trackFileMutationSideEffects } from '../../../src/host/agent/runtime/toolFileMutationTracking';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

vi.mock('../../../src/host/services/diff/diffTracker', () => ({
  getDiffTracker: () => ({
    computeAndStore: vi.fn(),
  }),
}));

describe('trackFileMutationSideEffects', () => {
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
        blockedToolTurnsWithoutProgress: 3,
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
    expect(ctx.artifact.repairGuard.blockedToolTurnsWithoutProgress).toBe(0);
  });
});
