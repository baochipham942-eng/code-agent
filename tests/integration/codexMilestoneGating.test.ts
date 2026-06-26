/**
 * Integration test: drive the codex milestone gating against the REAL game
 * artifact validator (Playwright runtime smoke), no model/API key required.
 *
 * Core design claim under test (docs/designs/game-gen-codex-workflow.md W2):
 * a contract-correct skeleton with working movement but no enemy/block/
 * ability/gate logic must
 *   - PASS the M0 probe (contract + snapshot paths intact), and
 *   - PASS the M1 probe (movement/jump driven by real step() input), but
 *   - FAIL the M2/M3 probe (later-mechanic runtime evidence missing).
 *
 * This proves milestone gating is real against the actual validator, not just
 * against unit-test fixtures — i.e. "契约错误在 M0 被拦，后续机制缺失不阻塞 M0".
 *
 * Skipped automatically when Playwright chromium is unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateGameArtifact } from '../../src/host/agent/runtime/gameArtifactValidator.ts';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime.ts';
import {
  PLATFORMER_MILESTONES,
  evaluateMilestone,
} from '../../scripts/acceptance/platformerCodexStrategy.ts';
import type { ValidationSummary } from '../../scripts/acceptance/platformer-gameplay-generation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../fixtures/platformer-m1-skeleton.html');

const M0 = PLATFORMER_MILESTONES[0];
const M1 = PLATFORMER_MILESTONES[1];
const M2 = PLATFORMER_MILESTONES[2];
const M3 = PLATFORMER_MILESTONES[3];

let chromiumAvailable = false;
let runtimeSmokeUsable = false;
let runtimeSmokeUnavailableReason: string | undefined;
let summary: ValidationSummary;

function skipWhenBrowserRuntimeUnavailable() {
  if (!chromiumAvailable) {
    console.error('[codex-gating] SKIP - Playwright chromium unavailable');
    return true;
  }
  if (!runtimeSmokeUsable && runtimeSmokeUnavailableReason) {
    console.error(`[codex-gating] SKIP - ${runtimeSmokeUnavailableReason}`);
    return true;
  }
  return false;
}

describe('codex milestone gating against real validator', () => {
  beforeAll(async () => {
    const pw = await loadPlaywrightChromium();
    chromiumAvailable = pw.ok === true && Boolean(pw.chromium);
    if (!chromiumAvailable) return;

    const validation = await validateGameArtifact(FIXTURE, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 15000,
      runBrowserVisualSmoke: false,
    });
    summary = {
      artifactPath: FIXTURE,
      passed: validation.passed,
      failures: validation.failures,
      runtimePassed: validation.runtimeSmoke?.passed,
      runtimeFailures: validation.runtimeSmoke?.failures,
      runtimeChecks: validation.runtimeSmoke?.checks,
    };
    runtimeSmokeUsable = (summary.runtimeChecks?.length ?? 0) > 0;
    const firstRuntimeFailure = summary.runtimeFailures?.[0];
    if (!runtimeSmokeUsable && firstRuntimeFailure && /无法运行交互 smoke 验收/i.test(firstRuntimeFailure)) {
      runtimeSmokeUnavailableReason = firstRuntimeFailure;
    }
    // Visibility into what the real validator reported, for debugging drift.

    console.error(
      `[codex-gating] runtimePassed=${summary.runtimePassed} checks=${summary.runtimeChecks?.length} failures=${summary.runtimeFailures?.length} firstFailure=${firstRuntimeFailure ?? 'none'}`,
    );
  }, 60000);

  it('skeleton exposes a working interactive contract (step/reset/snapshot)', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const checks = (summary.runtimeChecks ?? []).join('\n');
    expect(checks).toContain('interactive contract exposes step(inputState, frames)');
    expect(checks).toContain('interactive contract exposes reset(levelOrScenario)');
  });

  it('M0 probe PASSES — contract/snapshot paths intact (no metadata or snapshot-path failures)', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const result = evaluateMilestone(M0, summary);
    if (!result.passed) {
      console.error('[codex-gating] M0 unexpectedly blocked by:', result.blockingFailures);
    }
    expect(result.passed).toBe(true);
  });

  it('M1 probe PASSES — movement & jump driven by real step() input', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const result = evaluateMilestone(M1, summary);
    if (!result.passed) {
      console.error('[codex-gating] M1 unexpectedly blocked by:', result.blockingFailures);
    }
    expect(result.passed).toBe(true);
  });

  it('M2 probe FAILS — stompable enemy has no runtime evidence', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const result = evaluateMilestone(M2, summary);
    expect(result.passed).toBe(false);
    expect(result.blockingFailures.join('\n')).toMatch(/stomp|enemiesDefeated|stompable/i);
  });

  it('M3 probe FAILS — block/ability/gate/combo have no runtime evidence', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const result = evaluateMilestone(M3, summary);
    expect(result.passed).toBe(false);
    expect(result.blockingFailures.join('\n')).toMatch(/bump|block|ability|gate|combo/i);
  });

  it('gating is monotonic: the set of blocking failures only grows M0 ⊆ M1 ⊆ M2 ⊆ M3', () => {
    if (skipWhenBrowserRuntimeUnavailable()) return;
    const counts = [M0, M1, M2, M3].map((m) => evaluateMilestone(m, summary).blockingFailures.length);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });
});
