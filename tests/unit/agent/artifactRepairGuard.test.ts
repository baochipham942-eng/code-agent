import { describe, expect, it } from 'vitest';
import { seedArtifactRepairGuardFromContext } from '../../../src/main/agent/runtime/artifactRepairGuard';

function makeRuntimeContext(content: string): any {
  return {
    workingDirectory: '/tmp/code-agent',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    ],
    persistentSystemContext: [],
  };
}

describe('artifactRepairGuard', () => {
  it('does not enter repair mode just because an artifact filename contains fixed', () => {
    const ctx = makeRuntimeContext(
      'Create a platformer at /tmp/code-agent/games/generated-platformer-regression-deepseek-fixed.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toBeUndefined();
  });

  it('seeds repair mode when an actual artifact validation failure names a target file', () => {
    const ctx = makeRuntimeContext(
      'Artifact validation failed for /tmp/code-agent/games/game.html. Please fix the missing runSmokeTest evidence.',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
      phase: 'initial_repair',
    });
  });
});
