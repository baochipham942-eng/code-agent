/**
 * General-purpose dashboard subtype checker — Phase 4 Dashboard PR-B step 3.
 *
 * 通用 dashboard checker，没有领域特化。PR-B 占位空 probes []；PR-C/D/E 会
 * 注入实际 probe 集合（plan §3 决策 5 列的 7 个 MVP probe）。
 *
 * Probe runner 设计（仿 GeneralDeckChecker，差别是 imperative.evaluate 是 async）:
 * - declarative probe → resolve predicate → 按 expectation 判定
 * - imperative probe → 直接 await evaluate(input) 拿 ProbeResult
 *
 * PR-B 的 dispatch 实际不会跑任何 probe（probes 是空数组），保留 dispatch 骨架
 * 是给 PR-C/D/E 直接 push 进 probes 集合即可。
 */

import type {
  DashboardArtifactInput,
  DashboardCheckResult,
  DashboardDeclarativeProbe,
  DashboardImperativeProbe,
  DashboardPredicate,
  DashboardProbeDeclaration,
  DashboardProbeResult,
  DashboardSubtypeChecker,
} from '../types';

// ---------------------------------------------------------------------------
// Predicate evaluation — PR-B 只占位 truthy；PR-C 会扩展实际 op
// ---------------------------------------------------------------------------

function evaluatePredicate(
  predicate: DashboardPredicate,
  _input: DashboardArtifactInput,
): boolean {
  switch (predicate.op) {
    case 'truthy':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Per-probe evaluators
// ---------------------------------------------------------------------------

function evaluateDeclarative(
  probe: DashboardDeclarativeProbe,
  input: DashboardArtifactInput,
): DashboardProbeResult {
  const result = evaluatePredicate(probe.predicate, input);
  const expected = probe.expectation === 'expect-true';

  if (result === expected) {
    return { probe: probe.id, passed: true };
  }
  return {
    probe: probe.id,
    passed: false,
    failure: probe.failureMessage,
  };
}

async function evaluateImperative(
  probe: DashboardImperativeProbe,
  input: DashboardArtifactInput,
): Promise<DashboardProbeResult> {
  return probe.evaluate(input);
}

async function evaluateProbe(
  probe: DashboardProbeDeclaration,
  input: DashboardArtifactInput,
): Promise<DashboardProbeResult> {
  return probe.kind === 'declarative'
    ? evaluateDeclarative(probe, input)
    : evaluateImperative(probe, input);
}

// ---------------------------------------------------------------------------
// Checker class
// ---------------------------------------------------------------------------

export class GeneralDashboardChecker implements DashboardSubtypeChecker {
  readonly subtype = 'general';
  /**
   * PR-B 占位空数组。PR-C 加 declarative probe (html_complete / no_lorem_ipsum /
   * consistent_styling)；PR-D 加 imperative browser probe (loads_no_error /
   * viewport_non_blank)；PR-E 加 anti-Potemkin state_change_on_click。
   */
  readonly probes: readonly DashboardProbeDeclaration[] = [];

  async validate(input: DashboardArtifactInput): Promise<DashboardCheckResult> {
    const probeResults: DashboardProbeResult[] = [];
    for (const probe of this.probes) {
      probeResults.push(await evaluateProbe(probe, input));
    }
    const failures = probeResults
      .filter((r) => !r.passed && r.failure)
      .map((r) => r.failure as string);

    return {
      passed: probeResults.every((r) => r.passed),
      probes: probeResults,
      failures,
      subtype: this.subtype,
    };
  }
}
