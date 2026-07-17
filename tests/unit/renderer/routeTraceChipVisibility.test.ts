import { describe, expect, it } from 'vitest';
import { shouldRenderModelDecisionChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';
import type { ModelDecisionEventData } from '../../../src/shared/contract';

function decision(overrides: Partial<ModelDecisionEventData>): ModelDecisionEventData {
  return {
    reason: 'default-model',
    requestedModel: 'mimo-v2.5-pro',
    resolvedModel: 'mimo-v2.5-pro',
    fallbackFrom: null,
    ...overrides,
  } as ModelDecisionEventData;
}

describe('shouldRenderModelDecisionChip', () => {
  it('hides the chip for the default model with no routing change', () => {
    expect(shouldRenderModelDecisionChip(decision({ reason: 'default-model' }))).toBe(false);
  });

  it('hides the chip for plain user-selected with no change', () => {
    expect(shouldRenderModelDecisionChip(decision({
      reason: 'user-selected',
      requestedModel: 'kimi-k2.5',
      resolvedModel: 'kimi-k2.5',
    }))).toBe(false);
  });

  it('shows the chip when a fallback happened', () => {
    expect(shouldRenderModelDecisionChip(decision({ reason: 'user-selected', fallbackFrom: 'kimi-k2.5' }))).toBe(true);
  });

  it('shows the chip when the resolved model differs from the requested model', () => {
    expect(shouldRenderModelDecisionChip(decision({
      reason: 'simple-task-free',
      requestedModel: 'mimo-v2.5-pro',
      resolvedModel: 'glm-4-flash',
    }))).toBe(true);
  });

  it('shows the chip for routing/strategy reasons', () => {
    expect(shouldRenderModelDecisionChip(decision({ reason: 'strategy-deep' }))).toBe(true);
  });

  it('shows the chip when an external engine failed', () => {
    expect(shouldRenderModelDecisionChip(decision({
      reason: 'user-selected',
      externalEngine: {
        kind: 'codex_cli',
        label: 'Codex CLI',
        installState: 'installed',
        runtimeState: 'error',
        executable: true,
        capabilities: [],
        failure: {
          category: 'missing_cli',
          reason: 'boom',
          message: 'boom',
          suggestion: 'retry later',
          retryable: true,
        },
      },
    }))).toBe(true);
  });
});
