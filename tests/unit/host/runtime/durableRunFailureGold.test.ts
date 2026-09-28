import { describe, expect, it } from 'vitest';
import {
  ADR075_LIVE_LOOP_CORE_IDS,
  ADR075_S9_CORE_IDS,
  DURABLE_RUN_KILL_RESTART_SCENARIOS,
} from '../../../fixtures/durableRunKillRestart';

describe('Durable Run kill/restart acceptance inventory', () => {
  it('replaces every S0 missing-evidence skeleton with a real process scenario', () => {
    const covered = new Set(DURABLE_RUN_KILL_RESTART_SCENARIOS.map((scenario) => scenario.coreId));
    expect(covered).toEqual(new Set([...ADR075_S9_CORE_IDS, ...ADR075_LIVE_LOOP_CORE_IDS]));
  });

  it('keeps explicit review variants for drift, approval-adjacent, and external irreversible writes', () => {
    const review = DURABLE_RUN_KILL_RESTART_SCENARIOS.filter((scenario) =>
      scenario.expectedOutcome === 'waiting_review');
    expect(review.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'child-agent-running',
      'dynamic-workflow-drift',
      'external-engine-non-resumable',
      'mcp-durable-task-unknown',
    ]));
    expect(review.map((scenario) => scenario.id)).not.toContain('between-tool-begin-end-unknown-write');
    expect(review.every((scenario) => Boolean(scenario.requiresReviewReason))).toBe(true);
  });

  it('treats a local unknown write as interrupt-and-continue, not a review dead-end', () => {
    const localWrite = DURABLE_RUN_KILL_RESTART_SCENARIOS.find(
      (scenario) => scenario.id === 'between-tool-begin-end-unknown-write',
    );
    expect(localWrite).toMatchObject({
      expectedOutcome: 'running',
      expectedRecoveryAction: 'interrupt_unproven_tool_replay',
    });
    expect(localWrite?.requiresReviewReason).toBeUndefined();
  });

  it('keeps native safe-recovery rows running with the loop attached instead of one-step completed', () => {
    const safeNative = DURABLE_RUN_KILL_RESTART_SCENARIOS.filter((scenario) => [
      'before-model-dispatch',
      'after-model-response-queryable',
      'after-model-response-safe-retry',
      'between-tool-begin-end-deduplicated',
    ].includes(scenario.id));
    expect(safeNative).toHaveLength(4);
    expect(safeNative.every((scenario) => scenario.expectedOutcome === 'running')).toBe(true);
    expect(safeNative.every((scenario) => scenario.expectedRecoveryAction !== 'startTask')).toBe(true);
  });

  it('covers the ADR-075 live-loop kill-9 scenarios through completed on the same runId', () => {
    const live = DURABLE_RUN_KILL_RESTART_SCENARIOS.filter((scenario) => scenario.liveLoop);
    expect(live.map((scenario) => scenario.coreId)).toEqual([...ADR075_LIVE_LOOP_CORE_IDS]);
    expect(live.every((scenario) => scenario.expectedOutcome === 'completed')).toBe(true);
    expect(live.every((scenario) => scenario.engine.kind === 'native')).toBe(true);
  });
});
