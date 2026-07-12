import { describe, expect, it } from 'vitest';
import { DURABLE_RUN_KILL_RESTART_SCENARIOS } from '../../../fixtures/durableRunKillRestart';

describe('Durable Run kill/restart acceptance inventory', () => {
  it('replaces every S0 missing-evidence skeleton with a real process scenario', () => {
    const covered = new Set(DURABLE_RUN_KILL_RESTART_SCENARIOS.map((scenario) => scenario.coreId));
    expect(covered).toEqual(new Set([
      'before-model-dispatch',
      'after-model-response',
      'between-tool-begin-end',
      'approval-waiting',
      'child-agent-running',
      'dynamic-workflow',
      'agent-team-auto-agent',
      'external-engine',
      'mcp-durable-task',
    ]));
  });

  it('keeps explicit review variants for every unknown side-effect boundary', () => {
    const review = DURABLE_RUN_KILL_RESTART_SCENARIOS.filter((scenario) =>
      scenario.expectedOutcome === 'waiting_review');
    expect(review.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'between-tool-begin-end-unknown-write',
      'child-agent-running',
      'dynamic-workflow-drift',
      'external-engine-non-resumable',
      'mcp-durable-task-unknown',
    ]));
    expect(review.every((scenario) => Boolean(scenario.requiresReviewReason))).toBe(true);
  });
});
