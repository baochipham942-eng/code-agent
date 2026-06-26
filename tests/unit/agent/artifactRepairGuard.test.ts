import { describe, expect, it } from 'vitest';
import {
  getArtifactRepairToolPolicy,
  seedArtifactRepairGuardFromContext,
} from '../../../src/host/agent/runtime/artifactRepairGuard';

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

  it('does not seed repair for fresh Chinese game generation that mentions failure state', () => {
    const ctx = makeRuntimeContext(
      '生成一个弹砖块游戏，包含胜利和失败状态，写到 /tmp/x.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toBeUndefined();
  });

  it('does not include a Chinese prefix when extracting a target path', () => {
    const ctx = makeRuntimeContext(
      '请修复当前 validator 失败，目标文件: 失败状态写到/tmp/x.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/x.html',
      phase: 'initial_repair',
    });
  });

  it('allows target file labels to name a relative artifact explicitly', () => {
    const ctx = makeRuntimeContext(
      'Artifact validation failed. Please repair target file: games/game.html because runSmokeTest is missing.',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
      phase: 'initial_repair',
    });
  });

  it('does not mis-extract a mid-token slash from a bare relative path', () => {
    // Regression: a bare relative path like `games/game.html` (no `target file:`
    // prefix, no `./` prefix) must not be matched by the no-prefix branch, which
    // used to latch onto the mid-token `/` and seed the guard with `/game.html`.
    const ctx = makeRuntimeContext(
      '修复 games/game.html 这个 HTML 游戏，artifact validation failed: runSmokeTest 未通过。',
    );

    seedArtifactRepairGuardFromContext(ctx);

    // No clear path prefix → guard is not seeded from this free text (the proper
    // triggers are an absolute/`./` path, a `target file:` label, or the
    // validation-failure path in toolExecutionEngine).
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

  it('does not seed repair on a URL-derived target from a web result (https://...)', () => {
    // Regression (2026-06-25 dogfood): a design/PPT run web-searched a CSDN page,
    // and the `://` in `https://modelengine.csdn.net/<id>.html` let the bare-path
    // branch latch onto the URL slash, seeding the guard with a phantom target
    // outside any workdir. Every later tool was then blocked → infinite deadlock.
    const ctx = makeRuntimeContext(
      'Artifact validation failed. The artifact at https://modelengine.csdn.net/690c4f2c5511483559e2a50c.html is missing runSmokeTest. Please repair it.',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toBeUndefined();
  });

  it('does not seed repair on a protocol-relative URL target (//host/x.html)', () => {
    const ctx = makeRuntimeContext(
      'Artifact validation failed: //modelengine.csdn.net/690c4f2c5511483559e2a50c.html is malformed; please fix.',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toBeUndefined();
  });

  it('still detects targeted issue codes but never narrows the repair tool set (Route A)', () => {
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

    // Route A: issue-code detection is kept, but the tool set never collapses to a
    // targeted/mutation-only subset. Bash is now allowed pre-patch too (relaxed
    // 2026-06-11: strong code models loop on the unavailable tool otherwise).
    const policy = getArtifactRepairToolPolicy(ctx.artifactRepairGuard);
    expect(policy?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(policy?.writeAllowed).toBe(true);
  });

  it('allows one complete Write during a pre-patch repair turn', () => {
    const ctx = makeRuntimeContext('Artifact validation failed for /tmp/code-agent/games/game.html. Please fix runSmokeTest.');

    seedArtifactRepairGuardFromContext(ctx);

    const policy = getArtifactRepairToolPolicy(ctx.artifactRepairGuard);
    expect(policy?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(policy?.writeAllowed).toBe(true);
  });

  it('keeps Bash available in the repair tool set both pre- and post-patch', () => {
    const ctx = makeRuntimeContext('Artifact validation failed for /tmp/code-agent/games/game.html. Please fix runSmokeTest.');

    seedArtifactRepairGuardFromContext(ctx);
    const prePatch = getArtifactRepairToolPolicy(ctx.artifactRepairGuard);
    expect(prePatch?.bashAllowed).toBe(true);

    ctx.artifactRepairGuard.patched = true;
    const postPatch = getArtifactRepairToolPolicy(ctx.artifactRepairGuard);
    expect(postPatch?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(postPatch?.bashAllowed).toBe(true);
  });
});
