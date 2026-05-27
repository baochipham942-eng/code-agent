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

const TARGET_FILE = '/tmp/interactive-artifact-5.html';

// 普通网页 / 交互产物:不是游戏,没有 __GAME_TEST__ 合约 → 轻校验判定 shouldValidate=false。
function makePlainArtifactProbe() {
  return {
    shouldValidate: false,
    passed: false,
    isComplete: true,
    inferredKind: 'unknown',
    checks: [],
    failures: [],
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

function makeToolCall(filePath = TARGET_FILE): ToolCall {
  return {
    id: 'call_write_todo',
    name: 'Write',
    arguments: {
      file_path: filePath,
      content: '<!doctype html><html><body><ul id="list"></ul><script>localStorage</script></body></html>',
    },
  };
}

function makeHarness() {
  const contextAssembly = { injectSystemMessage: vi.fn() } as unknown as ContextAssembly;
  const runFinalizer = { emitTaskProgress: vi.fn() } as unknown as RunFinalizer;
  const toolResult: ToolResult = { toolCallId: 'call_write_todo', success: true, output: 'created' };
  return { contextAssembly, runFinalizer, toolResult };
}

describe('toolArtifactValidationLifecycle plain (non-game) artifact completion', () => {
  beforeEach(() => {
    gameValidatorState.validateGameArtifact.mockReset();
    gameValidatorState.validateGameArtifact.mockResolvedValue(makePlainArtifactProbe());
  });

  it('marks a plain webpage artifact as validation-passed so Xiaomi text-first stops regenerating it', async () => {
    const ctx = makeCtx();
    const { contextAssembly, runFinalizer, toolResult } = makeHarness();

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer,
      toolCall: makeToolCall(),
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    // 修复前:普通网页在 shouldRunValidation=false 处直接 return,此标记保持 undefined,
    // 导致 inference.ts 的 !artifactValidationPassed 恒为真 → 每轮重新触发 text-first
    // → 无限新建 interactive-artifact-N(5/6/7/8…),run 永不收敛。
    expect(ctx.artifactValidationPassedTargetFile).toBe(TARGET_FILE);
  });

  it('does not mark completion when an artifact repair guard is active for a different target', async () => {
    const ctx = makeCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/other-artifact.html',
        attempts: 1,
        phase: 'baseline_repair',
      } as never,
    });
    const { contextAssembly, runFinalizer, toolResult } = makeHarness();

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer,
      toolCall: makeToolCall(),
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    // repair 进行中不应被普通完成标记顺手关闸。
    expect(ctx.artifactValidationPassedTargetFile).toBeUndefined();
  });
});
