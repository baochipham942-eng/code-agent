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
  buildGenerationPrompt,
  buildRepairPrompt,
  formatProductStatusMarkdown,
  prioritizeFailures,
  selectCodexMilestoneModelRoute,
  summarizeValidationStatus,
  type ValidationSummary,
  type GenerateCandidateFn,
  type RoundResult,
  type CodexMilestoneRouteConfig,
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

describe('codex milestone model routing', () => {
  const routeConfig: CodexMilestoneRouteConfig = {
    logicProvider: 'deepseek',
    logicModel: 'deepseek-v4-flash',
    mimoProvider: 'xiaomi',
    mimoModel: 'mimo-v2.5-pro',
    generationTimeoutMs: 120_000,
    heavyMilestoneTimeoutMs: 480_000,
  };

  it('routes M0-M2 to the strong code model and M3-M4 to mimo', () => {
    const routes = ['M0', 'M1', 'M2', 'M3', 'M4'].map((id) =>
      selectCodexMilestoneModelRoute(routeConfig, id as 'M0' | 'M1' | 'M2' | 'M3' | 'M4'),
    );

    expect(routes.map((route) => `${route.milestoneId}:${route.provider}/${route.model}`)).toEqual([
      'M0:deepseek/deepseek-v4-flash',
      'M1:deepseek/deepseek-v4-flash',
      'M2:deepseek/deepseek-v4-flash',
      'M3:xiaomi/mimo-v2.5-pro',
      'M4:xiaomi/mimo-v2.5-pro',
    ]);
  });

  it('raises M2/M3 single-segment timeout to at least 480s', () => {
    expect(selectCodexMilestoneModelRoute(routeConfig, 'M1').timeoutMs).toBe(120_000);
    expect(selectCodexMilestoneModelRoute(routeConfig, 'M2').timeoutMs).toBe(480_000);
    expect(selectCodexMilestoneModelRoute(routeConfig, 'M3').timeoutMs).toBe(480_000);
    expect(selectCodexMilestoneModelRoute(routeConfig, 'M4').timeoutMs).toBe(120_000);
  });

  it('honors a higher global generation timeout for heavy milestones', () => {
    const route = selectCodexMilestoneModelRoute(
      { ...routeConfig, generationTimeoutMs: 600_000 },
      'M2',
    );
    expect(route.timeoutMs).toBe(600_000);
  });
});

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

describe('artifact retention on regression (deepseek 35/6 → clobbered regression)', () => {
  it('escalates with finalResult = best round AND restores the best artifact file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-retain-'));
    const artifactPath = path.join(dir, 'game.html');
    await fs.writeFile(artifactPath, 'GOOD round0', 'utf-8');

    // round0 writes GOOD (3 passing checks); every repair round writes BAD (regresses to 1).
    let round = 0;
    const generate: GenerateCandidateFn = vi.fn(async () => {
      if (round > 0) await fs.writeFile(artifactPath, 'BAD repair', 'utf-8');
      round += 1;
      return { generation: { responses: [], toolCount: 1, errors: [] }, artifactPath };
    });
    const validate = async (p: string): Promise<ValidationSummary> => {
      const content = await fs.readFile(p, 'utf-8');
      const good = content.startsWith('GOOD');
      return makeSummary({
        artifactPath: p,
        runtimePassed: false,
        browserPassed: true,
        runtimeChecks: ['stomp', 'bump', 'ability'],
        runtimeFailures: good ? [] : ['stomp', 'bump'], // BAD regresses stomp+bump
        browserChecks: ['desktop'],
      });
    };

    const result = await runAcceptanceLoop({
      bonN: 1,
      repairCap: 2,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 1000,
      generate,
      validate,
      log: noopLog,
    });

    expect(result.escalated).toBe(true);
    // finalResult must be the BEST round (round 0), not the last regressed round.
    expect(result.finalResult.round).toBe(0);
    expect(result.finalResult.passCount).toBeGreaterThan(result.rounds[result.rounds.length - 1].passCount);
    // The delivered artifact file must be restored to the best (round 0) version.
    expect(await fs.readFile(artifactPath, 'utf-8')).toBe('GOOD round0');
    // The .best snapshot is cleaned up.
    expect(await fs.access(`${artifactPath}.best`).then(() => true, () => false)).toBe(false);
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

describe('P3 monotonic repair — buildRepairPrompt + prioritizeFailures', () => {
  it('buildGenerationPrompt is unchanged for round 0 (regression guard)', () => {
    const p = buildGenerationPrompt('/tmp/x.html');
    expect(p).toContain('Create a complete single-file browser platformer game');
    expect(p).toContain('/tmp/x.html');
    expect(p).not.toContain('Validation failures to fix');
  });

  it('buildRepairPrompt references the baseline path and instructs minimal Edit, not Write', () => {
    const prompt = buildRepairPrompt('/tmp/x.html', [
      'runSmokeTest 未通过',
      'gameplayMechanics 缺少 runtime 证据：stomp',
    ]);
    expect(prompt).toContain('/tmp/x.html');
    expect(prompt).toContain('failed acceptance validation');
    expect(prompt).toContain('acceptance gap, not a blank failure');
    expect(prompt).toContain('Preserve any working visuals');
    expect(prompt).toContain('minimal Edits');
    expect(prompt).toContain('Do NOT replace the whole file');
    // Both failures should land in the body.
    expect(prompt).toContain('runSmokeTest 未通过');
    expect(prompt).toContain('gameplayMechanics 缺少 runtime 证据：stomp');
  });

  it('buildRepairPrompt trims a long failure list to 10 entries by priority', () => {
    const many = Array.from({ length: 30 }, (_, i) => `static-issue-${i}`);
    const runtimeFailures = [
      'runSmokeTest 未通过',
      'gameplayMechanics stomp_enemy: enemiesDefeated did not change',
      'gameplayMechanics 缺少 runtime 证据: bump_block',
    ];
    const prompt = buildRepairPrompt('/tmp/x.html', [...many, ...runtimeFailures]);
    // The top-N should bring runtime failures forward — even though they were last in input order.
    expect(prompt).toContain('runSmokeTest 未通过');
    expect(prompt).toContain('stomp_enemy');
    expect(prompt).toContain('bump_block');
    // Header should reflect that we only kept 10.
    expect(prompt).toContain('top 10 by priority');
  });

  it('prioritizeFailures sorts runtime mechanic failures ahead of metadata and browser failures', () => {
    const inputs = [
      'browser visual smoke: canvas not nonblank in desktop viewport',
      '__GAME_META__.controls missing key Space',
      'runSmokeTest stomp_enemy failed: enemiesDefeated did not change',
      'visual smoke: mobile canvas crop',
      'gameplayMechanics gate without reachability evidence',
    ];
    const sorted = prioritizeFailures(inputs);
    expect(sorted[0]).toContain('stomp_enemy');
    expect(sorted[1]).toContain('gate without reachability');
    // Browser/visual failures land last.
    const lastTwo = sorted.slice(-2).join(' ');
    expect(lastTwo).toMatch(/canvas|visual/);
  });
});

describe('product status summary', () => {
  it('describes runtime mechanics failures as a playable quality gap, not a hard error wall', () => {
    const summary = makeSummary({
      artifactPath: '/tmp/game.html',
      passed: false,
      runtimePassed: false,
      browserPassed: true,
      runtimeChecks: ['interactive contract exposes step(inputState, frames)'],
      runtimeFailures: [
        'stomp_enemy: enemiesDefeated did not increase',
        'unlock_gate: gatesUnlocked did not increase',
      ],
      failures: ['runSmokeTest 未通过。'],
    });

    const status = summarizeValidationStatus(summary);
    expect(status.kind).toBe('quality-gap');
    expect(status.headline).toContain('游戏已生成');
    expect(status.headline).toContain('玩法验收未达标');
    expect(status.focus.join('\n')).toContain('玩法闭环');
  });

  it('classifies missing generated artifacts as blocking', () => {
    const status = summarizeValidationStatus(
      makeSummary({
        artifactPath: '/tmp/game.html',
        passed: false,
        failures: ['Artifact was not written; generation failed: provider timeout'],
      }),
    );

    expect(status.kind).toBe('blocked');
    expect(status.status).toBe('BLOCKED');
  });

  it('puts raw validator details behind a diagnostics disclosure in markdown reports', () => {
    const markdown = formatProductStatusMarkdown(
      makeSummary({
        artifactPath: '/tmp/game.html',
        passed: false,
        runtimePassed: false,
        browserPassed: true,
        failures: ['runSmokeTest 未通过。'],
      }),
    );

    expect(markdown).toContain('## Product Status');
    expect(markdown).toContain('status: PLAYABLE_QUALITY_GAP');
    expect(markdown).not.toContain('## Validation Failures');
  });
});

describe('P3 monotonic repair — runAcceptanceLoop forwards previousFailures', () => {
  it('round 0 calls generate without previousFailures; round 1 forwards baseline failures', async () => {
    const artifactPath = await makeArtifactStub();
    const calls: Array<{ round: number; previousFailures?: string[] }> = [];
    const generate: GenerateCandidateFn = vi.fn(async ({ round, previousFailures }) => {
      calls.push({ round, previousFailures });
      return {
        generation: { responses: ['ok'], toolCount: 1, errors: [] },
        artifactPath,
      };
    });

    // Round 0 fails with a runtime failure, then round 1 also fails.
    let n = 0;
    const validate = async (p: string): Promise<ValidationSummary> => {
      n += 1;
      return makeSummary({
        artifactPath: p,
        passed: false,
        runtimePassed: false,
        browserPassed: true,
        runtimeChecks: n === 1 ? ['movement'] : ['movement', 'stomp'],
        runtimeFailures: n === 1 ? ['stomp_enemy: no change', 'bump_block: no change'] : ['bump_block: no change'],
        browserChecks: ['desktop'],
        failures: n === 1
          ? ['runSmokeTest: stomp_enemy failed', 'runSmokeTest: bump_block failed']
          : ['runSmokeTest: bump_block failed'],
      });
    };

    const result = await runAcceptanceLoop({
      bonN: 1,
      repairCap: 1,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 5000,
      generate,
      validate,
      log: noopLog,
    });

    expect(result.rounds).toHaveLength(2);
    expect(calls[0].round).toBe(0);
    expect(calls[0].previousFailures).toBeUndefined();
    expect(calls[1].round).toBe(1);
    // Round 1 should receive round 0's failures so the agent can patch instead of regenerating.
    expect(calls[1].previousFailures).toEqual([
      'runSmokeTest: stomp_enemy failed',
      'runSmokeTest: bump_block failed',
    ]);
  });

  it('round 1 falls back to fresh generation when baseline has zero passing checks (unrepairable)', async () => {
    const artifactPath = await makeArtifactStub();
    const calls: Array<{ round: number; previousFailures?: string[] }> = [];
    const generate: GenerateCandidateFn = vi.fn(async ({ round, previousFailures }) => {
      calls.push({ round, previousFailures });
      return {
        generation: { responses: ['ok'], toolCount: 1, errors: [] },
        artifactPath,
      };
    });

    const validate = async (p: string): Promise<ValidationSummary> =>
      makeSummary({
        artifactPath: p,
        passed: false,
        // No passing checks anywhere → not worth preserving as baseline.
        runtimeChecks: [],
        runtimeFailures: ['everything broken'],
        browserChecks: [],
        browserFailures: ['canvas blank'],
        failures: ['Artifact was not written; generation failed: foo'],
      });

    await runAcceptanceLoop({
      bonN: 1,
      repairCap: 1,
      monotonicMode: 'warn',
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: 5000,
      generate,
      validate,
      log: noopLog,
    });

    expect(calls[0].previousFailures).toBeUndefined();
    // Round 1 must NOT inherit a useless baseline — fall back to fresh regeneration.
    expect(calls[1].previousFailures).toBeUndefined();
  });
});
