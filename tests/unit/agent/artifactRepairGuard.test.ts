import { describe, expect, it } from 'vitest';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import {
  getArtifactRepairToolPolicy,
  seedArtifactRepairGuardFromContext,
} from '../../../src/host/agent/runtime/artifactRepairGuard';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { Message, ToolResult } from '../../../src/shared/contract';

function validatorFailureEnvelope(targetFile: string, extra = ''): string {
  return [
    '<artifact-validation-failed kind="interactive_artifact">',
    'attempts: 1',
    'repair phase: baseline_repair',
    `target file: ${targetFile}`,
    extra,
    '</artifact-validation-failed>',
  ].join('\n');
}

function makeRuntimeContext(
  content: string,
  options?: {
    role?: Message['role'];
    toolResults?: ToolResult[];
    extraMessages?: Message[];
    persistentSystemContext?: string[];
  },
): any {
  const role = options?.role ?? 'user';
  const message: Message = {
    id: 'msg-1',
    role,
    content,
    timestamp: Date.now(),
    ...(options?.toolResults ? { toolResults: options.toolResults } : {}),
  };
  return {
    workingDirectory: '/tmp/code-agent',
    messages: [...(options?.extraMessages ?? []), message],
    contextHealth: ContextHealthState.forTest({
      persistentSystemContext: options?.persistentSystemContext ?? [],
    } as never),
    artifact: ArtifactState.forTest(),
  };
}

function expectToolSurfaceUnnarrowed(ctx: { artifact: ArtifactState }): void {
  expect(ctx.artifact.repairGuard).toBeUndefined();
  expect(getArtifactRepairToolPolicy(ctx.artifact.repairGuard)).toBeNull();
}

const GENERIC_FAILURE_JOURNAL = [
  '# failure-journal',
  '',
  '上次修复失败：validator 报错，错误是 runSmokeTest 未通过，无法证明玩家真的通关。',
  '目标文件: /tmp/code-agent/games/breakout.html',
  '请继续修，把 __GAME_TEST__ / __INTERACTIVE_TEST__ 补上。',
].join('\n');

describe('artifactRepairGuard', () => {
  it('does not enter repair mode just because an artifact filename contains fixed', () => {
    const ctx = makeRuntimeContext(
      'Create a platformer at /tmp/code-agent/games/generated-platformer-regression-deepseek-fixed.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not seed repair for fresh Chinese game generation that mentions failure state', () => {
    const ctx = makeRuntimeContext(
      '生成一个弹砖块游戏，包含胜利和失败状态，写到 /tmp/x.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not narrow the tool surface after reading a generic-word document', () => {
    // Replay of 2026-09-06: an ordinary Q&A turn Reads failure-journal.md.
    // The dump contains 修复/错误/失败/无法 plus an HTML path — enough to
    // trip the old wording regex. The invariant is the tool surface stays open.
    const ctx = makeRuntimeContext(GENERIC_FAILURE_JOURNAL, {
      role: 'tool',
      extraMessages: [
        {
          id: 'user-meeting',
          role: 'user',
          content: '帮我查一下这个腾讯会议链接怎么加入，会议号在聊天记录里。',
          timestamp: Date.now(),
        },
        {
          id: 'assistant-read',
          role: 'assistant',
          content: '我先读一下相关笔记。',
          timestamp: Date.now(),
        },
      ],
    });

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not seed from a user asking to repair an HTML game', () => {
    const ctx = makeRuntimeContext(
      '请修复当前 validator 失败，目标文件: 失败状态写到/tmp/x.html',
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not seed from a Read dump that quotes a validator envelope', () => {
    const ctx = makeRuntimeContext(
      `# notes\n${validatorFailureEnvelope('/tmp/code-agent/games/quoted.html', 'runSmokeTest 未通过')}`,
      { role: 'tool' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not re-seed a guard for a target that already passed validation this run', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope('/tmp/x.html', '请修复当前 validator 失败，目标文件: 失败状态写到/tmp/x.html'),
      { role: 'system' },
    );
    // 同一 run 内该目标已通过验收（lifecycle 设置的通行标记）——
    // 不允许下一轮凭历史文本重新种 guard 进入幻影修复模式。
    ctx.artifact.setValidationPassed('/tmp/x.html');

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not include a Chinese prefix when extracting a target path', () => {
    const ctx = makeRuntimeContext(
      [
        '<artifact-validation-failed kind="interactive_artifact">',
        '请修复当前 validator 失败，目标文件: 失败状态写到/tmp/x.html',
        '</artifact-validation-failed>',
      ].join('\n'),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({
      targetFile: '/tmp/x.html',
      phase: 'initial_repair',
    });
  });

  it('allows target file labels to name a relative artifact explicitly', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope('games/game.html', 'runSmokeTest is missing.'),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({
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

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('seeds repair mode when the validator emits an artifact-validation-failed envelope', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope(
        '/tmp/code-agent/games/game.html',
        'Please fix the missing runSmokeTest evidence.',
      ),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
      phase: 'initial_repair',
    });
    expect(getArtifactRepairToolPolicy(ctx.artifact.repairGuard)?.allowedToolNames).toEqual([
      'Read',
      'Edit',
      'Write',
      'Append',
      'Bash',
    ]);
  });

  it('seeds from a tool result whose validator metadata says it failed', () => {
    const ctx = makeRuntimeContext('Artifact validation failed for /tmp/code-agent/games/game.html.', {
      role: 'tool',
      toolResults: [
        {
          toolCallId: 'write-1',
          success: false,
          error: 'Artifact validation failed for /tmp/code-agent/games/game.html.',
          metadata: {
            artifactValidation: { failed: true },
            artifactRepairRollback: { targetFile: '/tmp/code-agent/games/game.html' },
          },
        },
      ],
    });

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
    });
    expect(getArtifactRepairToolPolicy(ctx.artifact.repairGuard)).not.toBeNull();
  });

  it('does not seed repair on a URL-derived target from a web result (https://...)', () => {
    // Regression (2026-06-25 dogfood): a design/PPT run web-searched a CSDN page,
    // and the `://` in `https://modelengine.csdn.net/<id>.html` let the bare-path
    // branch latch onto the URL slash, seeding the guard with a phantom target
    // outside any workdir. Every later tool was then blocked → infinite deadlock.
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope(
        'https://modelengine.csdn.net/690c4f2c5511483559e2a50c.html',
        'The artifact is missing runSmokeTest. Please repair it.',
      ),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not seed repair on a protocol-relative URL target (//host/x.html)', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope(
        '//modelengine.csdn.net/690c4f2c5511483559e2a50c.html',
        'malformed; please fix.',
      ),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('still detects targeted issue codes but never narrows the repair tool set (Route A)', () => {
    const ctx = makeRuntimeContext(validatorFailureEnvelope(
      '/tmp/code-agent/games/game.html',
      [
        '交互测试合约没有形成可平衡解析的对象字面量；请修复 window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ 的结构。',
        'mobile visual smoke detected horizontal canvas overflow; the game is likely cropped in this viewport.',
      ].join('\n'),
    ), { role: 'system' });

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({
      targetFile: '/tmp/code-agent/games/game.html',
      activeIssueCodes: expect.arrayContaining(['malformed_test_contract', 'canvas_not_responsive']),
    });

    // Route A: issue-code detection is kept, but the tool set never collapses to a
    // targeted/mutation-only subset. Bash is now allowed pre-patch too (relaxed
    // 2026-06-11: strong code models loop on the unavailable tool otherwise).
    const policy = getArtifactRepairToolPolicy(ctx.artifact.repairGuard);
    expect(policy?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(policy?.writeAllowed).toBe(true);
  });

  it('allows one complete Write during a pre-patch repair turn', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope('/tmp/code-agent/games/game.html', 'Please fix runSmokeTest.'),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);

    const policy = getArtifactRepairToolPolicy(ctx.artifact.repairGuard);
    expect(policy?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(policy?.writeAllowed).toBe(true);
  });

  it('keeps Bash available in the repair tool set both pre- and post-patch', () => {
    const ctx = makeRuntimeContext(
      validatorFailureEnvelope('/tmp/code-agent/games/game.html', 'Please fix runSmokeTest.'),
      { role: 'system' },
    );

    seedArtifactRepairGuardFromContext(ctx);
    const prePatch = getArtifactRepairToolPolicy(ctx.artifact.repairGuard);
    expect(prePatch?.bashAllowed).toBe(true);

    ctx.artifact.repairGuard.patched = true;
    const postPatch = getArtifactRepairToolPolicy(ctx.artifact.repairGuard);
    expect(postPatch?.allowedToolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(postPatch?.bashAllowed).toBe(true);
  });
});
