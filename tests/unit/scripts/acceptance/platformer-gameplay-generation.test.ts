/**
 * Tests for the three acceptance guards added by task A.3:
 *
 * 1. Best-of-N picks best of N candidates by execution-filter score
 * 2. Repair-loop hard cap stops at configured rounds and escalates
 * 3. Probe-pass monotonicity gate detects regression (warn + strict modes)
 *
 * Strategy: mock the generation function (we never invoke an LLM here) and
 * inject a fake `validate` so each candidate produces a deterministic
 * ValidationSummary. The orchestrator under test (runBestOfN /
 * runAcceptanceLoop / scoreCandidate / diffRegressedChecks) runs for real.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  scoreCandidate,
  runBestOfN,
  runAcceptanceLoop,
  diffRegressedChecks,
  type ValidationSummary,
  type GenerateCandidateFn,
  type RoundResult,
} from '../../../../scripts/acceptance/platformer-gameplay-generation';

function makeSummary(opts: {
  artifactPath: string;
  passed?: boolean;
  runtimePassed?: boolean;
  runtimeChecks?: string[];
  runtimeFailures?: string[];
  browserPassed?: boolean;
  browserChecks?: string[];
  browserFailures?: string[];
  failures?: string[];
}): ValidationSummary {
  return {
    artifactPath: opts.artifactPath,
    passed: opts.passed ?? false,
    failures: opts.failures ?? [],
    runtimePassed: opts.runtimePassed,
    runtimeChecks: opts.runtimeChecks,
    runtimeFailures: opts.runtimeFailures,
    browserPassed: opts.browserPassed,
    browserChecks: opts.browserChecks,
    browserFailures: opts.browserFailures,
  };
}

async function makeArtifactStub(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-test-'));
  const file = path.join(dir, 'stub.html');
  await fs.writeFile(file, '<html></html>', 'utf-8');
  return file;
}

const noopLog = () => {};

describe('scoreCandidate', () => {
  it('ranks fully-passing candidate above runtime-only above static-only', () => {
    const fullPass = scoreCandidate(
      makeSummary({
        artifactPath: '/x',
        passed: true,
        runtimePassed: true,
        browserPassed: true,
        runtimeChecks: ['stomp', 'bump', 'ability', 'gate', 'combo'],
        browserChecks: ['desktop', 'mobile'],
      }),
    );
    const runtimeOnly = scoreCandidate(
      makeSummary({
        artifactPath: '/x',
        runtimePassed: true,
        browserPassed: false,
        runtimeChecks: ['stomp', 'bump'],
        runtimeFailures: [],
        browserChecks: ['desktop'],
        browserFailures: ['desktop'],
      }),
    );
    const browserOnly = scoreCandidate(
      makeSummary({
        artifactPath: '/x',
        runtimePassed: false,
        browserPassed: true,
        runtimeChecks: ['stomp'],
        runtimeFailures: ['stomp'],
        browserChecks: ['desktop'],
      }),
    );
    expect(fullPass.score).toBeGreaterThan(runtimeOnly.score);
    expect(runtimeOnly.score).toBeGreaterThan(browserOnly.score);
  });
});

describe('runBestOfN — Guard 1: Best-of-N picks best of 3', () => {
  it('selects the highest-scoring candidate among three', async () => {
    const artifactPath = await makeArtifactStub();
    const summaries: ValidationSummary[] = [
      // Candidate 0: only static checks pass, runtime fails
      makeSummary({
        artifactPath,
        runtimePassed: false,
        browserPassed: true,
        runtimeChecks: ['stomp', 'bump'],
        runtimeFailures: ['stomp', 'bump'],
        browserChecks: ['desktop', 'mobile'],
      }),
      // Candidate 1: runtime passes, browser fails — should win (best score)
      makeSummary({
        artifactPath,
        runtimePassed: true,
        browserPassed: false,
        runtimeChecks: ['stomp', 'bump'],
        browserChecks: ['desktop'],
        browserFailures: ['desktop'],
      }),
      // Candidate 2: nothing passes
      makeSummary({
        artifactPath,
        runtimePassed: false,
        browserPassed: false,
        runtimeChecks: ['stomp'],
        runtimeFailures: ['stomp'],
        browserChecks: ['desktop'],
        browserFailures: ['desktop'],
      }),
    ];

    let nextIndex = 0;
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => summaries[nextIndex++]);

    const round = await runBestOfN({
      bonN: 3,
      round: 0,
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
    });

    expect(round.candidates).toHaveLength(3);
    expect(round.selected.candidateId).toBe('r0c1');
    expect(round.selected.validation.runtimePassed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('short-circuits as soon as a candidate fully passes', async () => {
    const artifactPath = await makeArtifactStub();
    const summaries: ValidationSummary[] = [
      makeSummary({
        artifactPath,
        runtimePassed: false,
        runtimeChecks: ['stomp'],
        runtimeFailures: ['stomp'],
        browserPassed: false,
        browserChecks: ['desktop'],
        browserFailures: ['desktop'],
      }),
      makeSummary({
        artifactPath,
        passed: true,
        runtimePassed: true,
        browserPassed: true,
        runtimeChecks: ['stomp', 'bump'],
        browserChecks: ['desktop', 'mobile'],
      }),
      // Should never be reached
      makeSummary({ artifactPath, passed: false }),
    ];

    let idx = 0;
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => summaries[idx++]);

    const round = await runBestOfN({
      bonN: 3,
      round: 0,
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
    });

    expect(round.candidates).toHaveLength(2);
    expect(round.selected.candidateId).toBe('r0c1');
    expect(round.fullyPassed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('runAcceptanceLoop — Guard 2: repair-loop hard cap', () => {
  it('stops after repairCap rounds and escalates with the documented message', async () => {
    const artifactPath = await makeArtifactStub();
    // Every candidate in every round fails the same way — never short-circuits.
    const failingSummary = makeSummary({
      artifactPath,
      passed: false,
      runtimePassed: false,
      browserPassed: false,
      runtimeChecks: ['stomp', 'bump'],
      runtimeFailures: ['stomp'],
      browserChecks: ['desktop'],
      browserFailures: [],
    });
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => failingSummary);

    const result = await runAcceptanceLoop({
      bonN: 2,
      repairCap: 2,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
      log: noopLog,
    });

    // Round 0 + 2 repair rounds = 3 rounds total
    expect(result.rounds).toHaveLength(3);
    expect(result.escalated).toBe(true);
    expect(result.passedRound).toBeUndefined();
    expect(result.escalationReason).toContain('repair cap reached');
    expect(result.escalationReason).toContain(
      'docs/audits/2026-05-07-game-acceptance-architecture.md',
    );
    // 3 rounds × 2 candidates = 6 generation invocations
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it('returns immediately on full PASS at round 0 without entering repair', async () => {
    const artifactPath = await makeArtifactStub();
    const passing = makeSummary({
      artifactPath,
      passed: true,
      runtimePassed: true,
      browserPassed: true,
      runtimeChecks: ['stomp'],
      browserChecks: ['desktop'],
    });
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => passing);

    const result = await runAcceptanceLoop({
      bonN: 3,
      repairCap: 2,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
      log: noopLog,
    });

    expect(result.passedRound).toBe(0);
    expect(result.escalated).toBe(false);
    expect(result.rounds).toHaveLength(1);
  });
});

describe('runAcceptanceLoop — Guard 3: monotonicity gate', () => {
  it('strict mode: hard fails when round N has fewer passing checks than N-1', async () => {
    const artifactPath = await makeArtifactStub();

    // Round 0: stomp + bump runtime checks pass, browser passes
    const round0 = makeSummary({
      artifactPath,
      runtimePassed: false,
      runtimeChecks: ['stomp', 'bump', 'ability'],
      runtimeFailures: ['ability'], // 2 passing
      browserPassed: true,
      browserChecks: ['desktop', 'mobile'],
    });
    // Round 1: regression — stomp now fails, only bump passes; browser regresses too
    const round1Regression = makeSummary({
      artifactPath,
      runtimePassed: false,
      runtimeChecks: ['stomp', 'bump', 'ability'],
      runtimeFailures: ['stomp', 'ability'],
      browserPassed: true,
      browserChecks: ['desktop', 'mobile'],
    });

    let call = 0;
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => {
      // Round 0 has 1 candidate, round 1 has 1 candidate (bonN=1).
      const idx = call++;
      return idx === 0 ? round0 : round1Regression;
    });

    const result = await runAcceptanceLoop({
      bonN: 1,
      repairCap: 2,
      monotonicMode: 'strict',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
      log: noopLog,
    });

    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toContain('monotonic regression');
    expect(result.rounds).toHaveLength(2);
    const lastRound = result.rounds[1];
    expect(lastRound.regressionAgainstPrevious).toBeDefined();
    expect(lastRound.regressionAgainstPrevious!.regressedChecks).toContain('runtime:stomp');
  });

  it('warn mode: logs regression but continues; does NOT advance baseline', async () => {
    const artifactPath = await makeArtifactStub();

    // Round 0: 2 runtime checks pass
    const round0 = makeSummary({
      artifactPath,
      runtimePassed: false,
      runtimeChecks: ['stomp', 'bump', 'ability'],
      runtimeFailures: ['ability'],
      browserPassed: true,
      browserChecks: ['desktop'],
    });
    // Round 1: regresses (stomp + ability fail) — should be discarded under warn mode
    const round1Regression = makeSummary({
      artifactPath,
      runtimePassed: false,
      runtimeChecks: ['stomp', 'bump', 'ability'],
      runtimeFailures: ['stomp', 'ability'],
      browserPassed: true,
      browserChecks: ['desktop'],
    });
    // Round 2: regresses again vs the round-0 baseline (still 'stomp' missing) — warn-mode keeps comparing to round 0
    const round2Regression = makeSummary({
      artifactPath,
      runtimePassed: false,
      runtimeChecks: ['stomp', 'bump', 'ability'],
      runtimeFailures: ['stomp'],
      browserPassed: true,
      browserChecks: ['desktop'],
    });

    let call = 0;
    const generate: GenerateCandidateFn = vi.fn(async () => ({
      generation: { responses: [], toolCount: 0, errors: [] },
      artifactPath,
    }));
    const validate = vi.fn(async () => {
      const idx = call++;
      if (idx === 0) return round0;
      if (idx === 1) return round1Regression;
      return round2Regression;
    });

    const warnings: string[] = [];
    const result = await runAcceptanceLoop({
      bonN: 1,
      repairCap: 2,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
      log: (m) => warnings.push(m),
    });

    // Warn mode should NOT short-circuit — it runs all 3 rounds (round 0 + 2 repairs).
    expect(result.rounds).toHaveLength(3);
    // Final outcome: escalated because repair cap reached without PASS.
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toContain('repair cap reached');

    // Round 1 is marked as regressed against the round-0 baseline.
    expect(result.rounds[1].regressionAgainstPrevious?.regressedChecks).toContain('runtime:stomp');
    // Warn log message must mention WARN.
    expect(warnings.some((w) => w.includes('WARN monotonic regression'))).toBe(true);

    // Round 2's regression diff is compared against the *unchanged* baseline (round 0),
    // because warn mode does not advance the baseline through a regressed round.
    expect(result.rounds[2].regressionAgainstPrevious?.regressedChecks).toContain('runtime:stomp');
  });
});

describe('diffRegressedChecks', () => {
  it('returns the set of runtime/browser checks that were passing before but now fail', () => {
    const previous: RoundResult = {
      round: 0,
      candidates: [],
      selected: {
        candidateId: 'r0c0',
        artifactPath: '/x',
        generation: null,
        validation: makeSummary({
          artifactPath: '/x',
          runtimeChecks: ['stomp', 'bump'],
          browserChecks: ['desktop'],
        }),
        score: 0,
        passCount: 3,
        failCount: 0,
      },
      passCount: 3,
      failCount: 0,
      fullyPassed: false,
    };
    const current: RoundResult = {
      ...previous,
      round: 1,
      selected: {
        ...previous.selected,
        candidateId: 'r1c0',
        validation: makeSummary({
          artifactPath: '/x',
          runtimeChecks: ['stomp', 'bump'],
          runtimeFailures: ['stomp'],
          browserChecks: ['desktop'],
        }),
      },
    };
    expect(diffRegressedChecks(previous, current)).toEqual(['runtime:stomp']);
  });
});
