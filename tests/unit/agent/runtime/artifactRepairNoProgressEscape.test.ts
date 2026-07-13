// ============================================================================
// Repair 状态机行为级回归 — 逃生门语义（BC1/BC2 拍板场景）
// 场景对应 2026-06-25 phantom 死锁教训 + repeated-patch / edit-anchor 两条
// 历史不设防路径：统一 noProgressTurns 计数下，连续 4 次无进展必须硬停，
// 且任一次目标成功改动清零续命。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import {
  registerArtifactRepairBlockedToolTurn,
  ARTIFACT_REPAIR_STOP_PREFIXES,
} from '../../../../src/host/agent/runtime/artifactRepairAdmission';
import {
  enforceArtifactRepairGuard,
  enforceArtifactRepairRepeatedPatchGuard,
  getArtifactRepairPatchFingerprint,
} from '../../../../src/host/agent/runtime/toolArtifactRepairPolicy';
import { handleToolResultBookkeeping } from '../../../../src/host/agent/runtime/toolResultLifecycle';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../../src/shared/constants/repair';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { RuntimeControlPort } from '../../../../src/host/agent/runtime/runtimeControl';
import type { ToolCall, ToolResult } from '../../../../src/shared/contract';
import type { ToolExecutionResult } from '../../../../src/host/tools/types';

const PHANTOM_TARGET = '/nonexistent/phantom/article.html';

function makeCtx(guardOverrides: Record<string, unknown> = {}): RuntimeContext {
  return {
    sessionId: 'repair-escape-session',
    workingDirectory: '/tmp',
    artifact: ArtifactState.forTest({
      repairGuard: {
        targetFile: PHANTOM_TARGET,
        attempts: 0,
        phase: 'initial_repair',
        patched: false,
        ...guardOverrides,
      } as never,
    }),
    control: ControlState.forTest(),
    turn: TurnState.forTest({ needsReinference: false } as never),
    onEvent: () => undefined,
    circuitBreaker: {
      recordFailure: () => false,
      recordSuccess: () => undefined,
      generateWarningMessage: () => '',
      generateUserErrorMessage: () => '',
    },
    goalTracker: { recordAction: () => undefined },
    nudgeManager: { recordVerification: () => undefined },
    antiPatternDetector: {
      trackToolFailure: () => undefined,
      clearToolFailure: () => undefined,
      trackDuplicateCall: () => undefined,
      trackSuccessfulWrite: () => undefined,
    },
  } as unknown as RuntimeContext;
}

function makeContextAssembly(sink: string[]): ContextAssembly {
  return {
    injectSystemMessage: (message: string) => sink.push(message),
    pushPersistentSystemContext: (message: string) => sink.push(message),
  } as unknown as ContextAssembly;
}

const runtimeControl = {
  setPlanMode: () => undefined,
  isPlanMode: () => false,
  generateAutoContinuationPrompt: () => '',
} satisfies RuntimeControlPort;

describe('phantom 目标死锁（2026-06-25 CSDN 案全链路：enforce block → 统一计数 → 硬停）', () => {
  it('guard 锁死不可达目标时，每个越界工具被 block 并计数，连续 4 次触发 attempts-exhausted', () => {
    const ctx = makeCtx();
    const grepCall: ToolCall = { id: 'tc-grep', name: 'Grep', arguments: { pattern: 'x' } };

    let stopped = false;
    for (let i = 0; i < ARTIFACT_REPAIR_MAX_ATTEMPTS; i += 1) {
      const block = enforceArtifactRepairGuard(ctx, grepCall);
      expect(block).toContain('Artifact repair mode is active');
      stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, grepCall.name);
    }
    expect(stopped).toBe(true);
    expect(ctx.artifact.repairGuard?.noProgressTurns).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(
      ctx.control.forceFinalResponseReason?.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']),
    ).toBe(true);
  });
});

describe('repeated-patch 重放（BC2：同指纹补丁从无界变 4 次收口）', () => {
  const repeatedEdit: ToolCall = {
    id: 'tc-edit',
    name: 'Edit',
    arguments: {
      file_path: PHANTOM_TARGET,
      old_text: 'const score = 0;',
      new_text: 'const score = 1;',
    },
  };

  it('同指纹 Edit 被 block 且喂计数，连续 4 次硬停', () => {
    const fingerprint = getArtifactRepairPatchFingerprint(repeatedEdit);
    expect(fingerprint).toBeTruthy();
    const ctx = makeCtx({ lastFailedPatchFingerprint: fingerprint });

    let stopped = false;
    for (let i = 0; i < ARTIFACT_REPAIR_MAX_ATTEMPTS; i += 1) {
      const block = enforceArtifactRepairRepeatedPatchGuard(ctx, repeatedEdit);
      expect(block).toBeTruthy();
      stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, repeatedEdit.name);
    }
    expect(stopped).toBe(true);
    expect(
      ctx.control.forceFinalResponseReason?.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']),
    ).toBe(true);
  });

  it('不同指纹的 Edit 不触发重放闸', () => {
    const fingerprint = getArtifactRepairPatchFingerprint(repeatedEdit);
    const ctx = makeCtx({ lastFailedPatchFingerprint: fingerprint });
    const differentEdit: ToolCall = {
      id: 'tc-edit-2',
      name: 'Edit',
      arguments: { file_path: PHANTOM_TARGET, old_text: 'const lives = 3;', new_text: 'const lives = 5;' },
    };
    expect(enforceArtifactRepairRepeatedPatchGuard(ctx, differentEdit)).toBeNull();
  });
});

describe('edit-anchor-failure（BC2：连续锚定失败从无界变 4 次收口，经真实 bookkeeping 路径）', () => {
  const anchorFailEdit: ToolCall = {
    id: 'tc-anchor',
    name: 'Edit',
    arguments: { file_path: PHANTOM_TARGET, old_text: 'missing anchor', new_text: 'patched' },
  };

  function runAnchorFailure(ctx: RuntimeContext, sink: string[]): void {
    const toolResult: ToolResult = {
      toolCallId: anchorFailEdit.id,
      success: false,
      error: 'Edit #1/1 failed: text not found',
      duration: 1,
    };
    handleToolResultBookkeeping({
      ctx,
      contextAssembly: makeContextAssembly(sink),
      runtimeControl,
      toolCall: anchorFailEdit,
      normalizedResult: { success: false, error: toolResult.error } as ToolExecutionResult,
      toolResult,
    });
  }

  it('连续 4 次锚定失败触发硬停，且硬停当次跳过恢复注入/重推理', () => {
    const ctx = makeCtx();
    const sink: string[] = [];

    for (let i = 0; i < ARTIFACT_REPAIR_MAX_ATTEMPTS - 1; i += 1) {
      runAnchorFailure(ctx, sink);
      expect(ctx.turn.needsReinference).toBe(true);
      ctx.turn.clearReinference();
    }
    const promptsBeforeStop = sink.length;
    expect(promptsBeforeStop).toBeGreaterThan(0);

    runAnchorFailure(ctx, sink);
    expect(ctx.artifact.repairGuard?.noProgressTurns).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(
      ctx.control.forceFinalResponseReason?.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']),
    ).toBe(true);
    // 硬停当次：不再注入恢复提示、不请求重推理
    expect(sink.length).toBe(promptsBeforeStop);
    expect(ctx.turn.needsReinference).toBe(false);
  });

  it('锚定失败后一次成功改动清零计数——正常"失败→重试成功"不受逃生门误伤', () => {
    const ctx = makeCtx();
    const sink: string[] = [];
    runAnchorFailure(ctx, sink);
    runAnchorFailure(ctx, sink);
    expect(ctx.artifact.repairGuard?.noProgressTurns).toBe(2);

    ctx.artifact.markTargetPatched();
    expect(ctx.artifact.repairGuard?.noProgressTurns).toBe(0);

    runAnchorFailure(ctx, sink);
    expect(ctx.artifact.repairGuard?.noProgressTurns).toBe(1);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });
});
