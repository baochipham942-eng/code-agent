/**
 * Tests for the codex milestone-incremental generation strategy
 * (docs/designs/game-gen-codex-workflow.md W1-W4).
 *
 * Same convention as platformer-gameplay-generation.test.ts: model calls and
 * probes are mocked; the pure functions and the pipeline orchestrator run for
 * real. Failure strings in evaluateMilestone tests are copied verbatim from
 * games/generated-platformer-regression-mimo.validation.md (gen8) so the
 * filters are tested against reality, not invented fixtures.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  PLATFORMER_MILESTONES,
  buildGameplan,
  buildMilestonePrompt,
  extractInterfaceSignatures,
  evaluateMilestone,
  casebookPathFor,
  formatCasebookEntry,
  appendCasebook,
  readCasebookTail,
  buildCasebookPreamble,
  runCodexMilestonePipeline,
  type MilestoneSpec,
} from '../../../../scripts/acceptance/platformerCodexStrategy';
import type { ValidationSummary } from '../../../../scripts/acceptance/platformer-gameplay-generation';

const M0 = PLATFORMER_MILESTONES[0];
const M1 = PLATFORMER_MILESTONES[1];
const M2 = PLATFORMER_MILESTONES[2];
const M3 = PLATFORMER_MILESTONES[3];
const M4 = PLATFORMER_MILESTONES[4];

function summary(failures: string[], runtimeFailures: string[] = []): ValidationSummary {
  return {
    artifactPath: '/tmp/x.html',
    passed: failures.length === 0 && runtimeFailures.length === 0,
    failures,
    runtimeFailures,
  };
}

// ============================================================================
// GAMEPLAN & prompts
// ============================================================================

describe('buildGameplan', () => {
  it('is deterministic and carries the contract vocabulary + milestone order', () => {
    const plan = buildGameplan('/tmp/game.html');
    expect(plan).toContain('/tmp/game.html');
    // Mechanics checklist must use the acceptance contract field shapes.
    expect(plan).toContain('stompable');
    expect(plan).toContain('bumpableFromBelow');
    expect(plan).toContain('requiresAbility');
    expect(plan).toContain('comboChallenge');
    // Test contract.
    expect(plan).toContain('step(inputState, frames?)');
    expect(plan).toContain('runSmokeTest()');
    // All milestones listed in order.
    const positions = PLATFORMER_MILESTONES.map((m) => plan.indexOf(`${m.id}:`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('buildMilestonePrompt', () => {
  const gameplan = buildGameplan('/tmp/game.html');

  it('first milestone instructs writing the file; later milestones instruct minimal edits', () => {
    const first = buildMilestonePrompt({
      artifactPath: '/tmp/game.html',
      gameplan,
      milestone: M0,
      isFirstMilestone: true,
      interfaceSignatures: [],
    });
    expect(first).toContain('Write the HTML file directly');
    expect(first).toContain('CURRENT MILESTONE: M0');

    const later = buildMilestonePrompt({
      artifactPath: '/tmp/game.html',
      gameplan,
      milestone: M2,
      isFirstMilestone: false,
      interfaceSignatures: [],
    });
    expect(later).toContain('Read the file first');
    expect(later).toContain('minimal Edits');
    expect(later).toContain('do NOT rewrite parts that already work');
  });

  it('echoes existing interface signatures verbatim (anti-drift)', () => {
    const prompt = buildMilestonePrompt({
      artifactPath: '/tmp/game.html',
      gameplan,
      milestone: M1,
      isFirstMilestone: false,
      interfaceSignatures: ['class Player', 'update(dt, input, level)'],
    });
    expect(prompt).toContain('EXISTING INTERFACES');
    expect(prompt).toContain('class Player');
    expect(prompt).toContain('update(dt, input, level)');
    expect(prompt).toContain('do not change arity or rename');
  });

  it('retry mode leads with the probe failures and forbids rewriting working parts', () => {
    const prompt = buildMilestonePrompt({
      artifactPath: '/tmp/game.html',
      gameplan,
      milestone: M2,
      isFirstMilestone: false,
      interfaceSignatures: [],
      retryFailures: ['stomp_enemy: enemiesDefeated did not increase'],
    });
    expect(prompt).toContain('FAILED its probe');
    expect(prompt).toContain('stomp_enemy: enemiesDefeated did not increase');
    expect(prompt).toContain('fix ONLY these');
  });

  it('every milestone prompt carries the GAMEPLAN and the shared-state hard rule', () => {
    for (const m of PLATFORMER_MILESTONES) {
      const prompt = buildMilestonePrompt({
        artifactPath: '/tmp/game.html',
        gameplan,
        milestone: m,
        isFirstMilestone: m.id === 'M0',
        interfaceSignatures: [],
      });
      expect(prompt).toContain('GAMEPLAN');
      expect(prompt).toContain('share the same live game state');
      expect(prompt).toContain('Deliver ONLY this milestone');
    }
  });
});

// ============================================================================
// Interface extraction (anti-drift, ab-test A1 root cause)
// ============================================================================

describe('extractInterfaceSignatures', () => {
  it('extracts classes, functions, arrow consts, and known game-loop methods', () => {
    const html = `
      <script>
        class Player {
          update(dt, input, level) { this.x += 1; }
          jump() {}
        }
        class Enemy {}
        function gameLoop(timestamp) {}
        const spawnEnemy = (type, x) => { return new Enemy(); };
        function helperNoise() {}
      </script>`;
    const sigs = extractInterfaceSignatures(html);
    expect(sigs).toContain('class Player');
    expect(sigs).toContain('class Enemy');
    expect(sigs).toContain('function gameLoop(timestamp)');
    expect(sigs).toContain('spawnEnemy(type, x)');
    // The A1 drift case: Player.update's exact arity must be captured.
    expect(sigs).toContain('update(dt, input, level)');
    // Unknown method names are filtered as noise; top-level functions are kept.
    expect(sigs).toContain('function helperNoise()');
    expect(sigs.filter((s) => s === 'jump()')).toHaveLength(0);
  });

  it('returns empty for empty/absent artifact content', () => {
    expect(extractInterfaceSignatures('')).toEqual([]);
  });

  it('dedupes repeated signatures', () => {
    const html = 'class A {} class A {}';
    expect(extractInterfaceSignatures(html)).toEqual(['class A']);
  });
});

// ============================================================================
// Milestone evaluation — real gen8 failure strings
// ============================================================================

describe('evaluateMilestone', () => {
  it('M0 is blocked by snapshot-path/contract failures (gen8 step 7 class)', () => {
    const result = evaluateMilestone(
      M0,
      summary([], [
        'reachability step 7 的 metric "abilities.doubleJump" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。',
      ]),
    );
    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toHaveLength(1);
  });

  it('M0 is blocked by gameplayMechanics metadata-shape failures', () => {
    const result = evaluateMilestone(
      M0,
      summary([
        'platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。',
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it('M0 is NOT blocked by missing later-mechanic runtime evidence', () => {
    const result = evaluateMilestone(
      M0,
      summary([], [
        'stomp_enemy: enemiesDefeated did not increase',
        'bump_block: blocksUsed did not increase',
        'gain_ability: doubleJump is still false',
      ]),
    );
    expect(result.passed).toBe(true);
  });

  it('M0 is NOT blocked by coverage-completeness of promised rewards/risks (deepseek regression)', () => {
    // These require mechanics to be IMPLEMENTED (M2/M3), so a static M0 skeleton
    // must not be blocked by them — else the pipeline never leaves M0.
    const result = evaluateMilestone(
      M0,
      summary([
        'coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。',
        'coverage 没有覆盖 qualityPlan 承诺的风险、敌人或失败约束。',
      ]),
    );
    expect(result.passed).toBe(true);
  });

  it('M4 (final pass) DOES block on coverage-completeness of promised content', () => {
    const result = evaluateMilestone(
      M4,
      summary(['coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。']),
    );
    expect(result.passed).toBe(false);
  });

  it('M1 is blocked by movement failures but not by enemy/block failures', () => {
    const movementFailure = evaluateMilestone(
      M1,
      summary([], [
        'default start state 的 reachability step 8 没有让 player.x 满足 increase。 input=ArrowRight, frames=120, before=1496, after=1496。',
      ]),
    );
    expect(movementFailure.passed).toBe(false);

    const laterMechanics = evaluateMilestone(
      M1,
      summary([], [
        'stomp_enemy: enemiesDefeated did not increase',
        'bump_block: blocksUsed did not increase',
        'unlock_gate: gatesUnlocked did not increase',
      ]),
    );
    expect(laterMechanics.passed).toBe(true);
  });

  it('M2 is blocked by stomp failures AND inherits M1 movement patterns (anti-regression)', () => {
    const stomp = evaluateMilestone(
      M2,
      summary([], ['stomp_enemy: enemiesDefeated did not increase']),
    );
    expect(stomp.passed).toBe(false);

    const movementRegression = evaluateMilestone(
      M2,
      summary([], ['move_right: player.x did not increase']),
    );
    expect(movementRegression.passed).toBe(false);
  });

  it('M3 is blocked by block/ability/gate/combo and reachability failures', () => {
    const failures = [
      'bump_block: blocksUsed did not increase',
      'gain_ability: doubleJump is still false',
      'unlock_gate: gatesUnlocked did not increase',
      'comboChallenge: block bump not achieved',
    ];
    for (const f of failures) {
      expect(evaluateMilestone(M3, summary([], [f])).passed).toBe(false);
    }
  });

  it('M4 is blocked by browser visual failures', () => {
    const result = evaluateMilestone(M4, {
      artifactPath: '/tmp/x.html',
      passed: false,
      failures: [],
      browserFailures: ['desktop visual smoke found only blank canvas pixels'],
    });
    expect(result.passed).toBe(false);
  });

  it('every milestone is blocked by global blockers (crash / artifact missing)', () => {
    for (const m of PLATFORMER_MILESTONES) {
      expect(
        evaluateMilestone(m, summary(['Artifact was not written; generation failed: timeout'])).passed,
      ).toBe(false);
      expect(
        evaluateMilestone(m, summary([], ['runtime page errors: TypeError: Cannot read properties of undefined'])).passed,
      ).toBe(false);
    }
  });

  it('a clean summary passes every milestone', () => {
    for (const m of PLATFORMER_MILESTONES) {
      expect(evaluateMilestone(m, summary([])).passed).toBe(true);
    }
  });
});

// ============================================================================
// Casebook（.logs 病历）
// ============================================================================

describe('casebook', () => {
  it('casebookPathFor puts the log next to the artifact under .logs/', () => {
    expect(casebookPathFor('/work/games/foo.html')).toBe('/work/games/.logs/foo.progress.md');
  });

  it('formatCasebookEntry renders stage, probe and trimmed details', () => {
    const text = formatCasebookEntry({
      stage: 'M1 attempt 2',
      goal: 'movement',
      action: 'retry with probe feedback (minimal edits)',
      probeResult: 'FAIL',
      details: ['move_right: player.x did not increase'],
      conclusion: 'probe failed — retrying inside milestone',
    });
    expect(text).toContain('## M1 attempt 2');
    expect(text).toContain('- probe: FAIL');
    expect(text).toContain('move_right');
  });

  it('appendCasebook + readCasebookTail roundtrip; preamble warns against blind repair', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-casebook-'));
    const artifact = path.join(dir, 'game.html');
    await appendCasebook(artifact, {
      stage: 'M0 attempt 1',
      goal: 'contract skeleton',
      action: 'deliver milestone',
      probeResult: 'PASS',
      details: [],
      conclusion: 'milestone probe passed — advancing',
    });
    await appendCasebook(artifact, {
      stage: 'M1 attempt 1',
      goal: 'movement',
      action: 'deliver milestone',
      probeResult: 'FAIL',
      details: ['jump: player.y did not change'],
      conclusion: 'probe failed — retrying inside milestone',
    });

    const tail = await readCasebookTail(artifact);
    expect(tail).toContain('M0 attempt 1');
    expect(tail).toContain('M1 attempt 1');

    const preamble = buildCasebookPreamble(tail);
    expect(preamble).toContain('Do NOT repeat approaches already marked FAIL');
    expect(preamble).toContain('M1 attempt 1');
  });

  it('readCasebookTail returns empty string when no casebook exists; preamble stays empty', async () => {
    const tail = await readCasebookTail('/nonexistent/dir/game.html');
    expect(tail).toBe('');
    expect(buildCasebookPreamble(tail)).toBe('');
  });
});

// ============================================================================
// Pipeline orchestration
// ============================================================================

const TWO_MILESTONES: MilestoneSpec[] = [
  {
    id: 'M0',
    title: 'contract',
    goals: ['contract'],
    blockingFailurePatterns: [/contract-broken/],
  },
  {
    id: 'M1',
    title: 'movement',
    goals: ['movement'],
    blockingFailurePatterns: [/movement-broken/],
  },
];

describe('runCodexMilestonePipeline', () => {
  it('runs every milestone once when probes pass; completed=true', async () => {
    const prompts: string[] = [];
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return { responses: ['ok'], toolCount: 2, errors: [] };
      }),
      probe: vi.fn(async () => summary([])),
      readArtifact: async () => 'class Player {}',
      milestones: TWO_MILESTONES,
    });

    expect(result.completed).toBe(true);
    expect(result.milestones).toHaveLength(2);
    expect(result.milestones.every((m) => m.passed && m.attempts === 1)).toBe(true);
    expect(result.toolCount).toBe(4);
    // M1's prompt must echo the interfaces extracted from the artifact.
    expect(prompts[1]).toContain('class Player');
  });

  it('retries inside a milestone with probe feedback, then advances', async () => {
    const prompts: string[] = [];
    const contexts: Array<{ milestoneId: string; attempt: number; retryFailures?: string[] }> = [];
    let m1Probes = 0;
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async (prompt: string, context) => {
        prompts.push(prompt);
        contexts.push({
          milestoneId: context.milestone.id,
          attempt: context.attempt,
          retryFailures: context.retryFailures,
        });
        return { responses: ['ok'], toolCount: 1, errors: [] };
      }),
      probe: vi.fn(async () => {
        // M0 probe passes; M1 fails once then passes.
        if (prompts.length <= 1) return summary([]);
        m1Probes += 1;
        return m1Probes === 1 ? summary([], ['movement-broken: jump missing']) : summary([]);
      }),
      readArtifact: async () => '<html><script>class G {}</script></html>',
      milestones: TWO_MILESTONES,
      milestoneRetryCap: 1,
    });

    expect(result.completed).toBe(true);
    expect(result.milestones[1].attempts).toBe(2);
    // The retry prompt carries the probe failure.
    expect(prompts[2]).toContain('movement-broken: jump missing');
    expect(prompts[2]).toContain('FAILED its probe');
    expect(contexts.map((c) => `${c.milestoneId}:${c.attempt}`)).toEqual(['M0:1', 'M1:1', 'M1:2']);
    expect(contexts[2].retryFailures).toEqual(['movement-broken: jump missing']);
  });

  it('stops the pipeline when a milestone fails after retries; later milestones never run', async () => {
    const entries: string[] = [];
    const generateMilestone = vi.fn(async () => ({ responses: [], toolCount: 0, errors: [] }));
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone,
      probe: vi.fn(async () => summary([], ['contract-broken: no snapshot'])),
      readArtifact: async () => '<html><script>class G {}</script></html>',
      milestones: TWO_MILESTONES,
      milestoneRetryCap: 1,
      appendLog: async (entry) => {
        entries.push(`${entry.stage}: ${entry.probeResult}`);
      },
    });

    expect(result.completed).toBe(false);
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0].passed).toBe(false);
    // attempt 1 + 1 retry = 2 generation calls, M1 never generated.
    expect(generateMilestone).toHaveBeenCalledTimes(2);
    expect(entries).toEqual(['M0 attempt 1: FAIL', 'M0 attempt 2: FAIL']);
  });

  it('does NOT vacuously pass when generation reports errors but probe would pass (invalid-key regression)', async () => {
    // Repro of the 2026-06-11 mimo run: API returned "Invalid API Key", the
    // adapter captured it in errors (no throw, empty response, no artifact),
    // and a missing-artifact probe is non-blocking → milestone falsely PASSED.
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async () => ({
        responses: [],
        toolCount: 0,
        errors: ['Invalid API Key'],
      })),
      // Probe would say "all clear" (simulating the validator treating a missing
      // artifact as non-blocking) — the pipeline must still NOT trust it.
      probe: vi.fn(async () => summary([])),
      readArtifact: async () => '',
      milestones: TWO_MILESTONES,
      milestoneRetryCap: 0,
    });

    expect(result.completed).toBe(false);
    expect(result.milestones[0].passed).toBe(false);
    expect(result.errors.join(' ')).toContain('Invalid API Key');
  });

  it('does NOT vacuously pass when no artifact is written even with no errors', async () => {
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async () => ({ responses: ['ok'], toolCount: 1, errors: [] })),
      probe: vi.fn(async () => summary([])),
      readArtifact: async () => '', // nothing written
      milestones: TWO_MILESTONES,
      milestoneRetryCap: 0,
    });

    expect(result.completed).toBe(false);
    expect(result.milestones[0].passed).toBe(false);
    expect(result.milestones[0].blockingFailures.join(' ')).toMatch(/no artifact/i);
  });

  it('records a generation error (e.g. timeout) and stops without throwing', async () => {
    const result = await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async () => {
        throw new Error('Milestone generation timed out after 120000ms');
      }),
      probe: vi.fn(async () => summary([])),
      readArtifact: async () => '',
      milestones: TWO_MILESTONES,
      milestoneRetryCap: 0,
    });

    expect(result.completed).toBe(false);
    expect(result.errors.join(' ')).toContain('timed out');
    expect(result.milestones[0].passed).toBe(false);
  });

  it('writes casebook entries for every attempt with pass/fail conclusions', async () => {
    const entries: Array<{ stage: string; probeResult: string; conclusion: string }> = [];
    await runCodexMilestonePipeline('/tmp/game.html', {
      generateMilestone: vi.fn(async () => ({ responses: [], toolCount: 0, errors: [] })),
      probe: vi.fn(async () => summary([])),
      readArtifact: async () => '<html><script>class G {}</script></html>',
      milestones: TWO_MILESTONES,
      appendLog: async (entry) => {
        entries.push({
          stage: entry.stage,
          probeResult: entry.probeResult,
          conclusion: entry.conclusion,
        });
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].stage).toBe('M0 attempt 1');
    expect(entries[0].probeResult).toBe('PASS');
    expect(entries[0].conclusion).toContain('advancing');
  });
});
