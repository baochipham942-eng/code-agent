import { describe, expect, it } from 'vitest';
import { scopeGuardRegistry } from '../../../src/main/agent/runtime/repair/scopeGuards';

describe('repair scope guards', () => {
  it('blocks patches that miss registered issue scopes', () => {
    expect(scopeGuardRegistry.check(
      ['coverage_without_runtime_evidence'],
      'start() { Game.start(); State.mode = "playing"; return {}; }',
    )).toContain('coverage_without_runtime_evidence');

    expect(scopeGuardRegistry.check(
      ['coverage_without_runtime_evidence'],
      'runSmokeTest() { const before = this.snapshot(); const after = this.step({ ArrowRight: true }, 5); coverage.stateChanges.push("player.x"); }',
    )).toBeNull();
  });

  it('routes platformer-specific guards without toolExecutionEngine conditionals', () => {
    expect(scopeGuardRegistry.check(
      ['input_normalizer_missing'],
      'window.__GAME_META__ = { qualityPlan: { actorReadable: true } };',
    )).toContain('normalizeInput(inputState)');

    expect(scopeGuardRegistry.check(
      ['missing_snapshot_metric'],
      'progressPlan: [{ input: "ArrowRight", frames: 20, metric: "player.x", expect: "increase" }]',
    )).toBeNull();
  });
});
