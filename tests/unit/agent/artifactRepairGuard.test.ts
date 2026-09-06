import { describe, expect, it, vi } from 'vitest';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import {
  ARTIFACT_REPAIR_GUARD_SEED_MESSAGE_WINDOW,
  getArtifactRepairToolPolicy,
  seedArtifactRepairGuardFromContext,
} from '../../../src/host/agent/runtime/artifactRepairGuard';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { Message, ToolResult } from '../../../src/shared/contract';

const gameValidatorState = vi.hoisted(() => ({
  validateGameArtifact: vi.fn(),
}));

vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
}));

import { handleModifiedArtifactValidation } from '../../../src/host/agent/runtime/toolArtifactValidationLifecycle';

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

function validatorPassedEnvelope(extra = ''): string {
  // Production pass envelopes often omit `target file:`. The cross-run
  // exclusion must still retire the most recent open failure.
  return [
    '<artifact-validation-passed kind="interactive_artifact">',
    'The artifact already passed validation. Do not rewrite it again.',
    extra,
    '1. runSmokeTest passed',
    '</artifact-validation-passed>',
  ].join('\n');
}

function ordinaryMessage(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Date.now() };
}

function makeFreshRunFromHistory(messages: Message[]): any {
  return {
    workingDirectory: '/tmp/code-agent',
    messages,
    contextHealth: ContextHealthState.forTest({
      persistentSystemContext: [],
    } as never),
    artifact: ArtifactState.forTest(),
  };
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

// —— 真实链路构造（R2 返修）——
// 跨轮用例的历史不允许手写通过信封/手抄 metadata：生产的通过信封走
// injectSystemMessage 只进内存不落库，跨会话唯一的"通过"记录是 lifecycle
// 成功分支写进 tool result 的元数据（随 tool message 落库）。这里对失败与
// 通过两侧都真调生产 handleModifiedArtifactValidation（仅 mock 校验器本体），
// 产出 messageProcessor 会持久化的 tool result 形态。
function failingGameValidation(): Record<string, unknown> {
  return {
    shouldValidate: true,
    inferredKind: 'game',
    isComplete: true,
    passed: false,
    failures: ['交互测试合约缺少 start()，验收无法从真实初始状态启动产物。'],
    checks: ['detected game artifact with interactive delivery surface'],
  };
}

function passingGameValidation(): Record<string, unknown> {
  return {
    shouldValidate: true,
    inferredKind: 'game',
    isComplete: true,
    passed: true,
    failures: [],
    checks: [
      'detected game artifact with interactive delivery surface',
      'html document looks complete',
    ],
  };
}

async function runLifecycleValidation(options: {
  toolCallId: string;
  toolName: 'Write' | 'Edit';
  filePath: string;
  validation: Record<string, unknown>;
  ctx?: ReturnType<typeof makeLifecycleCtx>;
}): Promise<{ ctx: ReturnType<typeof makeLifecycleCtx>; toolResult: ToolResult }> {
  gameValidatorState.validateGameArtifact.mockReset();
  gameValidatorState.validateGameArtifact.mockResolvedValue(options.validation);
  const ctx = options.ctx ?? makeLifecycleCtx();
  const toolResult: ToolResult = { toolCallId: options.toolCallId, success: true, output: 'ok' };
  await handleModifiedArtifactValidation({
    ctx,
    contextAssembly: { injectSystemMessage: vi.fn() } as never,
    runFinalizer: { emitTaskProgress: vi.fn() } as never,
    toolCall: {
      id: options.toolCallId,
      name: options.toolName,
      arguments: { file_path: options.filePath, content: '<!doctype html><html></html>' },
    },
    normalizedSuccess: true,
    toolResult,
    artifactRepairRollbackSnapshot: null,
  });
  return { ctx, toolResult };
}

function makeLifecycleCtx(): any {
  return {
    workingDirectory: '/tmp/code-agent',
    artifact: ArtifactState.forTest(),
    onEvent: vi.fn(),
  };
}

// messageProcessor 落库的 tool message 形态（messageProcessor.ts：content =
// JSON.stringify(toolResults)，toolResults 原样随消息持久化）。
function persistedToolMessage(id: string, toolResult: ToolResult): Message {
  return {
    id,
    role: 'tool',
    content: JSON.stringify([toolResult]),
    timestamp: Date.now(),
    toolResults: [toolResult],
  };
}

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

  it('does not re-seed a repaired target on a later run that only reads a document', async () => {
    // Cross-run shape: each agentLoop constructs a new ArtifactState, but
    // session messages are preserved. this-run validationPassedTargetFile
    // is empty, so exclusion must come from history, not ArtifactState.
    // R2：历史改由真实生产链路构造——失败与通过两侧都真调
    // handleModifiedArtifactValidation（仅 mock 校验器），tool result 以
    // messageProcessor 落库形态进入历史。不手工塞通过信封（生产里它不落库）。
    const targetFile = '/tmp/code-agent/games/breakout.html';

    // 同一 run：Write 校验失败（guard 就地种上）→ Edit 修复后通过（guard 清掉）。
    const failStage = await runLifecycleValidation({
      toolCallId: 'call-write-fail',
      toolName: 'Write',
      filePath: targetFile,
      validation: failingGameValidation(),
    });
    expect(failStage.toolResult.metadata?.artifactValidation).toMatchObject({ failed: true });
    expect(failStage.ctx.artifact.repairGuard?.targetFile).toBe(targetFile);

    const passStage = await runLifecycleValidation({
      toolCallId: 'call-edit-pass',
      toolName: 'Edit',
      filePath: targetFile,
      validation: passingGameValidation(),
      ctx: failStage.ctx,
    });
    // 落库前提：通过状态真的写进了会持久化的 tool result（失败侧同路径落库）。
    expect(passStage.toolResult.metadata?.artifactValidation).toMatchObject({
      failed: false,
      passed: true,
      targetFile,
    });
    expect(passStage.ctx.artifact.repairGuard).toBeUndefined();

    // 新 run：全新 ArtifactState，历史只含真实持久化消息（重开会话从 DB 读回）。
    const ctx = makeFreshRunFromHistory([
      persistedToolMessage('tool-write-fail', failStage.toolResult),
      persistedToolMessage('tool-edit-pass', passStage.toolResult),
      ordinaryMessage('user-chat-1', 'user', '好了，游戏能玩了。'),
      ordinaryMessage('asst-chat-1', 'assistant', '好的，有需要再叫我。'),
      ordinaryMessage('user-chat-2', 'user', '帮我查一下这个腾讯会议链接怎么加入，会议号在聊天记录里。'),
      ordinaryMessage('asst-read', 'assistant', '我先读一下相关笔记。'),
      {
        id: 'tool-read',
        role: 'tool',
        content: GENERIC_FAILURE_JOURNAL,
        timestamp: Date.now(),
      },
    ]);

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('retires an open failure via an in-run pass envelope in the message window', () => {
    // in-run 形态（区别于跨轮历史）：lifecycle 的通过信封经 injectSystemMessage 进
    // 内存消息 / persistentSystemContext 块，当前 run 内的扫描仍要能靠它排除已
    // 解决目标。跨会话的"通过"记录另走 tool result 落库（见上一用例）。
    const targetFile = '/tmp/code-agent/games/breakout.html';
    const ctx = makeFreshRunFromHistory([
      ordinaryMessage('fail-1', 'system', validatorFailureEnvelope(targetFile, 'runSmokeTest 未通过')),
      ordinaryMessage('pass-1', 'system', validatorPassedEnvelope()),
      ordinaryMessage('user-chat-1', 'user', '好了，游戏能玩了。'),
    ]);

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('does not seed a validator failure that has aged out of the message window', () => {
    const targetFile = '/tmp/code-agent/games/game.html';
    const fillers = Array.from(
      { length: ARTIFACT_REPAIR_GUARD_SEED_MESSAGE_WINDOW },
      (_, index) => ordinaryMessage(`filler-${index}`, 'user', `普通追问 ${index}`),
    );
    const ctx = makeFreshRunFromHistory([
      ordinaryMessage('stale-fail', 'system', validatorFailureEnvelope(targetFile, 'runSmokeTest 未通过')),
      ...fillers,
    ]);

    seedArtifactRepairGuardFromContext(ctx);

    expectToolSurfaceUnnarrowed(ctx);
  });

  it('still seeds a validator failure that remains inside the message window', () => {
    const targetFile = '/tmp/code-agent/games/game.html';
    const fillers = Array.from(
      { length: ARTIFACT_REPAIR_GUARD_SEED_MESSAGE_WINDOW - 1 },
      (_, index) => ordinaryMessage(`filler-${index}`, 'user', `普通追问 ${index}`),
    );
    const ctx = makeFreshRunFromHistory([
      ordinaryMessage('recent-fail', 'system', validatorFailureEnvelope(targetFile, 'runSmokeTest 未通过')),
      ...fillers,
    ]);

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({ targetFile });
    expect(getArtifactRepairToolPolicy(ctx.artifact.repairGuard)).not.toBeNull();
  });

  it('still seeds a later validator failure after an earlier pass for the same target', async () => {
    // R2：通过记录用真实落库形态（lifecycle 成功分支写进 tool result 的元数据），
    // 不再用手工通过信封。通过后同目标再次失败 ⇒ 仍要种 guard。
    const targetFile = '/tmp/code-agent/games/game.html';
    const failOld = await runLifecycleValidation({
      toolCallId: 'call-write-fail-old',
      toolName: 'Write',
      filePath: targetFile,
      validation: failingGameValidation(),
    });
    const passOld = await runLifecycleValidation({
      toolCallId: 'call-edit-pass-old',
      toolName: 'Edit',
      filePath: targetFile,
      validation: passingGameValidation(),
      ctx: failOld.ctx,
    });
    const failNew = await runLifecycleValidation({
      toolCallId: 'call-edit-fail-new',
      toolName: 'Edit',
      filePath: targetFile,
      validation: failingGameValidation(),
    });

    const ctx = makeFreshRunFromHistory([
      persistedToolMessage('tool-fail-old', failOld.toolResult),
      persistedToolMessage('tool-pass-old', passOld.toolResult),
      persistedToolMessage('tool-fail-new', failNew.toolResult),
    ]);

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifact.repairGuard).toMatchObject({ targetFile });
  });
});
