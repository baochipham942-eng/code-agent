import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import type { ContextAssembly } from '../../../src/main/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/main/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';

const gameValidatorState = vi.hoisted(() => ({
  validateGameArtifact: vi.fn(),
}));

vi.mock('../../../src/main/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
}));

import { handleModifiedArtifactValidation } from '../../../src/main/agent/runtime/toolArtifactValidationLifecycle';

const TARGET_FILE = '/tmp/breakout.html';

function makeValidationResult() {
  return {
    shouldValidate: true,
    passed: true,
    isComplete: true,
    inferredKind: 'game',
    checks: [
      'breakout runtime initial start screen has brick targets',
      'browser Space launch moved ball from start state',
    ],
    failures: [],
    runtimeSmoke: { passed: true },
    browserVisualSmoke: { passed: true },
  };
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    workingDirectory: '/tmp',
    artifactRepairGuard: undefined,
    artifactValidationPassedTargetFile: undefined,
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,
    onEvent: vi.fn(),
    ...overrides,
  } as unknown as RuntimeContext;
}

function makeToolCall(): ToolCall {
  return {
    id: 'call_write_breakout',
    name: 'Write',
    arguments: {
      file_path: TARGET_FILE,
      content: '<!doctype html><html><body><canvas></canvas></body></html>',
    },
  };
}

function makeHarness(ctx: RuntimeContext) {
  const contextAssembly = {
    injectSystemMessage: vi.fn(),
  } as unknown as ContextAssembly;
  const runFinalizer = {
    emitTaskProgress: vi.fn(),
  } as unknown as RunFinalizer;
  const toolResult: ToolResult = {
    toolCallId: 'call_write_breakout',
    success: true,
    output: 'created',
  };

  return { contextAssembly, runFinalizer, toolResult };
}

describe('toolArtifactValidationLifecycle Xiaomi two-stage artifact flow', () => {
  beforeEach(() => {
    gameValidatorState.validateGameArtifact.mockReset();
    gameValidatorState.validateGameArtifact.mockResolvedValue(makeValidationResult());
  });

  it('requests a constrained enhancement pass after the Xiaomi breakout core validates', async () => {
    const goalMode = {
      isPending: vi.fn(() => true),
      requestCompletion: vi.fn(),
    };
    const ctx = makeCtx({
      goalMode: goalMode as never,
      xiaomiArtifactTwoStage: {
        targetFile: TARGET_FILE,
        kind: 'breakout',
        phase: 'core_pending',
      },
    });
    const { contextAssembly, runFinalizer, toolResult } = makeHarness(ctx);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer,
      toolCall: makeToolCall(),
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    expect(ctx.xiaomiArtifactTwoStage?.phase).toBe('enhance_pending');
    expect(ctx.artifactValidationPassedTargetFile).toBeUndefined();
    expect(goalMode.requestCompletion).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<xiaomi-artifact-enhancement stage="visual-polish">'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('__GAME_TEST__'),
    );
  });

  it('marks the two-stage flow done after the enhancement artifact validates', async () => {
    const ctx = makeCtx({
      xiaomiArtifactTwoStage: {
        targetFile: TARGET_FILE,
        kind: 'breakout',
        phase: 'enhance_pending',
      },
    });
    const { contextAssembly, runFinalizer, toolResult } = makeHarness(ctx);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer,
      toolCall: makeToolCall(),
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    expect(ctx.xiaomiArtifactTwoStage?.phase).toBe('done');
    expect(ctx.artifactValidationPassedTargetFile).toBe(TARGET_FILE);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed kind="interactive_artifact">'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('stage="xiaomi-core"'),
    );
  });
});
