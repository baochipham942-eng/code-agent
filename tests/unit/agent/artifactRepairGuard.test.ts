import { describe, expect, it } from 'vitest';
import {
  getArtifactRepairToolPolicy,
  seedArtifactRepairGuardFromContext,
} from '../../../src/main/agent/runtime/artifactRepairGuard';

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

  it('treats malformed contract and mobile canvas crop failures as targeted repairs', () => {
    const ctx = makeRuntimeContext([
      'Artifact validation failed for /tmp/code-agent/games/game.html.',
      '交互测试合约没有形成可平衡解析的对象字面量；请修复 window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ 的结构。',
      'mobile visual smoke detected horizontal canvas overflow; the game is likely cropped in this viewport.',
    ].join('\n'));

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
      activeIssueCodes: expect.arrayContaining(['malformed_test_contract', 'canvas_not_responsive']),
    });

    ctx.artifactRepairGuard.targetReadCount = 10;
    ctx.artifactRepairGuard.targetRangedReadCount = 0;

    const policy = getArtifactRepairToolPolicy(ctx.artifactRepairGuard);
    expect(policy?.allowedToolNames).toEqual(['Read', 'Edit', 'Append']);
    expect(policy?.writePriority).toBe(false);
  });
});
