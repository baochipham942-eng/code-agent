/**
 * Codex-style milestone-incremental generation strategy for the platformer
 * acceptance harness (docs/designs/game-gen-codex-workflow.md, W1-W4).
 *
 * Instead of one "create the whole game" prompt, generation is organized as:
 *   GAMEPLAN (deterministic, from contract vocabulary)
 *   → M0 contract skeleton (probe: contract self-check)
 *   → M1 movement+jump → M2 enemy+stomp → M3 block/ability/gate/combo
 *   → M4 levels + visual polish (probe: full validation)
 * Each milestone is one small model call; its prompt echoes the previous
 * milestone's interface signatures (anti-drift, games/ab-test/REPORT.md A1
 * root cause) and is probed with the real runtime smoke before advancing.
 * Every attempt is appended to a `.logs/` casebook that later repair rounds
 * read, so repairs stop being blind (gen8 round2 regressed 28 checks).
 *
 * The acceptance loop above this (BoN / repair cap / monotonicity) is
 * unchanged — this module only provides a different way to produce round-0
 * candidates plus casebook context for repair prompts.
 */

import fs from 'fs/promises';
import path from 'path';
import type { GenerationOutcome, ValidationSummary } from './platformer-gameplay-generation.ts';

export type MilestoneId = 'M0' | 'M1' | 'M2' | 'M3' | 'M4';

export interface MilestoneSpec {
  id: MilestoneId;
  title: string;
  /** Prompt bullet lines describing what this milestone must deliver. */
  goals: string[];
  /**
   * Failure strings (static + runtime) matching any of these patterns BLOCK
   * this milestone. Patterns accumulate: a milestone is also blocked by any
   * earlier milestone's patterns (anti-regression while building up).
   */
  blockingFailurePatterns: RegExp[];
}

/**
 * Failures that block EVERY milestone — artifact missing/unparsable, page
 * crashes, or a snapshot()/metadata contract that lies about its own shape.
 * These are exactly the failure classes the design doc says must die at M0.
 */
export const GLOBAL_BLOCKING_PATTERNS: RegExp[] = [
  /Artifact was not written|Artifact does not exist|unparsable|文档结构不完整|incomplete html/i,
  /pageerror|TypeError|ReferenceError|Cannot read properties|页面崩溃/i,
  /无法运行交互 smoke 验收|运行时没有找到 runSmokeTest|运行时测试合约缺少 start 或 snapshot|runSmokeTest 抛出异常|runSmokeTest 超过 \d+ms/i,
  /不在 snapshot\(\) 结果里|__GAME_META__|__GAME_TEST__/,
  /step\(inputState|reset\(levelOrScenario/,
];

export const PLATFORMER_MILESTONES: MilestoneSpec[] = [
  {
    id: 'M0',
    title: 'Contract skeleton（契约骨架）',
    goals: [
      'Create the single-file HTML skeleton: canvas, HUD placeholders, requestAnimationFrame loop that renders a visibly non-blank scene (background, ground, a readable stickman actor standing idle with head/torso/arms/legs).',
      'Define the COMPLETE window.__GAME_META__ now: subtype "platformer", controls, levels, qualityPlan, progressPlan, browserVisualSmoke, and gameplayMechanics as ARRAYS (never object maps) with this exact shape: enemies:[{id,type,stompable,patrol,defeatReward}], blocks:[{id,type,bumpableFromBelow,reward,usedState}], abilities:[{id,type,acquiredFrom,effect,unlocksRoute}], gates:[{id,requiresAbility,blocksAccessTo}], comboChallenge:[{id,requires,target}].',
      'Define window.__GAME_TEST__ with start(), reset(levelOrScenario?), snapshot(), step(inputState, frames?), and runSmokeTest(). They must be wired to ONE shared live game state object from day one — never a parallel test-only state.',
      'snapshot() must already expose every metric path that progressPlan/reachability and gameplayMechanics will reference later (player.x, player.y, score, enemiesDefeated, blocksUsed, abilities.*, gatesUnlocked). Initialize them to honest zero/false values.',
      'reset(levelOrScenario?) must accept both the string level ids declared in __GAME_META__.levels and numeric indexes.',
      'Each progressPlan/reachability step uses the field name "expect" (not "expectation") with value increase/decrease/change; metric must be a real snapshot() path. runSmokeTest() must return { passed, checks: string[], failures: string[], coverage } — checks is a STRING ARRAY, never numbers.',
      'Order progressPlan/reachability steps by mechanic: movement/jump steps first, then enemy, block, ability, gate, combo. An early step must never require a later mechanic to succeed (e.g. do not target an end-of-level player.x that needs gates open).',
      'Declare exactly one level for the skeleton unless every declared level can already be driven to completion by runSmokeTest — coverage must prove all authored levels reachable.',
      'Game mechanics behavior (enemy AI, stomp, blocks, abilities, gates) is NOT required yet — declare them in metadata, expose their state in snapshot(), but the world may be static.',
    ],
    // M0 blocks ONLY on structure/shape/contract-existence a STATIC skeleton can
    // satisfy. Coverage/completeness failures ("coverage 没有覆盖 qualityPlan 承诺的
    // 奖励/风险") require mechanics to be IMPLEMENTED — they belong to M3/M4, not
    // M0. Keeping them here over-blocked M0 so the pipeline could never progress
    // to M1-M4 (verified 2026-06-11 deepseek run: M0 stuck on coverage-of-rewards).
    blockingFailurePatterns: [
      /不在 snapshot\(\) 结果里/,                                          // snapshot path missing
      /gameplayMechanics 必须|object maps|缺少 gameplayMechanics|comboChallenge 必须组合/,  // mechanics META shape (arrays not maps)
      /runSmokeTest\.checks 必须|必须是字符串数组|不能返回数字/,            // runSmokeTest return shape
      /input: "none"|acceptance: \[|缺少可执行输入|没有暴露可执行的 reachability/, // plan field validity
    ],
  },
  {
    id: 'M1',
    title: 'Movement & jump physics（移动与跳跃）',
    goals: [
      'Implement left/right movement and jumping with gravity, friction, and ground/platform collision, driven by the controls declared in __GAME_META__ (ArrowLeft/ArrowRight/Space or equivalents).',
      'step(inputState, frames) must drive EXACTLY the same update/collision code as the playable loop. After step({ArrowRight:true}, 30), snapshot().player.x must increase; after a jump input, player.y must change and vy go negative.',
      'Update runSmokeTest() to prove movement and jump with before/after snapshot evidence from real step() inputs.',
    ],
    blockingFailurePatterns: [
      /move_right|jump:|player\.x 满足|player\.y 满足|player\.x increased|player\.y/,
      /snapshot changed after declared controls/,
    ],
  },
  {
    id: 'M2',
    title: 'Enemy & stomp（敌人与踩踏）',
    goals: [
      'Implement the patrolling stompable enemy declared in __GAME_META__.gameplayMechanics.enemies: it moves, damages the player on side contact, and is defeated when stomped from above (player bounces, vy goes negative, enemiesDefeated increases, defeatReward granted).',
      'Place at least one enemy reachable from the default start state within a short ArrowRight+Space input sequence, so reachability probes can hit it.',
      'Extend runSmokeTest() with stomp evidence: before/after snapshots showing enemiesDefeated increase and the player bounce.',
    ],
    blockingFailurePatterns: [/stomp_enemy|enemiesDefeated|stompable/i],
  },
  {
    id: 'M3',
    title: 'Block / ability / gate / combo（方块、能力、门与组合挑战）',
    goals: [
      'Implement the bumpable/question block: bumping from below changes it to used/bumped state, increases blocksUsed, and spawns its declared reward.',
      'Implement the route-changing ability (e.g. doubleJump): acquired from its declared source through real input, flips snapshot().abilities.<id> false→true, and visibly changes movement rules.',
      'Implement the ability-gated route: before the ability the gated target is unreachable; after acquiring it, gate/route state changes (gatesUnlocked increases or reachableTarget becomes reachable).',
      'Implement the comboChallenge combining jump plus at least two of stomp/block/ability/gate, and make the full chain reachable from the default start state.',
      'Extend runSmokeTest() to prove block bump, ability acquisition, gate unlock, and the combo with before/after snapshot evidence.',
    ],
    blockingFailurePatterns: [
      /bump_block|blocksUsed|bumpable/i,
      /gain_ability|ability 必须|abilities|doubleJump/i,
      /unlock_gate|gatesUnlocked|gate 必须|requiresAbility|reachableTarget|Gate remained locked/i,
      /combo/i,
      /reachability step/,
    ],
  },
  {
    id: 'M4',
    title: 'Levels & visual polish（关卡与视觉打磨）',
    goals: [
      'Fill in level content and visual quality: readable HUD (score/lives/level), visible reward, visible risk/hazard, visible goal; strong contrast; meaningful actor size with pose/animation.',
      'Keep the canvas responsive and visibly non-blank on desktop AND mobile viewports.',
      'Final pass over runSmokeTest()/progressPlan: every declared reachability step must drive real state change from the default start state; remove or fix any step that does not.',
    ],
    blockingFailurePatterns: [
      /visual smoke|canvas|viewport|nonblank|crop|首屏|actor|HUD/i,
      // Coverage/completeness of promised qualityPlan content (rewards/risks) and
      // all-levels-reachable are FINAL-PASS concerns — they require mechanics built
      // in M2/M3, so they gate here (the last milestone), not M0.
      /coverage 没有覆盖 qualityPlan|coverage 没有证明.*levels|可推进通关/,
    ],
  },
];

/** Deterministic GAMEPLAN — the mechanics vocabulary comes from the contract, not the model. */
export function buildGameplan(artifactPath: string): string {
  return [
    '# GAMEPLAN — single-file browser platformer',
    '',
    `Artifact: ${artifactPath}`,
    '',
    '## Player goal & core loop',
    '- Move right through a side-scrolling level, defeat/avoid enemies, collect rewards, unlock the gated route, reach the goal.',
    '- Core loop: run → jump → stomp enemies → bump blocks → gain ability → pass gate → goal.',
    '',
    '## Controls',
    '- ArrowLeft/ArrowRight: move. Space (or ArrowUp): jump. All controls declared in __GAME_META__.controls.',
    '',
    '## Win / lose',
    '- Win: reach the goal marker. Lose: health/lives exhausted from enemy contact or falling off the map.',
    '',
    '## Mechanics checklist (acceptance contract vocabulary — implement ALL)',
    '- enemies: [{ id, type, stompable, patrol, defeatReward }] — at least one stompable patroller.',
    '- blocks: [{ id, type, bumpableFromBelow, reward, usedState }] — at least one bumpable/question block.',
    '- abilities: [{ id, type, acquiredFrom, effect, unlocksRoute }] — e.g. doubleJump, acquired through real input.',
    '- gates: [{ id, requiresAbility, blocksAccessTo }] — locked until the ability is gained.',
    '- comboChallenge: [{ id, requires, target }] — jump + at least two of stomp/block/ability/gate.',
    '',
    '## Test contract (window.__GAME_TEST__)',
    '- start(), reset(levelOrScenario?), snapshot(), step(inputState, frames?), runSmokeTest().',
    '- step() and the playable loop share one live state. snapshot() exposes player.x/player.y/score/enemiesDefeated/blocksUsed/abilities/gatesUnlocked.',
    '- runSmokeTest() proves every mechanic with before/after snapshot evidence from real step() inputs.',
    '',
    '## Milestones (built in this order, each verified before the next)',
    ...PLATFORMER_MILESTONES.map((m) => `- ${m.id}: ${m.title}`),
  ].join('\n');
}

/**
 * Extract class / function / contract signatures from the current artifact so
 * the next milestone's prompt can echo them verbatim. This is the anti-drift
 * insurance from games/ab-test/REPORT.md (seg2 wrote Player.update(dt, input,
 * level), seg3 called player.update(dt) — 419 pageerrors/frame).
 */
export function extractInterfaceSignatures(html: string): string[] {
  const signatures: string[] = [];
  const classRe = /class\s+([A-Za-z_$][\w$]*)/g;
  const methodRe = /^\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm;
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  const constFnRe = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(([^)]*)\)\s*(?:=>|\{)/g;

  for (const match of html.matchAll(classRe)) {
    signatures.push(`class ${match[1]}`);
  }
  for (const match of html.matchAll(fnRe)) {
    signatures.push(`function ${match[1]}(${match[2].trim()})`);
  }
  for (const match of html.matchAll(constFnRe)) {
    signatures.push(`${match[1]}(${match[2].trim()})`);
  }
  // Methods are noisy — only keep well-known game-loop/contract names.
  const keepMethods = /^(update|render|draw|step|reset|snapshot|start|runSmokeTest|handleInput|applyPhysics|checkCollisions?)$/;
  for (const match of html.matchAll(methodRe)) {
    if (keepMethods.test(match[1])) {
      signatures.push(`${match[1]}(${match[2].trim()})`);
    }
  }
  return [...new Set(signatures)];
}

export function buildMilestonePrompt(params: {
  artifactPath: string;
  gameplan: string;
  milestone: MilestoneSpec;
  isFirstMilestone: boolean;
  interfaceSignatures: string[];
  /** Set on in-milestone retry: blocking failures from this milestone's probe. */
  retryFailures?: string[];
  /**
   * Lean mode for thinking-prone models (e.g. mimo): drop the verbose inline
   * GAMEPLAN so the prompt stays well under ~1K tokens. Empirically (2026-06-11)
   * mimo-v2.5-pro runs away into reasoning at ~1.1K-token prompts (313s, 0
   * content) but completes cleanly at ~200-token prompts (25s, clean stop) —
   * the milestone goals already carry the full contract spec, so GAMEPLAN is
   * redundant context that only pushes the prompt over the threshold.
   */
  lean?: boolean;
}): string {
  const { milestone } = params;
  const lines: string[] = [];

  if (params.retryFailures && params.retryFailures.length > 0) {
    lines.push(
      `Milestone ${milestone.id} (${milestone.title}) of the platformer at this exact path FAILED its probe:`,
      `  ${params.artifactPath}`,
      '',
      'Probe failures to fix (fix ONLY these, with minimal Edits — do NOT rewrite working parts):',
      ...params.retryFailures.slice(0, 8).map((f) => `- ${f}`),
      '',
    );
  } else if (params.isFirstMilestone) {
    lines.push(
      `You are building a single-file browser platformer game incrementally, milestone by milestone.`,
      `Write the HTML file directly at this exact path: ${params.artifactPath}`,
      '',
    );
  } else {
    lines.push(
      `Continue building the single-file browser platformer at this exact path: ${params.artifactPath}`,
      '',
      'Read the file first. Extend it with minimal Edits/appends — do NOT rewrite parts that already work.',
      '',
    );
  }

  if (params.lean) {
    lines.push('Build a side-scrolling single-file HTML platformer, one milestone at a time. Output raw HTML only, no prose.', '');
  } else {
    lines.push('=== GAMEPLAN (the plan of record — follow it) ===', params.gameplan, '');
  }
  lines.push(
    `=== CURRENT MILESTONE: ${milestone.id} — ${milestone.title} ===`,
    ...milestone.goals.map((g) => `- ${g}`),
  );

  if (params.interfaceSignatures.length > 0) {
    lines.push(
      '',
      '=== EXISTING INTERFACES (call them EXACTLY with these signatures — do not change arity or rename) ===',
      ...params.interfaceSignatures.slice(0, 30).map((s) => `- ${s}`),
    );
  }

  lines.push(
    '',
    'Hard rules:',
    '- Deliver ONLY this milestone. Do not implement later milestones early; do not break earlier ones.',
    '- step() and the playable loop must share the same live game state and collision logic.',
    '- coverage.mechanics/rewards/risks/stateChanges must be named arrays or boolean evidence maps, not numbers.',
    '- Do not use input: "none" in progressPlan or reachability.',
  );

  return lines.join('\n');
}

export interface MilestoneEvaluation {
  passed: boolean;
  blockingFailures: string[];
}

/**
 * A milestone passes when no failure (static + runtime) matches the global
 * blockers, its own patterns, or any EARLIER milestone's patterns. Later
 * milestones' mechanics are expected to be missing — their failures don't
 * block yet.
 */
export function evaluateMilestone(
  milestone: MilestoneSpec,
  summary: ValidationSummary,
  milestones: MilestoneSpec[] = PLATFORMER_MILESTONES,
): MilestoneEvaluation {
  const idx = milestones.findIndex((m) => m.id === milestone.id);
  const activePatterns = [
    ...GLOBAL_BLOCKING_PATTERNS,
    ...milestones.slice(0, idx + 1).flatMap((m) => m.blockingFailurePatterns),
  ];
  const allFailures = [
    ...(summary.failures ?? []),
    ...(summary.runtimeFailures ?? []),
    ...(summary.browserFailures ?? []),
  ];
  const blockingFailures = allFailures.filter((f) => activePatterns.some((p) => p.test(f)));
  return { passed: blockingFailures.length === 0, blockingFailures };
}

// ============================================================================
// Casebook（.logs 跨轮病历）— W4
// ============================================================================

export interface CasebookEntry {
  stage: string; // e.g. 'M1 attempt 1', 'repair round 2'
  goal: string;
  action: string;
  /** DISPATCHED = repair round sent; its validation outcome lands in the next entry/report. */
  probeResult: 'PASS' | 'FAIL' | 'ERROR' | 'DISPATCHED';
  details: string[];
  conclusion: string;
}

export function casebookPathFor(artifactPath: string): string {
  const dir = path.join(path.dirname(artifactPath), '.logs');
  const base = path.basename(artifactPath).replace(/\.html?$/i, '');
  return path.join(dir, `${base}.progress.md`);
}

export function formatCasebookEntry(entry: CasebookEntry): string {
  return [
    `## ${entry.stage}`,
    `- goal: ${entry.goal}`,
    `- action: ${entry.action}`,
    `- probe: ${entry.probeResult}`,
    ...(entry.details.length > 0
      ? ['- details:', ...entry.details.slice(0, 10).map((d) => `  - ${d}`)]
      : []),
    `- conclusion: ${entry.conclusion}`,
    '',
  ].join('\n');
}

export async function appendCasebook(artifactPath: string, entry: CasebookEntry): Promise<void> {
  const logPath = casebookPathFor(artifactPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, formatCasebookEntry(entry), 'utf-8');
}

/** Last `maxLines` lines of the casebook, for injection into repair prompts. */
export async function readCasebookTail(artifactPath: string, maxLines = 60): Promise<string> {
  try {
    const content = await fs.readFile(casebookPathFor(artifactPath), 'utf-8');
    const lines = content.trimEnd().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Repair prompt extension — prepends the casebook so the repair model knows
 * what was already tried and what is already working (W4: 带病历的修，不是盲修).
 */
export function buildCasebookPreamble(casebookTail: string): string {
  if (!casebookTail.trim()) return '';
  return [
    '=== BUILD & REPAIR HISTORY (casebook — read before editing) ===',
    'The log below records what each previous attempt tried and how its probe went.',
    'Do NOT repeat approaches already marked FAIL. Do NOT touch mechanics whose probes are marked PASS.',
    '',
    casebookTail,
    '',
    '=== END HISTORY ===',
    '',
  ].join('\n');
}

// ============================================================================
// Milestone pipeline orchestration（W1+W2+W3 编排）
// ============================================================================

export interface MilestoneOutcome {
  milestoneId: MilestoneId;
  attempts: number;
  passed: boolean;
  blockingFailures: string[];
  generationErrors: string[];
}

export interface CodexGenerationResult extends GenerationOutcome {
  milestones: MilestoneOutcome[];
  /** True when every milestone (M0..M4) passed its probe. */
  completed: boolean;
}

export interface MilestoneGenerationContext {
  milestone: MilestoneSpec;
  attempt: number;
  retryFailures?: string[];
}

export interface CodexPipelineDeps {
  /** One model call delivering one milestone (or one in-milestone retry). */
  generateMilestone: (prompt: string, context: MilestoneGenerationContext) => Promise<GenerationOutcome>;
  /** Runtime-smoke probe (browser smoke not required for M0-M3). */
  probe: (artifactPath: string) => Promise<ValidationSummary>;
  readArtifact: (artifactPath: string) => Promise<string | null>;
  log?: (message: string) => void;
  appendLog?: (entry: CasebookEntry) => Promise<void>;
  milestones?: MilestoneSpec[];
  /** In-milestone retries after a failed probe. Default 1 (audit §7: self-repair stays small). */
  milestoneRetryCap?: number;
  /**
   * Lean prompts (drop inline GAMEPLAN). Default true — required for thinking-prone
   * models like mimo and strictly cheaper for everyone. See buildMilestonePrompt.
   */
  lean?: boolean;
}

/**
 * Run the milestone pipeline once = produce one round-0 candidate.
 * Stops early when a milestone still fails after its retries — the acceptance
 * loop's repair rounds (with casebook context) take over from there.
 */
export async function runCodexMilestonePipeline(
  artifactPath: string,
  deps: CodexPipelineDeps,
): Promise<CodexGenerationResult> {
  const milestones = deps.milestones ?? PLATFORMER_MILESTONES;
  const retryCap = deps.milestoneRetryCap ?? 1;
  const log = deps.log ?? (() => {});
  const appendLog = deps.appendLog ?? (async () => {});
  const gameplan = buildGameplan(artifactPath);

  const responses: string[] = [];
  const errors: string[] = [];
  let toolCount = 0;
  const outcomes: MilestoneOutcome[] = [];

  for (let i = 0; i < milestones.length; i += 1) {
    const milestone = milestones[i];
    const html = (await deps.readArtifact(artifactPath)) ?? '';
    const interfaceSignatures = extractInterfaceSignatures(html);

    let attempts = 0;
    let evaluation: MilestoneEvaluation = { passed: false, blockingFailures: [] };
    let retryFailures: string[] | undefined;
    const generationErrors: string[] = [];

    while (attempts <= retryCap) {
      attempts += 1;
      const prompt = buildMilestonePrompt({
        artifactPath,
        gameplan,
        milestone,
        isFirstMilestone: i === 0 && attempts === 1,
        interfaceSignatures,
        retryFailures,
        lean: deps.lean ?? true,
      });

      let probeResult: 'PASS' | 'FAIL' | 'ERROR' = 'ERROR';
      try {
        const generation = await deps.generateMilestone(prompt, {
          milestone,
          attempt: attempts,
          retryFailures,
        });
        responses.push(...generation.responses);
        toolCount += generation.toolCount;
        if (generation.errors.length > 0) {
          generationErrors.push(...generation.errors);
        }

        // A failed/empty generation (API error, timeout captured as errors, or
        // no artifact written) must NOT vacuously pass: the validator treats a
        // missing/non-game artifact as non-blocking, so probing it would falsely
        // report PASS. Gate on real output before trusting the probe.
        const writtenHtml = (await deps.readArtifact(artifactPath)) ?? '';
        if (generation.errors.length > 0) {
          evaluation = {
            passed: false,
            blockingFailures: generation.errors.map((e) => `${milestone.id} generation error: ${e}`),
          };
          probeResult = 'ERROR';
        } else if (writtenHtml.trim().length === 0) {
          evaluation = {
            passed: false,
            blockingFailures: [`${milestone.id}: no artifact was written by the generation step.`],
          };
          probeResult = 'ERROR';
        } else {
          const summary = await deps.probe(artifactPath);
          evaluation = evaluateMilestone(milestone, summary, milestones);
          probeResult = evaluation.passed ? 'PASS' : 'FAIL';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        generationErrors.push(`${milestone.id} attempt ${attempts}: ${message}`);
        evaluation = { passed: false, blockingFailures: [message] };
      }

      log(
        `[codex] ${milestone.id} attempt ${attempts}: ${probeResult}` +
          (evaluation.blockingFailures.length > 0
            ? ` (${evaluation.blockingFailures.length} blocking)`
            : ''),
      );
      await appendLog({
        stage: `${milestone.id} attempt ${attempts}`,
        goal: milestone.title,
        action: retryFailures ? 'retry with probe feedback (minimal edits)' : 'deliver milestone',
        probeResult,
        details: evaluation.blockingFailures,
        conclusion: evaluation.passed
          ? 'milestone probe passed — advancing'
          : attempts <= retryCap
            ? 'probe failed — retrying inside milestone'
            : 'probe failed after retries — handing over to acceptance repair loop',
      });

      if (evaluation.passed) break;
      retryFailures = evaluation.blockingFailures;
    }

    outcomes.push({
      milestoneId: milestone.id,
      attempts,
      passed: evaluation.passed,
      blockingFailures: evaluation.blockingFailures,
      generationErrors,
    });
    errors.push(...generationErrors);

    if (!evaluation.passed) {
      // Stop the pipeline — later milestones build on a broken base. The
      // acceptance loop's repair rounds continue from the casebook.
      break;
    }
  }

  return {
    responses,
    toolCount,
    errors,
    milestones: outcomes,
    completed: outcomes.length === milestones.length && outcomes.every((o) => o.passed),
  };
}
