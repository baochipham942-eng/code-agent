#!/usr/bin/env npx tsx

import { config as loadDotenv } from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { StandaloneAgentAdapter } from '../../src/main/testing/agentAdapter.ts';
import { validateGameArtifact } from '../../src/main/agent/runtime/gameArtifactValidator.ts';
import {
  ACCEPTANCE_DEFAULTS,
  type AcceptanceMonotonicMode,
} from '../../src/shared/constants/acceptance.ts';
import type { MilestoneId } from './platformerCodexStrategy.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');

loadDotenv({ path: path.join(projectRoot, '.env') });

const PROVIDER_KEY_CANDIDATES: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['KIMI_K25_API_KEY', 'MOONSHOT_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
};

const CODEX_LOGIC_MILESTONES = new Set<MilestoneId>(['M0', 'M1', 'M2']);
const CODEX_MIMO_MILESTONES = new Set<MilestoneId>(['M3', 'M4']);
const CODEX_HEAVY_TIMEOUT_MILESTONES = new Set<MilestoneId>(['M2', 'M3']);
const DEFAULT_CODEX_LOGIC_PROVIDER = 'deepseek';
const DEFAULT_CODEX_LOGIC_MODEL = 'deepseek-v4-flash';
const DEFAULT_CODEX_KIMI_MODEL = 'kimi-k2.6';
const DEFAULT_CODEX_MIMO_PROVIDER = 'xiaomi';
const DEFAULT_CODEX_MIMO_MODEL = 'mimo-v2.5-pro';
const DEFAULT_CODEX_HEAVY_MILESTONE_TIMEOUT_MS = 480_000;

export type ValidationSummary = {
  artifactPath: string;
  passed: boolean;
  failures: string[];
  runtimePassed?: boolean;
  runtimeFailures?: string[];
  runtimeChecks?: string[];
  browserPassed?: boolean;
  browserFailures?: string[];
  browserChecks?: string[];
};

export type ProductStatusKind =
  | 'passed'
  | 'blocked'
  | 'quality-gap'
  | 'evidence-gap'
  | 'acceptance-gap';

export type ProductStatusSummary = {
  kind: ProductStatusKind;
  status: string;
  headline: string;
  visibleState: string;
  focus: string[];
  diagnosticsCount: number;
};

export type GenerationOutcome = {
  responses: string[];
  toolCount: number;
  errors: string[];
  /** Codex milestone strategy only: per-milestone probe outcomes (W1-W3). */
  milestones?: Array<{
    milestoneId: string;
    attempts: number;
    passed: boolean;
    blockingFailures: string[];
  }>;
};

export type GenerationStrategy = 'single' | 'codex';

export type CodexMilestoneRouteConfig = {
  logicProvider: string;
  logicModel: string;
  mimoProvider: string;
  mimoModel: string;
  generationTimeoutMs: number;
  heavyMilestoneTimeoutMs: number;
};

export type CodexMilestoneModelRoute = {
  milestoneId: MilestoneId;
  role: 'logic' | 'mimo';
  provider: string;
  model: string;
  timeoutMs: number;
};

export type CandidateResult = {
  candidateId: string;
  artifactPath: string;
  generation: GenerationOutcome | null;
  generationError?: string;
  validation: ValidationSummary;
  score: number;
  passCount: number;
  failCount: number;
};

export type RoundResult = {
  round: number;
  candidates: CandidateResult[];
  selected: CandidateResult;
  passCount: number;
  failCount: number;
  fullyPassed: boolean;
  /** Set when monotonicity gate detects regression vs. previous round */
  regressionAgainstPrevious?: {
    previousPassCount: number;
    previousFailCount: number;
    regressedChecks: string[];
  };
};

export type AcceptanceLoopOutput = {
  rounds: RoundResult[];
  finalResult: RoundResult;
  passedRound?: number;
  bonN: number;
  repairCap: number;
  monotonicMode: AcceptanceMonotonicMode;
  escalated: boolean;
  escalationReason?: string;
};

type AcceptanceCliOutput = {
  mode: 'validate-only' | 'generate-and-validate';
  provider?: string;
  model?: string;
  strategy?: GenerationStrategy;
  codexRoutes?: CodexMilestoneRouteConfig;
  bonN: number;
  repairCap: number;
  monotonicMode: AcceptanceMonotonicMode;
  loop?: AcceptanceLoopOutput;
  validation: ValidationSummary;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

function usage(): void {
  console.log(`Platformer gameplay generation acceptance

Usage:
  npm run acceptance:platformer-gameplay-generation -- [options]

Options:
  --artifact <path>      Target HTML path. Default: games/generated-platformer-regression.html
  --validate-only        Do not call a model; validate an existing artifact.
  --provider <id>        Model provider. Default: PLATFORMER_GAMEPLAY_PROVIDER or openrouter.
  --model <id>           Model id. Default: PLATFORMER_GAMEPLAY_MODEL or google/gemini-3-flash-preview.
  --strategy <id>        Generation strategy: single (one-shot, default) or codex
                       (GAMEPLAN + milestone-incremental with probe self-checks and
                       a .logs/ casebook — see docs/designs/game-gen-codex-workflow.md).
                       env: PLATFORMER_GAMEPLAY_STRATEGY.
  --milestone-retry <n>  codex strategy: in-milestone retries after a failed probe. Default: 1.
  --logic-provider <id>  codex strategy: M0-M2 provider. Default: PLATFORMER_GAMEPLAY_LOGIC_PROVIDER or deepseek.
  --logic-model <id>     codex strategy: M0-M2 model. Default: PLATFORMER_GAMEPLAY_LOGIC_MODEL or deepseek-v4-flash (kimi-k2.6 when provider is moonshot).
  --mimo-provider <id>   codex strategy: M3-M4 provider. Default: PLATFORMER_GAMEPLAY_MIMO_PROVIDER or xiaomi.
  --mimo-model <id>      codex strategy: M3-M4 model. Default: PLATFORMER_GAMEPLAY_MIMO_MODEL or mimo-v2.5-pro.
  --heavy-milestone-timeout <ms>
                       codex strategy: M2/M3 single-segment timeout floor. Default: 480000.
  --generation-timeout <ms>
                       Max time to wait for one agent generation. Default: 120000.
  --timeout <ms>         Runtime smoke timeout. Default: 10000.
  --bon-n <number>       Best-of-N candidate count. Default: ${ACCEPTANCE_DEFAULTS.BON_N}.
                       env: ACCEPTANCE_BON_N. Use --bon-n 1 to restore old single-shot.
  --repair-cap <number>  Max repair rounds after first BoN attempt. Default: ${ACCEPTANCE_DEFAULTS.REPAIR_CAP}.
                       env: ACCEPTANCE_REPAIR_CAP. Use --repair-cap 0 to disable repair.
  --strict-monotonic     Hard fail when a round regresses vs previous (PASS count drops).
                       Default: warn-and-discard regressed round, retry with prior prompt.
  --report [path]        Write a Markdown evidence report. If no path is provided, use <artifact>.validation.md.
  --json                 Print JSON summary only.
  --help                 Show this help.

Hard rules enforced (see docs/audits/2026-05-07-game-acceptance-architecture.md §7):
  - Best-of-N defaults to ${ACCEPTANCE_DEFAULTS.BON_N} candidates per round (execution-filter score).
  - Repair loop hard upper limit ${ACCEPTANCE_DEFAULTS.REPAIR_CAP} rounds, then escalate.
  - Probe-pass monotonicity gate catches v25 -> v26 type silent regressions.

What it validates:
  - a real agent can generate a single-file platformer artifact at the target path
  - the artifact passes static Game Artifact Contract checks
  - browser visual smoke passes on desktop and mobile viewports
  - runtime smoke proves stomp enemy, bump block, ability acquisition, gated route unlock, and comboChallenge evidence`);
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function apiKeyForProvider(provider: string): string | undefined {
  const candidates = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];
  for (const candidate of candidates) {
    const value = envValue(candidate);
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the provider key the same way the app does: env first, then the
 * app's SecureStorage (in-memory only — the key is never written to disk or
 * echoed). Lets the harness run against any provider the user already
 * configured in-app without copying secrets into .env.
 */
async function resolveApiKey(provider: string): Promise<string | undefined> {
  const envKey = apiKeyForProvider(provider);
  if (envKey) return envKey;
  try {
    const { getSecureStorage } = await import('../../src/main/services/core/secureStorage.ts');
    return getSecureStorage().getApiKey(provider) || undefined;
  } catch {
    return undefined;
  }
}

function missingApiKeyMessage(provider: string): string {
  const keys = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];
  return `Missing API key for provider ${provider}. Set one of ${keys.join(', ')}, configure the provider in-app, or run with --validate-only.`;
}

function defaultLogicProvider(): string {
  return DEFAULT_CODEX_LOGIC_PROVIDER;
}

function defaultLogicModel(provider: string): string {
  return provider === 'moonshot' ? DEFAULT_CODEX_KIMI_MODEL : DEFAULT_CODEX_LOGIC_MODEL;
}

export function selectCodexMilestoneModelRoute(
  config: CodexMilestoneRouteConfig,
  milestoneId: MilestoneId,
): CodexMilestoneModelRoute {
  const role = CODEX_LOGIC_MILESTONES.has(milestoneId) ? 'logic' : 'mimo';
  if (!CODEX_LOGIC_MILESTONES.has(milestoneId) && !CODEX_MIMO_MILESTONES.has(milestoneId)) {
    throw new Error(`Unknown codex milestone "${milestoneId}"`);
  }
  return {
    milestoneId,
    role,
    provider: role === 'logic' ? config.logicProvider : config.mimoProvider,
    model: role === 'logic' ? config.logicModel : config.mimoModel,
    timeoutMs: CODEX_HEAVY_TIMEOUT_MILESTONES.has(milestoneId)
      ? Math.max(config.generationTimeoutMs, config.heavyMilestoneTimeoutMs)
      : config.generationTimeoutMs,
  };
}

function resolveArtifactPath(rawPath: string | undefined): string {
  const candidate = rawPath || 'games/generated-platformer-regression.html';
  return path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
}

function resolveReportPath(artifactPath: string, rawPath: string | undefined): string {
  const candidate = rawPath || artifactPath.replace(/\.html?$/i, '.validation.md');
  return path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
}

export function buildGenerationPrompt(artifactPath: string): string {
  return [
    `Create a complete single-file browser platformer game at this exact path: ${artifactPath}`,
    '',
    'Hard requirements:',
    '- Write the HTML file directly. Do not answer with only prose.',
    '- Include window.__GAME_META__ with subtype "platformer", controls, levels, qualityPlan, progressPlan, browserVisualSmoke, and gameplayMechanics.',
    '- If levels use string ids, reset(levelOrScenario?) must accept those exact ids and numeric indexes; do not expose string level ids while reset() only accepts numeric array indexes.',
    '- gameplayMechanics must include enemies, blocks, abilities, gates, and comboChallenge as arrays. Do not write enemies/blocks/abilities/gates/comboChallenge as object maps.',
    '- Use this metadata shape: gameplayMechanics: { enemies: [{ id, type, stompable, patrol, defeatReward }], blocks: [{ id, type, bumpableFromBelow, reward, usedState }], abilities: [{ id, type, acquiredFrom, effect, unlocksRoute }], gates: [{ id, requiresAbility, blocksAccessTo }], comboChallenge: [{ id, requires, target }] }.',
    '- Implement a stompable enemy, a bumpable/question block, a route-changing ability such as doubleJump, an ability-gated route, and one combo challenge combining jump plus at least two of enemy/block/ability/gate play.',
    '- First screen must look like a real game: a readable actor, HUD/controls, visible reward, visible risk/hazard, and visible goal. Do not produce an empty field with only a tiny line actor.',
    '- If using a stickman / 火柴人 actor, draw head, torso, arms, legs, pose/animation, strong contrast, and a meaningful on-screen size.',
    '- Include window.__GAME_TEST__ with start(), reset(levelOrScenario?), snapshot(), step(inputState, frames?), and runSmokeTest().',
    '- Keep executable validation steps in progressPlan or reachability. Do not use acceptance: ["..."] as the reachability plan.',
    '- step() and the playable loop must share the same live game state and collision logic.',
    '- runSmokeTest() must use before/after snapshot evidence from real step() inputs. It must prove stomp enemy, bump block, gain ability, unlock gate/route, and comboChallenge.',
    '- coverage.mechanics, coverage.rewards, coverage.risks, and coverage.stateChanges must be named arrays or boolean evidence maps, not numbers.',
    '- Do not use input: "none" in progressPlan or reachability.',
    '- Keep the canvas responsive and visibly nonblank on desktop and mobile browser smoke.',
  ].join('\n');
}

/**
 * P3 monotonic-repair prompt. Used for round 1+ when a baseline artifact and
 * its validation failures are available — instead of regenerating from scratch
 * (which forfeits anything the baseline already got right to model randomness),
 * we feed the baseline back and ask for a minimal-diff fix.
 *
 * Failure list is trimmed to the top N by priority — runtime mechanic failures
 * first, then static/metadata, then browser visual — to stay well inside the
 * system prompt budget.
 */
export function buildRepairPrompt(artifactPath: string, failures: string[]): string {
  const trimmed = prioritizeFailures(failures).slice(0, 10);
  const failureLines = trimmed.map((f) => `- ${f}`).join('\n');
  return [
    `The platformer artifact at this exact path was generated previously but failed acceptance validation:`,
    `  ${artifactPath}`,
    '',
    'Treat this as an acceptance gap, not a blank failure, unless the artifact is missing, cannot build, or crashes before rendering.',
    'Preserve any working visuals, controls, and playable loop. Fix the smallest gameplay-quality or validation-evidence gaps first.',
    '',
    'Read it first to understand the current state, then fix ONLY the failures listed below by issuing minimal Edits.',
    '',
    'Editing rules (non-negotiable):',
    '- Prefer one Edit per failure, with the narrowest possible old_string.',
    '- Do NOT rewrite working parts of the file.',
    '- Do NOT replace the whole file with Write unless the existing file is fundamentally broken (e.g. unparsable HTML).',
    '- After your Edits the file will be validated again; aim to fix every listed failure without introducing new ones.',
    '',
    `Validation failures to fix (top ${trimmed.length} by priority):`,
    failureLines,
  ].join('\n');
}

/**
 * Order failures so the highest-signal repair targets come first when the list
 * is trimmed. Runtime mechanic gaps are the load-bearing failures for
 * `passed: true`; metadata/contract issues are next; browser visual smoke is
 * usually downstream of those and least worth a slot when the list is full.
 */
export function prioritizeFailures(failures: string[]): string[] {
  const score = (f: string): number => {
    const lower = f.toLowerCase();
    if (/runtime|runsmoketest|gameplaymechanics|reachability|stomp|bump|ability|gate|combo/.test(lower)) return 0;
    if (/metadata|contract|progressplan|qualityplan|__game_meta__|__game_test__|snapshot|step\(/.test(lower)) return 1;
    if (/browser|visual|canvas|viewport|nonblank|crop|overlap/.test(lower)) return 2;
    return 3;
  };
  return [...failures].sort((a, b) => score(a) - score(b));
}

/** One agent session, one prompt — the unit both strategies are built from. */
async function sendAgentPrompt(options: {
  provider: string;
  model: string;
  apiKey: string;
  prompt: string;
}): Promise<GenerationOutcome> {
  const agent = new StandaloneAgentAdapter({
    workingDirectory: projectRoot,
    modelConfig: {
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
    },
    toolMode: 'deferred',
  });
  const result = await agent.sendMessage(options.prompt);
  await agent.finalizeSession();
  return {
    responses: result.responses,
    toolCount: result.toolExecutions.length,
    errors: result.errors,
  };
}

async function runAgentGeneration(options: {
  artifactPath: string;
  provider: string;
  model: string;
  apiKey: string;
  /**
   * When provided, switches into P3 monotonic-repair mode: the existing
   * artifact at `artifactPath` is preserved (not deleted) and the agent gets
   * a repair prompt that points at the baseline + failure list instead of a
   * fresh "create from scratch" prompt.
   */
  previousFailures?: string[];
  /** Codex strategy (W4): casebook tail prepended to repair prompts. */
  casebookPreamble?: string;
}): Promise<GenerationOutcome> {
  await fs.mkdir(path.dirname(options.artifactPath), { recursive: true });
  const isRepairRound = Array.isArray(options.previousFailures) && options.previousFailures.length > 0;
  if (!isRepairRound) {
    // Round 0 / fresh fallback: nuke any stale artifact so the generation
    // is unambiguous about producing a brand-new file.
    await fs.rm(options.artifactPath, { force: true });
  }

  const prompt = isRepairRound
    ? (options.casebookPreamble ?? '') + buildRepairPrompt(options.artifactPath, options.previousFailures!)
    : buildGenerationPrompt(options.artifactPath);
  return sendAgentPrompt({
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
    prompt,
  });
}

/**
 * Codex strategy (docs/designs/game-gen-codex-workflow.md): round-0 candidates
 * come from the GAMEPLAN → M0..M4 milestone pipeline with runtime-smoke probes
 * between milestones; repair rounds reuse the single-strategy minimal-edit
 * repair but with the .logs/ casebook prepended so repairs are not blind.
 */
async function buildCodexGenerate(options: {
  artifactPath: string;
  provider: string;
  model: string;
  apiKey?: string;
  generationTimeoutMs: number;
  runtimeTimeoutMs: number;
  milestoneRetryCap: number;
  routeConfig: CodexMilestoneRouteConfig;
}): Promise<GenerateCandidateFn> {
  const strategy = await import('./platformerCodexStrategy.ts');

  const probe = async (artifactPath: string): Promise<ValidationSummary> => {
    const validation = await validateGameArtifact(artifactPath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: options.runtimeTimeoutMs,
      runBrowserVisualSmoke: false,
    });
    return {
      artifactPath,
      passed: validation.passed,
      failures: validation.failures,
      runtimePassed: validation.runtimeSmoke?.passed,
      runtimeFailures: validation.runtimeSmoke?.failures,
      runtimeChecks: validation.runtimeSmoke?.checks,
    };
  };

  return async ({ candidateIndex, round, previousFailures }) => {
    const isRepairRound = Array.isArray(previousFailures) && previousFailures.length > 0;

    if (isRepairRound) {
      try {
        const tail = await strategy.readCasebookTail(options.artifactPath);
        const apiKey = options.apiKey ?? await resolveApiKey(options.provider);
        if (!apiKey) {
          throw new Error(missingApiKeyMessage(options.provider));
        }
        const result = await withTimeout(
          runAgentGeneration({
            artifactPath: options.artifactPath,
            provider: options.provider,
            model: options.model,
            apiKey,
            previousFailures,
            casebookPreamble: strategy.buildCasebookPreamble(tail),
          }),
          options.generationTimeoutMs,
          `Agent generation timed out after ${options.generationTimeoutMs}ms`,
        );
        await strategy.appendCasebook(options.artifactPath, {
          stage: `repair round ${round} (r${round}c${candidateIndex})`,
          goal: 'fix acceptance failures with minimal edits (casebook-aware)',
          action: `targeted top failures: ${previousFailures!.slice(0, 3).join(' | ')}`,
          probeResult: result.errors.length > 0 ? 'ERROR' : 'DISPATCHED',
          details: result.errors,
          conclusion: 'validation outcome recorded by acceptance loop report',
        });
        const generationError = result.errors.length > 0
          ? `Agent generation reported errors: ${result.errors.join('; ')}`
          : undefined;
        return { generation: result, generationError, artifactPath: options.artifactPath };
      } catch (error) {
        return {
          generation: null,
          generationError: error instanceof Error ? error.message : String(error),
          artifactPath: options.artifactPath,
        };
      }
    }

    // Fresh candidate: wipe stale artifact, run the milestone pipeline.
    await fs.rm(options.artifactPath, { force: true });
    try {
      const result = await strategy.runCodexMilestonePipeline(options.artifactPath, {
        generateMilestone: async (prompt, context) => {
          const route = selectCodexMilestoneModelRoute(options.routeConfig, context.milestone.id);
          const apiKey = await resolveApiKey(route.provider);
          if (!apiKey) {
            throw new Error(missingApiKeyMessage(route.provider));
          }
          console.error(
            `[codex] ${context.milestone.id} attempt ${context.attempt} route: ${route.provider}/${route.model} timeout=${route.timeoutMs}ms`,
          );
          return withTimeout(
            sendAgentPrompt({
              provider: route.provider,
              model: route.model,
              apiKey,
              prompt,
            }),
            route.timeoutMs,
            `Milestone ${context.milestone.id} generation timed out after ${route.timeoutMs}ms (${route.provider}/${route.model})`,
          );
        },
        probe,
        readArtifact: async (p) => {
          try {
            return await fs.readFile(p, 'utf-8');
          } catch {
            return null;
          }
        },
        log: (message) => console.error(message),
        appendLog: (entry) =>
          strategy.appendCasebook(options.artifactPath, {
            ...entry,
            stage: `r${round}c${candidateIndex} ${entry.stage}`,
          }),
        milestoneRetryCap: options.milestoneRetryCap,
      });
      const generationError = result.errors.length > 0
        ? `Codex milestone pipeline reported errors: ${result.errors.join('; ')}`
        : undefined;
      return { generation: result, generationError, artifactPath: options.artifactPath };
    } catch (error) {
      return {
        generation: null,
        generationError: error instanceof Error ? error.message : String(error),
        artifactPath: options.artifactPath,
      };
    }
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function validateArtifact(
  artifactPath: string,
  timeoutMs: number,
): Promise<ValidationSummary> {
  const validation = await validateGameArtifact(artifactPath, {
    runRuntimeSmoke: true,
    runtimeSmokeTimeoutMs: timeoutMs,
    runBrowserVisualSmoke: true,
    browserVisualSmokeTimeoutMs: Math.max(timeoutMs, ACCEPTANCE_DEFAULTS.CANDIDATE_BROWSER_TIMEOUT_MS),
  });

  return {
    artifactPath,
    passed: validation.passed,
    failures: validation.failures,
    runtimePassed: validation.runtimeSmoke?.passed,
    runtimeFailures: validation.runtimeSmoke?.failures,
    runtimeChecks: validation.runtimeSmoke?.checks,
    browserPassed: validation.browserVisualSmoke?.passed,
    browserFailures: validation.browserVisualSmoke?.failures,
    browserChecks: validation.browserVisualSmoke?.checks,
  };
}

/**
 * Execution-filter score for a candidate's validation summary.
 * Higher is better. 设计原则：先看运行时（最贵的信号），再看 browser smoke，
 * 最后用 (totalChecks - failureCount) 做 tie-breaker。
 *
 * 不重新发明分数 — 直接用 validator 已经返回的 runtimePassed / browserPassed +
 * runtimeChecks / runtimeFailures + browserChecks / browserFailures 推算。
 */
export function scoreCandidate(summary: ValidationSummary): {
  score: number;
  passCount: number;
  failCount: number;
} {
  const runtimePassed = summary.runtimePassed === true ? 1 : 0;
  const browserPassed = summary.browserPassed === true ? 1 : 0;

  const runtimeChecks = summary.runtimeChecks?.length ?? 0;
  const runtimeFailures = summary.runtimeFailures?.length ?? 0;
  const browserChecks = summary.browserChecks?.length ?? 0;
  const browserFailures = summary.browserFailures?.length ?? 0;
  const staticFailures = summary.failures?.length ?? 0;

  const passCount =
    Math.max(0, runtimeChecks - runtimeFailures) +
    Math.max(0, browserChecks - browserFailures);
  const failCount = runtimeFailures + browserFailures + staticFailures;
  const totalChecks = runtimeChecks + browserChecks;

  const score =
    runtimePassed * 1000 +
    browserPassed * 100 +
    Math.max(0, totalChecks - failCount);

  return { score, passCount, failCount };
}

/** 把一条 candidate 的检查结果转成可对比的 PASS check 集合 — 用于 monotonicity 退化诊断。 */
function passingCheckSet(summary: ValidationSummary): Set<string> {
  const failures = new Set<string>([
    ...(summary.runtimeFailures ?? []),
    ...(summary.browserFailures ?? []),
  ]);
  const passing = new Set<string>();
  for (const check of summary.runtimeChecks ?? []) {
    if (!failures.has(check)) passing.add(`runtime:${check}`);
  }
  for (const check of summary.browserChecks ?? []) {
    if (!failures.has(check)) passing.add(`browser:${check}`);
  }
  return passing;
}

export type GenerateCandidateFn = (params: {
  candidateIndex: number;
  artifactPath: string;
  round: number;
  /**
   * P3 monotonic repair: when present, the candidate should be produced by
   * patching the existing artifact at `artifactPath` to fix these failures,
   * not by regenerating from scratch. Only set for round 1+ where a
   * non-empty baseline exists.
   */
  previousFailures?: string[];
}) => Promise<{
  generation: GenerationOutcome | null;
  generationError?: string;
  /** Path of the artifact actually written by this candidate */
  artifactPath: string;
}>;

/**
 * Run one round of best-of-N. Generates up to N candidates sequentially.
 * Short-circuits as soon as a candidate fully passes (runtimePassed && browserPassed && static passed).
 */
export async function runBestOfN(params: {
  bonN: number;
  round: number;
  baseArtifactPath: string;
  runtimeTimeoutMs: number;
  generate: GenerateCandidateFn;
  validate?: (artifactPath: string, timeoutMs: number) => Promise<ValidationSummary>;
  /**
   * P3 monotonic repair: when non-empty, candidates will be produced as
   * minimal-edit patches of the existing baseline targeting these failures
   * instead of fresh regenerations.
   */
  previousFailures?: string[];
}): Promise<RoundResult> {
  const validate = params.validate ?? validateArtifact;
  const candidates: CandidateResult[] = [];

  for (let i = 0; i < params.bonN; i += 1) {
    const candidateId = `r${params.round}c${i}`;
    let generation: GenerationOutcome | null = null;
    let generationError: string | undefined;
    let artifactPath = params.baseArtifactPath;

    try {
      const result = await params.generate({
        candidateIndex: i,
        artifactPath: params.baseArtifactPath,
        round: params.round,
        previousFailures: params.previousFailures,
      });
      generation = result.generation;
      generationError = result.generationError;
      artifactPath = result.artifactPath;
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
    }

    let validation: ValidationSummary;
    const exists = await fileExists(artifactPath);
    if (!exists) {
      validation = {
        artifactPath,
        passed: false,
        failures: [
          generationError
            ? `Artifact was not written; generation failed: ${generationError}`
            : 'Artifact was not written.',
        ],
      };
    } else {
      validation = await validate(artifactPath, params.runtimeTimeoutMs);
    }

    const { score, passCount, failCount } = scoreCandidate(validation);
    candidates.push({
      candidateId,
      artifactPath,
      generation,
      generationError,
      validation,
      score,
      passCount,
      failCount,
    });

    // Short-circuit on full PASS — no point generating more candidates.
    if (validation.passed && validation.runtimePassed && validation.browserPassed) {
      break;
    }
  }

  // Pick highest score; tie-broken by candidate order (first wins).
  const selected = [...candidates].sort((a, b) => b.score - a.score)[0];
  if (!selected) {
    throw new Error('runBestOfN produced zero candidates — bonN must be >= 1');
  }
  const fullyPassed =
    selected.validation.passed === true &&
    selected.validation.runtimePassed === true &&
    selected.validation.browserPassed === true;

  return {
    round: params.round,
    candidates,
    selected,
    passCount: selected.passCount,
    failCount: selected.failCount,
    fullyPassed,
  };
}

/**
 * Diff two rounds: which checks were passing in `previous` but are no longer passing in `current`?
 */
export function diffRegressedChecks(previous: RoundResult, current: RoundResult): string[] {
  const prev = passingCheckSet(previous.selected.validation);
  const curr = passingCheckSet(current.selected.validation);
  const regressed: string[] = [];
  for (const check of prev) {
    if (!curr.has(check)) regressed.push(check);
  }
  return regressed.sort();
}

/**
 * Orchestrate Best-of-N + repair-loop hard cap + monotonicity gate.
 *
 * - Round 0 is the initial BoN attempt (always runs).
 * - If round 0 fully passes → return immediately.
 * - Otherwise enter repair loop, max `repairCap` rounds.
 * - Each round runs BoN and is compared against the previous round's selected candidate.
 * - Monotonicity:
 *   - 'warn' (default): if regression detected, log and discard this round (do not advance).
 *     Loop continues; next round still consumes from repairCap budget.
 *   - 'strict': hard fail with regression listed.
 */
export async function runAcceptanceLoop(params: {
  bonN: number;
  repairCap: number;
  monotonicMode: AcceptanceMonotonicMode;
  baseArtifactPath: string;
  runtimeTimeoutMs: number;
  generate: GenerateCandidateFn;
  validate?: (artifactPath: string, timeoutMs: number) => Promise<ValidationSummary>;
  /** Optional logger — defaults to console.error so JSON-only stdout stays clean. */
  log?: (message: string) => void;
}): Promise<AcceptanceLoopOutput> {
  const log = params.log ?? ((msg) => console.error(msg));
  const rounds: RoundResult[] = [];

  // Artifact retention: the monotonicity gate protects the SCORE accounting, but
  // a regressing repair round still overwrites the artifact FILE in place — so
  // without this, an escalated run leaves the WORST version on disk and reports
  // the LAST round, not the best (verified 2026-06-11 deepseek: round0 35/6 got
  // clobbered by repair rounds down to 18/26). We snapshot the best artifact and
  // restore it on regression, so repairs always patch the best baseline and the
  // delivered file is the best one.
  const bestSnapshot = `${params.baseArtifactPath}.best`;
  const snapshotArtifact = async (): Promise<void> => {
    if (await fileExists(params.baseArtifactPath)) {
      await fs.copyFile(params.baseArtifactPath, bestSnapshot).catch(() => {});
    }
  };
  const restoreArtifact = async (): Promise<void> => {
    if (await fileExists(bestSnapshot)) {
      await fs.copyFile(bestSnapshot, params.baseArtifactPath).catch(() => {});
    }
  };
  const cleanupSnapshot = async (): Promise<void> => {
    await fs.rm(bestSnapshot, { force: true }).catch(() => {});
  };

  // Round 0: initial BoN
  const round0 = await runBestOfN({
    bonN: params.bonN,
    round: 0,
    baseArtifactPath: params.baseArtifactPath,
    runtimeTimeoutMs: params.runtimeTimeoutMs,
    generate: params.generate,
    validate: params.validate,
  });
  rounds.push(round0);
  log(formatRoundLine(round0, params.bonN));

  if (round0.fullyPassed) {
    return {
      rounds,
      finalResult: round0,
      passedRound: 0,
      bonN: params.bonN,
      repairCap: params.repairCap,
      monotonicMode: params.monotonicMode,
      escalated: false,
    };
  }

  // Repair rounds. round0 is the initial best — snapshot it.
  let baselineRound = round0;
  await snapshotArtifact();
  for (let attempt = 1; attempt <= params.repairCap; attempt += 1) {
    // P3 monotonic repair: hand the baseline's failure list to the next round
    // so generate() can do a minimal-edit patch instead of a fresh rewrite.
    // Fallback to fresh regeneration when baseline is too broken to repair from
    // — empty failure list, only the "artifact missing" sentinel, or zero
    // passing checks (nothing worth preserving). We still consume a repair
    // budget slot, but Round 1 then gets a clean shot rather than being forced
    // to patch a near-empty baseline.
    const baselineFailures = baselineRound.selected.validation.failures ?? [];
    const baselineNotRepairable =
      baselineRound.passCount === 0
      || baselineFailures.length === 0
      || baselineFailures.some((f) => /Artifact was not written|does not exist/i.test(f));
    const previousFailures = baselineNotRepairable ? undefined : baselineFailures;

    const round = await runBestOfN({
      bonN: params.bonN,
      round: attempt,
      baseArtifactPath: params.baseArtifactPath,
      runtimeTimeoutMs: params.runtimeTimeoutMs,
      generate: params.generate,
      validate: params.validate,
      previousFailures,
    });

    const regressed = diffRegressedChecks(baselineRound, round);
    if (regressed.length > 0) {
      round.regressionAgainstPrevious = {
        previousPassCount: baselineRound.passCount,
        previousFailCount: baselineRound.failCount,
        regressedChecks: regressed,
      };
    }

    rounds.push(round);

    if (regressed.length > 0 && params.monotonicMode === 'strict') {
      const reason = formatRegressionMessage(baselineRound, round, regressed);
      log(`[acceptance] STRICT monotonic regression detected at round ${attempt}:\n${reason}`);
      log(formatRoundLine(round, params.bonN));
      // Deliver the best (pre-regression) artifact, not the regressed one.
      await restoreArtifact();
      await cleanupSnapshot();
      return {
        rounds,
        finalResult: baselineRound,
        bonN: params.bonN,
        repairCap: params.repairCap,
        monotonicMode: params.monotonicMode,
        escalated: true,
        escalationReason: `monotonic regression at round ${attempt}: ${regressed.join(', ')}`,
      };
    }

    if (regressed.length > 0) {
      // warn-mode: log but do NOT advance baseline; restore the artifact FILE to
      // the best baseline so the next repair round patches the good version (not
      // the regressed one) and the delivered file stays the best.
      log(formatRoundLine(round, params.bonN, ' [REGRESSED — discarded, restoring best artifact]'));
      log(`[acceptance] WARN monotonic regression at round ${attempt}: ${regressed.join(', ')}`);
      await restoreArtifact();
    } else {
      log(formatRoundLine(round, params.bonN));
      baselineRound = round;
      await snapshotArtifact();
    }

    if (round.fullyPassed) {
      await cleanupSnapshot();
      return {
        rounds,
        finalResult: round,
        passedRound: attempt,
        bonN: params.bonN,
        repairCap: params.repairCap,
        monotonicMode: params.monotonicMode,
        escalated: false,
      };
    }
  }

  // Repair cap reached without full PASS — escalate, but deliver the BEST round's
  // artifact (baselineRound), not the last (possibly regressed) one.
  await restoreArtifact();
  await cleanupSnapshot();
  const reason =
    'repair cap reached, escalate to architecture review (do not retry blindly — see docs/audits/2026-05-07-game-acceptance-architecture.md §7)';
  log(`[acceptance] ${reason}`);
  return {
    rounds,
    finalResult: baselineRound,
    bonN: params.bonN,
    repairCap: params.repairCap,
    monotonicMode: params.monotonicMode,
    escalated: true,
    escalationReason: reason,
  };
}

function formatRoundLine(round: RoundResult, bonN: number, suffix = ''): string {
  const tag = round.fullyPassed ? '[SELECTED, full PASS]' : '[SELECTED]';
  return `Round ${round.round} (best of ${bonN}): PASS=${round.passCount} FAIL=${round.failCount} (candidate=${round.selected.candidateId})  ${tag}${suffix}`;
}

function formatRegressionMessage(
  previous: RoundResult,
  current: RoundResult,
  regressed: string[],
): string {
  const lines = [
    `  previous round ${previous.round}: PASS=${previous.passCount} FAIL=${previous.failCount}`,
    `  current  round ${current.round}: PASS=${current.passCount} FAIL=${current.failCount}`,
    '  regressed checks:',
    ...regressed.map((c) => `    - ${c}`),
  ];
  return lines.join('\n');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatList(items: string[] | undefined, empty = 'none'): string {
  if (!items || items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function validationDiagnostics(summary: ValidationSummary): string[] {
  return [
    ...(summary.failures ?? []),
    ...(summary.runtimeFailures ?? []),
    ...(summary.browserFailures ?? []),
  ].filter(Boolean);
}

function diagnosticsMatch(diagnostics: string[], pattern: RegExp): boolean {
  return diagnostics.some((item) => pattern.test(item));
}

export function summarizeValidationStatus(summary: ValidationSummary): ProductStatusSummary {
  const diagnostics = validationDiagnostics(summary);
  const hasBlocking = diagnosticsMatch(
    diagnostics,
    /Artifact does not exist|Artifact was not written|generation failed|build failed|cannot find module|tsc|unparsable|incomplete html|文档结构不完整|页面崩溃|runtime page errors|pageerror|TypeError|ReferenceError|Cannot read properties/i,
  );
  const hasVisualGap = summary.browserPassed === false || diagnosticsMatch(
    diagnostics,
    /visual smoke|canvas|viewport|nonblank|crop|overlap|actor|HUD|reward|risk|goal|首屏|画面|视口|空白/i,
  );
  const hasQualityGap = diagnosticsMatch(
    diagnostics,
    /runSmokeTest|gameplayMechanics|stomp|bump|ability|doubleJump|gate|route|combo|enemy|block|goal|通关|玩法|玩不通|不能玩|无法通关|触发不了|player\.x|player\.y|score|status/i,
  );
  const hasEvidenceGap = diagnosticsMatch(
    diagnostics,
    /__GAME_META__|__GAME_TEST__|__INTERACTIVE_TEST__|metadata|contract|progressPlan|reachability|smokePlan|qualityPlan|snapshot|coverage|metric|验收|证据|缺少|无法验证|不能证明/i,
  );

  const focus: string[] = [];
  if (hasBlocking) {
    focus.push('先修生成或运行阻塞：确保文件存在、能打开、主循环不抛异常。');
  }
  if (hasQualityGap) {
    focus.push('补玩法闭环：让移动、敌人、方块、能力、路线或通关路径由真实输入触发。');
  }
  if (hasEvidenceGap) {
    focus.push('补验收证据：让 metadata、snapshot、progressPlan 和 runSmokeTest 对齐真实状态。');
  }
  if (hasVisualGap) {
    focus.push('补首屏质量：让角色、HUD、奖励、风险和目标在桌面与移动视口都可见。');
  }

  if (summary.passed) {
    return {
      kind: 'passed',
      status: 'PASS',
      headline: '游戏已生成，并通过玩法验收。',
      visibleState: '可打开、可操作，并且 runtime 与浏览器视觉 smoke 都通过。',
      focus: ['保持当前玩法闭环和验收契约，避免后续改动退化。'],
      diagnosticsCount: diagnostics.length,
    };
  }

  if (hasBlocking) {
    return {
      kind: 'blocked',
      status: 'BLOCKED',
      headline: '游戏产物还没稳定跑起来，先按阻塞问题处理。',
      visibleState: summary.browserPassed === true
        ? '浏览器画面能打开，但生成或运行链路仍报告阻塞异常。'
        : '当前还没有稳定的可验证游戏运行态。',
      focus: focus.slice(0, 3),
      diagnosticsCount: diagnostics.length,
    };
  }

  if (hasQualityGap) {
    return {
      kind: 'quality-gap',
      status: 'PLAYABLE_QUALITY_GAP',
      headline: '游戏已生成，但玩法验收未达标。',
      visibleState: summary.browserPassed === true
        ? '浏览器画面已通过 smoke，说明游戏已经能展示；当前主要是玩法、通关或机制闭环没跑通。'
        : '文件已生成，但首屏呈现和玩法闭环还需要一起补。',
      focus: focus.slice(0, 3),
      diagnosticsCount: diagnostics.length,
    };
  }

  if (hasEvidenceGap) {
    return {
      kind: 'evidence-gap',
      status: 'EVIDENCE_GAP',
      headline: '游戏已生成，但验收证据不足。',
      visibleState: summary.browserPassed === true
        ? '游戏画面能展示；当前问题更像 metadata/test contract 没把真实玩法证明出来。'
        : '游戏文件存在，但验证契约还不足以判断可玩性。',
      focus: focus.slice(0, 3),
      diagnosticsCount: diagnostics.length,
    };
  }

  return {
    kind: 'acceptance-gap',
    status: 'ACCEPTANCE_GAP',
    headline: '游戏已生成，但还没有通过完整验收。',
    visibleState: '当前失败更像综合验收缺口，需要查看诊断明细确认下一步。',
    focus: focus.length > 0 ? focus.slice(0, 3) : ['先复查 runtime smoke 和浏览器视觉 smoke，找到最小修复点。'],
    diagnosticsCount: diagnostics.length,
  };
}

export function formatProductStatusMarkdown(summary: ValidationSummary): string {
  const productStatus = summarizeValidationStatus(summary);
  return [
    '## Product Status',
    '',
    `- status: ${productStatus.status}`,
    `- summary: ${productStatus.headline}`,
    `- visibleState: ${productStatus.visibleState}`,
    `- diagnosticsCount: ${productStatus.diagnosticsCount}`,
    '',
    'Repair focus:',
    '',
    formatList(productStatus.focus),
  ].join('\n');
}

function formatGenerationResult(
  result: GenerationOutcome | null,
  error: string | undefined,
): string {
  if (!result && !error) return '- N/A';
  const rows = [
    `- toolCount: ${result?.toolCount ?? 'N/A'}`,
    `- responseCount: ${result?.responses.length ?? 'N/A'}`,
    `- errorCount: ${result?.errors.length ?? (error ? 1 : 0)}`,
  ];
  if (error) rows.push(`- generationError: ${error}`);
  if (result?.errors.length) {
    rows.push('', 'Generation errors:', formatList(result.errors));
  }
  return rows.join('\n');
}

async function writeMarkdownReport(reportPath: string, output: AcceptanceCliOutput): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const validation = output.validation;
  const loopRows: string[] = [];
  if (output.loop) {
    loopRows.push('## Acceptance Loop', '');
    loopRows.push(
      `- bonN: ${output.bonN}`,
      `- repairCap: ${output.repairCap}`,
      `- monotonicMode: ${output.monotonicMode}`,
      `- escalated: ${output.loop.escalated}`,
      `- passedRound: ${output.loop.passedRound ?? 'N/A'}`,
    );
    if (output.loop.escalationReason) {
      loopRows.push(`- escalationReason: ${output.loop.escalationReason}`);
    }
    loopRows.push('');
    loopRows.push('| round | candidates | selected | PASS | FAIL | fullPass | regressed |');
    loopRows.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const round of output.loop.rounds) {
      loopRows.push(
        `| ${round.round} | ${round.candidates.length} | ${round.selected.candidateId} | ${round.passCount} | ${round.failCount} | ${round.fullyPassed} | ${round.regressionAgainstPrevious?.regressedChecks.length ?? 0} |`,
      );
    }
    loopRows.push('');
  }

  const generationSummary = output.loop?.finalResult.selected.generation ?? null;
  const generationError = output.loop?.finalResult.selected.generationError;

  const milestoneRows: string[] = [];
  const roundZero = output.loop?.rounds.find((r) => r.round === 0);
  const milestoneSource = roundZero?.selected.generation?.milestones
    ?? generationSummary?.milestones;
  if (milestoneSource && milestoneSource.length > 0) {
    milestoneRows.push('## Codex Milestones (round 0)', '');
    milestoneRows.push('| milestone | attempts | passed | blocking failures |');
    milestoneRows.push('| --- | --- | --- | --- |');
    for (const m of milestoneSource) {
      const blocking = m.blockingFailures.length > 0
        ? m.blockingFailures.slice(0, 2).join('; ').replace(/\|/g, '\\|')
        : 'none';
      milestoneRows.push(`| ${m.milestoneId} | ${m.attempts} | ${m.passed} | ${blocking} |`);
    }
    milestoneRows.push('');
  }

  const body = [
    '# Platformer Gameplay Acceptance Report',
    '',
    `- startedAt: ${output.startedAt}`,
    `- finishedAt: ${output.finishedAt}`,
    `- durationMs: ${output.durationMs}`,
    `- mode: ${output.mode}`,
    `- artifactPath: ${validation.artifactPath}`,
    `- provider: ${output.provider ?? 'N/A'}`,
    `- model: ${output.model ?? 'N/A'}`,
    `- strategy: ${output.strategy ?? 'N/A'}`,
    ...(output.codexRoutes
      ? [
          `- codexLogicRoute: ${output.codexRoutes.logicProvider}/${output.codexRoutes.logicModel}`,
          `- codexMimoRoute: ${output.codexRoutes.mimoProvider}/${output.codexRoutes.mimoModel}`,
          `- codexHeavyMilestoneTimeoutMs: ${output.codexRoutes.heavyMilestoneTimeoutMs}`,
        ]
      : []),
    `- passed: ${validation.passed}`,
    `- runtimePassed: ${validation.runtimePassed ?? 'N/A'}`,
    `- browserPassed: ${validation.browserPassed ?? 'N/A'}`,
    '',
    formatProductStatusMarkdown(validation),
    '',
    ...loopRows,
    ...milestoneRows,
    '## Generation (selected candidate)',
    '',
    formatGenerationResult(generationSummary, generationError),
    '',
    '## Diagnostic Details',
    '',
    '<details>',
    '<summary>Raw validator details</summary>',
    '',
    '### Validation Detail',
    '',
    formatList(validation.failures),
    '',
    '### Runtime Smoke',
    '',
    `- passed: ${validation.runtimePassed ?? 'N/A'}`,
    '',
    'Runtime failures:',
    '',
    formatList(validation.runtimeFailures),
    '',
    'Runtime checks:',
    '',
    formatList(validation.runtimeChecks),
    '',
    '### Browser Visual Smoke',
    '',
    `- passed: ${validation.browserPassed ?? 'N/A'}`,
    '',
    'Browser checks:',
    '',
    formatList(validation.browserChecks),
    '',
    'Browser failures:',
    '',
    formatList(validation.browserFailures),
    '',
    '</details>',
    '',
  ].join('\n');
  await fs.writeFile(reportPath, body, 'utf-8');
}

function resolveBonN(args: ReturnType<typeof parseArgs>): number {
  const cli = getNumberOption(args, 'bon-n');
  if (cli !== undefined) return Math.max(1, Math.floor(cli));
  const env = Number(envValue('ACCEPTANCE_BON_N') || 0);
  if (Number.isFinite(env) && env > 0) return Math.max(1, Math.floor(env));
  return ACCEPTANCE_DEFAULTS.BON_N;
}

function resolveRepairCap(args: ReturnType<typeof parseArgs>): number {
  const cli = getNumberOption(args, 'repair-cap');
  if (cli !== undefined) return Math.max(0, Math.floor(cli));
  const env = Number(envValue('ACCEPTANCE_REPAIR_CAP') ?? '');
  if (Number.isFinite(env) && env >= 0 && envValue('ACCEPTANCE_REPAIR_CAP')) {
    return Math.max(0, Math.floor(env));
  }
  return ACCEPTANCE_DEFAULTS.REPAIR_CAP;
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const artifactPath = resolveArtifactPath(getStringOption(args, 'artifact'));
  const reportPath = hasFlag(args, 'report')
    ? resolveReportPath(artifactPath, getStringOption(args, 'report'))
    : null;
  const validateOnly = hasFlag(args, 'validate-only');
  const jsonOnly = hasFlag(args, 'json');
  const strategyRaw =
    getStringOption(args, 'strategy') || envValue('PLATFORMER_GAMEPLAY_STRATEGY') || 'single';
  if (strategyRaw !== 'single' && strategyRaw !== 'codex') {
    throw new Error(`Unknown --strategy "${strategyRaw}" — expected "single" or "codex".`);
  }
  const strategy: GenerationStrategy = strategyRaw;

  const defaultProvider = strategy === 'codex' ? DEFAULT_CODEX_MIMO_PROVIDER : 'openrouter';
  const defaultModel = strategy === 'codex'
    ? DEFAULT_CODEX_MIMO_MODEL
    : envValue('OPENROUTER_CHAT_MODEL') || 'google/gemini-3-flash-preview';
  const provider =
    getStringOption(args, 'provider') || envValue('PLATFORMER_GAMEPLAY_PROVIDER') || defaultProvider;
  const model =
    getStringOption(args, 'model') ||
    envValue('PLATFORMER_GAMEPLAY_MODEL') ||
    defaultModel;
  const timeoutMs = getNumberOption(args, 'timeout') || ACCEPTANCE_DEFAULTS.CANDIDATE_RUNTIME_TIMEOUT_MS;
  const generationTimeoutMs =
    getNumberOption(args, 'generation-timeout') ||
    Number(envValue('PLATFORMER_GAMEPLAY_GENERATION_TIMEOUT_MS') || 0) ||
    ACCEPTANCE_DEFAULTS.CANDIDATE_GENERATION_TIMEOUT_MS;
  const logicProvider =
    getStringOption(args, 'logic-provider') ||
    envValue('PLATFORMER_GAMEPLAY_LOGIC_PROVIDER') ||
    defaultLogicProvider();
  const logicModel =
    getStringOption(args, 'logic-model') ||
    envValue('PLATFORMER_GAMEPLAY_LOGIC_MODEL') ||
    defaultLogicModel(logicProvider);
  const mimoProvider =
    getStringOption(args, 'mimo-provider') ||
    envValue('PLATFORMER_GAMEPLAY_MIMO_PROVIDER') ||
    DEFAULT_CODEX_MIMO_PROVIDER;
  const mimoModel =
    getStringOption(args, 'mimo-model') ||
    envValue('PLATFORMER_GAMEPLAY_MIMO_MODEL') ||
    DEFAULT_CODEX_MIMO_MODEL;
  const heavyMilestoneTimeoutMs =
    getNumberOption(args, 'heavy-milestone-timeout') ||
    Number(envValue('PLATFORMER_GAMEPLAY_HEAVY_MILESTONE_TIMEOUT_MS') || 0) ||
    DEFAULT_CODEX_HEAVY_MILESTONE_TIMEOUT_MS;
  const codexRouteConfig: CodexMilestoneRouteConfig = {
    logicProvider,
    logicModel,
    mimoProvider,
    mimoModel,
    generationTimeoutMs,
    heavyMilestoneTimeoutMs,
  };

  const bonN = resolveBonN(args);
  const repairCap = resolveRepairCap(args);
  const monotonicMode: AcceptanceMonotonicMode = hasFlag(args, 'strict-monotonic') ? 'strict' : 'warn';
  const milestoneRetryCap = Math.max(0, Math.floor(getNumberOption(args, 'milestone-retry') ?? 1));

  let loop: AcceptanceLoopOutput | undefined;
  let validationSummary: ValidationSummary;

  if (validateOnly) {
    const exists = await fileExists(artifactPath);
    if (!exists) {
      validationSummary = {
        artifactPath,
        passed: false,
        failures: ['Artifact does not exist (validate-only mode).'],
      };
    } else {
      validationSummary = await validateArtifact(artifactPath, timeoutMs);
    }
  } else {
    const apiKey = await resolveApiKey(provider);
    if (!apiKey && strategy !== 'codex') {
      throw new Error(missingApiKeyMessage(provider));
    }

    const generate: GenerateCandidateFn =
      strategy === 'codex'
        ? await buildCodexGenerate({
            artifactPath,
            provider,
            model,
            apiKey,
            generationTimeoutMs,
            runtimeTimeoutMs: timeoutMs,
            milestoneRetryCap,
            routeConfig: codexRouteConfig,
          })
        : async ({ previousFailures }) => {
            try {
              const result = await withTimeout(
                runAgentGeneration({ artifactPath, provider, model, apiKey: apiKey!, previousFailures }),
                generationTimeoutMs,
                `Agent generation timed out after ${generationTimeoutMs}ms`,
              );
              const generationError = result.errors.length > 0
                ? `Agent generation reported errors: ${result.errors.join('; ')}`
                : undefined;
              return { generation: result, generationError, artifactPath };
            } catch (error) {
              return {
                generation: null,
                generationError: error instanceof Error ? error.message : String(error),
                artifactPath,
              };
            }
          };

    loop = await runAcceptanceLoop({
      bonN,
      repairCap,
      monotonicMode,
      baseArtifactPath: artifactPath,
      runtimeTimeoutMs: timeoutMs,
      generate,
    });
    validationSummary = loop.finalResult.selected.validation;
  }

  const finishedAtMs = Date.now();
  const output: AcceptanceCliOutput = {
    mode: validateOnly ? 'validate-only' : 'generate-and-validate',
    provider: validateOnly ? undefined : provider,
    model: validateOnly ? undefined : model,
    strategy: validateOnly ? undefined : strategy,
    codexRoutes: !validateOnly && strategy === 'codex' ? codexRouteConfig : undefined,
    bonN,
    repairCap,
    monotonicMode,
    loop,
    validation: validationSummary,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
  };

  if (reportPath) {
    await writeMarkdownReport(reportPath, output);
  }

  if (jsonOnly) {
    printJson(output);
  } else {
    printKeyValue('Platformer Gameplay Acceptance', [
      ['mode', output.mode],
      ['artifactPath', artifactPath],
      ['provider', output.provider],
      ['model', output.model],
      ['strategy', output.strategy],
      ['codexLogicRoute', output.codexRoutes
        ? `${output.codexRoutes.logicProvider}/${output.codexRoutes.logicModel}`
        : undefined],
      ['codexMimoRoute', output.codexRoutes
        ? `${output.codexRoutes.mimoProvider}/${output.codexRoutes.mimoModel}`
        : undefined],
      ['codexHeavyMilestoneTimeoutMs', output.codexRoutes?.heavyMilestoneTimeoutMs],
      ['bonN', bonN],
      ['repairCap', repairCap],
      ['monotonicMode', monotonicMode],
      ['rounds', loop?.rounds.length ?? 0],
      ['passedRound', loop?.passedRound ?? 'N/A'],
      ['escalated', loop?.escalated ?? false],
      ['escalationReason', loop?.escalationReason],
      ['reportPath', reportPath],
      ['passed', validationSummary.passed],
      ['runtimePassed', validationSummary.runtimePassed],
      ['browserPassed', validationSummary.browserPassed],
    ]);
    const productStatus = summarizeValidationStatus(validationSummary);
    console.log('\n=== Product Status ===');
    console.log(productStatus.headline);
    console.log(productStatus.visibleState);
    if (productStatus.focus.length > 0) {
      console.log('Repair focus:');
      for (const item of productStatus.focus) console.log(`- ${item}`);
    }
    if (!validationSummary.passed && reportPath) {
      console.log(`Full diagnostics: ${reportPath}`);
    } else if (!validationSummary.passed) {
      console.log('Full diagnostics: rerun with --report <path> to write raw validator details.');
    }
    if (loop) {
      console.log('\n=== Acceptance Summary ===');
      console.log(`bon_n: ${bonN}, repair_cap: ${repairCap}, monotonic: ${monotonicMode}`);
      for (const round of loop.rounds) {
        const tag = round.fullyPassed ? '[SELECTED, full PASS]' : '[SELECTED]';
        const regressed = round.regressionAgainstPrevious?.regressedChecks.length ?? 0;
        const note = regressed > 0 ? ` [REGRESSED ${regressed} checks]` : '';
        console.log(
          `Round ${round.round} (best of ${bonN}): PASS=${round.passCount} FAIL=${round.failCount} (candidate=${round.selected.candidateId})  ${tag}${note}`,
        );
      }
      if (loop.passedRound !== undefined) {
        console.log(`Result: PASS at round ${loop.passedRound}`);
      } else if (loop.escalated) {
        console.log(`Result: ESCALATED — ${loop.escalationReason}`);
      } else {
        console.log('Result: FAIL');
      }
    }
  }

  const generationFailed = loop?.finalResult.selected.generationError !== undefined;
  if (generationFailed || !validationSummary.passed) {
    process.exit(1);
  }
}

const isMainModule = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch(finishWithError);
}
