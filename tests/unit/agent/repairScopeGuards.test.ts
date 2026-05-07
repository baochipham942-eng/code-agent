import { describe, expect, it } from 'vitest';
import { scopeGuardRegistry } from '../../../src/main/agent/runtime/repair/scopeGuards';
// side-effect — 自从 OCP 重构后 scopeGuards.ts 不再 import platformer guards；
// 测试自己显式触发 platformer 注册（生产代码里由 PlatformerChecker import 链触发）
import '../../../src/main/agent/runtime/repair/platformerScopeGuards';

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
