#!/usr/bin/env npx tsx
//
// RSI pilot eval harness — runs a fixed prompt case set through the ordinary
// chat path (StandaloneAgentAdapter, light in-loop validation), then runs
// OFFLINE full-contract game-artifact validation on whatever HTML the agent
// wrote and classifies every failure string into a structured repair code.
// No LLM call happens outside of the one agent.sendMessage() per case x rep
// unit (never in --dry-run mode).
//
// Usage:
//   npx tsx scripts/rsi-pilot/runner.ts --dry-run --label wiring --out <dir>
//   npx tsx scripts/rsi-pilot/runner.ts --label baseline --out <dir> [--split all|held_in|held_out]
//   npx tsx scripts/rsi-pilot/runner.ts --label knobs-a --out <dir> --profile <profile.json>
//     profile.json = { "knobs": { <HARNESS_KNOB_DEFAULTS 的键>: number } }，由 harness-profile.ts emit 生成；
//     不带 --profile = 生产默认，run 记录里 harness.knobs 仍写全表（取证用）。
//                                        [--reps 3] [--provider longcat] [--model LongCat-2.0-Preview]
//                                        [--limit N] [--cases <path>]
//   npx tsx scripts/rsi-pilot/runner.ts --revalidate <resultsDir> [--cases <path>]
//     Re-runs OFFLINE full-contract validation + classification against the
//     artifacts a prior run already produced (zero LLM cost — no agent is
//     constructed, no sendMessage() call happens). Use this to recover a run
//     window that was corrupted by an environment problem unrelated to the
//     model (e.g. a shared node_modules losing playwright mid-run). Writes
//     <resultsDir>/runs-revalidated.jsonl and <resultsDir>/summary-revalidated.json;
//     never touches the original runs.jsonl/summary.json.
//
// IMPORTANT: process.env.CODE_AGENT_DATA_DIR is set below, before this file
// imports anything from src/. src/host/platform/appPaths.ts memoizes
// CODE_AGENT_DATA_DIR into a module-level singleton on its first call, so
// every import of src/ code in this file is a dynamic `await import(...)`
// performed after that assignment — never a static top-of-file import, which
// ESM would hoist and evaluate before the assignment runs.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProviderEndpointHost } from '../../src/shared/constants/providers.ts';
const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'url';
import {
  finishWithError,
  getNumberOption,
  getStringArrayOption,
  getStringOption,
  hasFlag,
  parseArgs,
  requireStringOption,
} from '../acceptance/_helpers.ts';

if (!process.env.CODE_AGENT_DATA_DIR) {
  process.env.CODE_AGENT_DATA_DIR = path.join(os.homedir(), '.code-agent-dev');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');

// Module specifiers resolved relative to THIS file (scripts/rsi-pilot/) — same
// depth under scripts/ as scripts/acceptance/, so the relative prefix matches
// what scripts/acceptance/platformer-gameplay-generation.ts uses.
const AGENT_ADAPTER_PATH = '../../src/host/testing/agentAdapter.ts';
const HARNESS_KNOBS_PATH = '../../src/host/agent/runtime/harnessKnobs.ts';
const GAME_VALIDATOR_PATH = '../../src/host/agent/runtime/gameArtifactValidator.ts';
const ARTIFACT_REPAIR_SPEC_PATH = '../../src/host/agent/runtime/artifactRepairSpec.ts';
const GAME_CONSTANTS_PATH = '../../src/shared/constants/game.ts';
const SUBTYPE_DETECTION_PATH = '../../src/host/agent/runtime/game/subtypeDetection.ts';
const ARTIFACT_GENERATION_PATH = '../../src/host/prompts/artifactGeneration.ts';
const SECURE_STORAGE_PATH = '../../src/host/services/core/secureStorage.ts';
const TELEMETRY_PATH = '../../src/host/telemetry/index.ts';
const DATABASE_SERVICE_PATH = '../../src/host/services/core/databaseService.ts';

const DEFAULT_CASES_RELATIVE_PATH = 'scripts/rsi-pilot/cases.json';
const DEFAULT_REPS = 3;
const DEFAULT_PROVIDER = 'longcat';
// 2026-09-12：`LongCat-2.0-Preview` 已被上游下线（GET /models 只剩 `LongCat-2.0`，
// 见 N-EVAL-HELDOUT-STRUCTURAL-R3 证据档）。07-04 试点跑的是哪个 id 无运行记录可证——
// 这正是本文件后来补 provenance 字段的起因（N-EVALRUN-PROVENANCE）。
const DEFAULT_MODEL = 'LongCat-2.0';
// Per-run hard timeout — matches BASH.MAX_TIMEOUT (src/shared/constants/tools.ts),
// the repo's existing "10 minutes" constant; this harness lives outside src/ so
// it is not required to import it, but the value is intentionally the same one.
const PER_RUN_HARD_TIMEOUT_MS = 600_000;

type GameSubtype = 'platformer' | 'runner' | 'breakout';
type Split = 'held_in' | 'held_out';

interface EvalCase {
  id: string;
  subtype: GameSubtype;
  split: Split;
  prompt: string;
}

interface CasesFile {
  version: number;
  note: string;
  cases: EvalCase[];
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

interface EvalRunProvenance {
  provider: string;
  model: string;
  endpoint: string;
  gitSha: string;
  /** 脏树 true/false；git 状态查询本身失败时 'unresolved'——环境故障不冒充真脏树（ai-review #1765 Nit） */
  gitDirty: boolean | 'unresolved';
  runnerSha: string;
}

export const RSI_RUN_PROVENANCE_KEYS = ['provider', 'model', 'endpoint', 'gitSha', 'gitDirty', 'runnerSha'] as const satisfies readonly (keyof EvalRunProvenance)[];
type MissingRsiProvenanceKey = Exclude<keyof EvalRunProvenance, (typeof RSI_RUN_PROVENANCE_KEYS)[number]>;
const _rsiProvenanceKeysExhaustive: MissingRsiProvenanceKey extends never ? true : never = true;
void _rsiProvenanceKeysExhaustive;


/** 读 profile 文件并用 host 的校验器过一遍（未知键 / 非正数 / 比例越界直接拒）。 */
async function loadHarnessProfile(profilePath: string): Promise<Record<string, number>> {
  const abs = path.isAbsolute(profilePath) ? profilePath : path.join(process.cwd(), profilePath);
  const raw = JSON.parse(await fs.readFile(abs, 'utf-8')) as { knobs?: unknown };
  const { validateHarnessKnobs } = await import(HARNESS_KNOBS_PATH) as typeof import('../../src/host/agent/runtime/harnessKnobs');
  return validateHarnessKnobs(raw.knobs ?? {}) as Record<string, number>;
}

interface RunHarnessStamp {
  /** --profile 文件路径（相对 cwd 原样）；无 = null */
  profile: string | null;
  /** 本 run 生效的旋钮全表（无 profile 时 = HARNESS_KNOB_DEFAULTS 原样） */
  knobs: Record<string, number>;
}

interface RunRecord {
  provenance: EvalRunProvenance;
  harness: RunHarnessStamp;
  label: string;
  caseId: string;
  subtype: GameSubtype;
  split: Split;
  rep: number;
  startedAt: string;
  durationMs: number;
  passedFull: boolean | null;
  passedLight: boolean | null;
  failuresRaw: string[];
  codes: string[];
  tokenUsage: TokenUsage | null;
  artifactPath: string | null;
  error: string | null;
  repairRoundsUsed: number | null;
  /** True iff this unit hit PER_RUN_HARD_TIMEOUT_MS. 超时后 runner 会调 adapter.cancelActiveRun() 真的掐掉 loop（N-EVAL-L3-HARNESS 加的取消通道）。 */
  timedOut?: true;
  /**
   * 仅当超时且 cancelActiveRun 不可用或抛错时为 true：底层模型/工具调用可能仍在后台跑，
   * summary 与 reward judge 要把它当噪声而不是 "0 codes" 的通过（ai-review #1765 Important）。
   */
  abandonedInflight?: true;
}

/**
 * Output shape for --revalidate: same fields as RunRecord, but passedFull /
 * failuresRaw / codes have been overwritten by a fresh offline validation
 * pass. originalCodes preserves the pre-revalidation codes for comparison;
 * revalidateSkipped/revalidateError cover the "couldn't find or re-check the
 * artifact" cases without touching the original record's own `error` field
 * (which describes the original agent.sendMessage() run, not revalidation).
 */
type RevalidatedRunRecord = RunRecord & {
  revalidatedAt: string;
  originalCodes: string[];
  revalidateSkipped?: true;
  revalidateError?: string;
};

export interface RunnerContext {
  StandaloneAgentAdapter: new (config: {
    workingDirectory: string;
    modelConfig: { provider: string; model: string; apiKey?: string; baseUrl?: string };
    toolMode: 'all' | 'deferred';
    harness?: { name: string; knobs: Record<string, number> };
  }) => {
    sendMessage: (prompt: string) => Promise<{
      responses: string[];
      toolExecutions: unknown[];
      turnCount: number;
      errors: string[];
    }>;
    finalizeSession: () => Promise<void>;
    getSessionId: () => string | undefined;
    cancelActiveRun?: () => Promise<void>;
  };
  validateGameArtifact: (filePath: string, options: Record<string, unknown>) => Promise<{
    passed: boolean;
    failures: string[];
    runtimeSmoke?: { failures: string[] };
    browserVisualSmoke?: { failures: string[] };
    playabilitySmoke?: { failures: string[] };
  }>;
  inferArtifactRepairIssueCodesFromText: (text: string) => string[];
  getTelemetryCollector: () => {
    getSessionData: (sessionId: string) => {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      estimatedCost: number;
    } | null;
  };
  gameValidationTimeouts: {
    RUNTIME_SMOKE_MS: number;
    BROWSER_VISUAL_SMOKE_MS: number;
    LIGHT_PLAYABILITY_SMOKE_MS: number;
  };
  /** 生产默认旋钮全表；无 --profile 时原样盖进 run 记录 */
  HARNESS_KNOB_DEFAULTS: Record<string, number>;
}

function resolvePath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.join(projectRoot, rawPath);
}

async function loadCases(casesPath: string): Promise<CasesFile> {
  let raw: string;
  try { raw = await fs.readFile(casesPath, 'utf-8'); } catch (error) {
    if (casesPath === resolvePath(DEFAULT_CASES_RELATIVE_PATH)) throw new Error('题集在私档，用 --cases 指定', { cause: error });
    throw error;
  }
  const parsed = JSON.parse(raw) as CasesFile;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`No cases found in ${casesPath}`);
  }
  return parsed;
}

/**
 * Mirrors the full-contract options toolArtifactValidationLifecycle.ts builds
 * when ctx.goalMode?.isPending() is true (fullContract branch, ~lines 113-126).
 */
function buildFullContractValidationOptions(timeouts: RunnerContext['gameValidationTimeouts']) {
  return {
    contractLevel: 'full' as const,
    runRuntimeSmoke: true,
    runtimeSmokeTimeoutMs: timeouts.RUNTIME_SMOKE_MS,
    requireRuntimeSmoke: true,
    runBrowserVisualSmoke: true,
    browserVisualSmokeTimeoutMs: timeouts.BROWSER_VISUAL_SMOKE_MS,
    requireBrowserVisualSmoke: true,
    allowBrowserVisualComputerFallback: false,
    runLightPlayabilitySmoke: false,
    lightPlayabilitySmokeTimeoutMs: timeouts.LIGHT_PLAYABILITY_SMOKE_MS,
  };
}

function collectFailureStrings(validation: {
  failures: string[];
  runtimeSmoke?: { failures: string[] };
  browserVisualSmoke?: { failures: string[] };
  playabilitySmoke?: { failures: string[] };
}): string[] {
  return [
    ...(validation.failures ?? []),
    ...(validation.runtimeSmoke?.failures ?? []),
    ...(validation.browserVisualSmoke?.failures ?? []),
    ...(validation.playabilitySmoke?.failures ?? []),
  ].filter(Boolean);
}

function classifyFailures(
  failuresRaw: string[],
  inferArtifactRepairIssueCodesFromText: (text: string) => string[],
): string[] {
  const codes = new Set<string>();
  for (const failure of failuresRaw) {
    for (const code of inferArtifactRepairIssueCodesFromText(failure)) {
      codes.add(code);
    }
  }
  return [...codes];
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findNewestHtml(dir: string): Promise<string | null> {
  // 闭包内赋值，TS 控制流会把外层 let 收窄成 null ⇒ 用容器对象绕开（typescript7 门 TS2339）
  const newest: { value: { filePath: string; mtimeMs: number } | null } = { value: null };

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        const stat = await fs.stat(full);
        if (!newest.value || stat.mtimeMs > newest.value.mtimeMs) {
          newest.value = { filePath: full, mtimeMs: stat.mtimeMs };
        }
      }
    }
  }

  await walk(dir);
  return newest.value ? newest.value.filePath : null;
}

async function locateArtifact(workspaceDir: string, prompt: string): Promise<string | null> {
  const named = prompt.match(/([A-Za-z0-9_-]+\.html)\b/);
  if (named) {
    const candidate = path.join(workspaceDir, named[1]);
    if (await fileExists(candidate)) return candidate;
  }
  return findNewestHtml(workspaceDir);
}

/**
 * custom-* provider（如 GLM Coding Plan 的 custom-glm-coding）的 baseUrl 只在数据目录 config.json 的
 * models.providers 里，AiSdkAdapter 对内置目录外的 provider 不会自己找；不传就 "无法解析 baseURL"。
 * 内置 provider 返回 undefined，走原有解析路径不变。
 */
async function resolveConfiguredBaseUrl(provider: string): Promise<string | undefined> {
  const dataDir = process.env.CODE_AGENT_DATA_DIR;
  if (!dataDir) return undefined;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf-8')) as {
      models?: { providers?: Record<string, { baseUrl?: unknown }> };
    };
    const baseUrl = raw.models?.providers?.[provider]?.baseUrl;
    return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function resolveApiKey(provider: string): Promise<string | undefined> {
  const envKey = process.env[`${provider.toUpperCase()}_API_KEY`];
  if (envKey && envKey.trim()) return envKey.trim();
  try {
    const { getSecureStorage } = await import(SECURE_STORAGE_PATH);
    return getSecureStorage().getApiKey(provider) || undefined;
  } catch {
    return undefined;
  }
}

export async function loadRunnerContext(): Promise<RunnerContext> {
  const [{ StandaloneAgentAdapter }, { validateGameArtifact }, { inferArtifactRepairIssueCodesFromText }, { getTelemetryCollector }, { GAME_VALIDATION_TIMEOUTS }] =
    await Promise.all([
      import(AGENT_ADAPTER_PATH),
      import(GAME_VALIDATOR_PATH),
      import(ARTIFACT_REPAIR_SPEC_PATH),
      import(TELEMETRY_PATH),
      import(GAME_CONSTANTS_PATH),
    ]);
  const { HARNESS_KNOB_DEFAULTS } = await import(HARNESS_KNOBS_PATH) as typeof import('../../src/host/agent/runtime/harnessKnobs');

  return {
    StandaloneAgentAdapter,
    validateGameArtifact,
    inferArtifactRepairIssueCodesFromText,
    getTelemetryCollector,
    gameValidationTimeouts: GAME_VALIDATION_TIMEOUTS,
    HARNESS_KNOB_DEFAULTS,
  };
}

async function gitOutput(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: projectRoot });
    return stdout.trim();
  } catch { return null; }
}

async function resolveProvenance(provider: string, model: string): Promise<EvalRunProvenance> {
  const gitSha = (await gitOutput(['-C', projectRoot, 'rev-parse', 'HEAD'])) ?? 'unresolved';
  const status = await gitOutput(['-C', projectRoot, 'status', '--porcelain']);
  const dirty: boolean | 'unresolved' = status === null ? 'unresolved' : status !== '';
  let runnerSha = 'unresolved';
  // __filename 在 ESM（npx tsx 直跑）下不存在⇒ #1765 起 runnerSha 一直是 'unresolved'，vitest 的 CJS 垫片把它遮住了
  try { runnerSha = crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12); } catch { /* unresolved is retained */ }
  const endpoint = getProviderEndpointHost(provider) ?? 'unresolved';
  return { provider, model, endpoint, gitSha, gitDirty: dirty, runnerSha };
}

async function runOneUnit(
  ctx: RunnerContext,
  evalCase: EvalCase,
  rep: number,
  opts: Pick<CliOpts, 'label' | 'provider' | 'model' | 'outDir' | 'knobs' | 'profilePath'>,
): Promise<RunRecord> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = `${evalCase.id}-r${rep}`;
  const workspaceDir = path.join(opts.outDir, 'runs', runId, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  const provenance = await resolveProvenance(opts.provider, opts.model);
  const harness: RunHarnessStamp = {
    profile: opts.profilePath ?? null,
    knobs: { ...ctx.HARNESS_KNOB_DEFAULTS, ...(opts.knobs ?? {}) },
  };
  const base = {
    provenance,
    harness,
    label: opts.label,
    caseId: evalCase.id,
    subtype: evalCase.subtype,
    split: evalCase.split,
    rep,
    startedAt,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any = null;
  let timeoutHandle: NodeJS.Timeout | undefined;
  // Hoisted above try/catch (not declared inline in the try block) so the
  // catch clause can identify a timeout by reference equality against the
  // exact Error instance the race rejected with — see the isTimeout check below.
  const timeoutError = new Error(`per-run hard timeout after ${PER_RUN_HARD_TIMEOUT_MS}ms`);
  try {
    const { getDatabase } = await import(DATABASE_SERVICE_PATH);
    const db = getDatabase();
    if (!db.isReady) {
      await db.initialize();
    }
    if (!db.isReady) {
      throw new Error('eval database failed to initialize under CODE_AGENT_DATA_DIR');
    }
    const apiKey = await resolveApiKey(opts.provider);
    agent = new ctx.StandaloneAgentAdapter({
      workingDirectory: workspaceDir,
      modelConfig: { provider: opts.provider, model: opts.model, apiKey, baseUrl: await resolveConfiguredBaseUrl(opts.provider) },
      toolMode: 'deferred',
      ...(opts.knobs ? { harness: { name: opts.label, knobs: opts.knobs } } : {}),
    });

    const result = await Promise.race([
      agent.sendMessage(evalCase.prompt),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(timeoutError), PER_RUN_HARD_TIMEOUT_MS);
      }),
    ]);

    // Must read telemetry BEFORE finalizeSession() (called in `finally`) —
    // endSession() nulls out the collector's activeSession.
    let tokenUsage: TokenUsage | null = null;
    const sessionId = agent.getSessionId();
    if (sessionId) {
      const sessionData = ctx.getTelemetryCollector().getSessionData(sessionId);
      if (sessionData) {
        tokenUsage = {
          inputTokens: sessionData.totalInputTokens,
          outputTokens: sessionData.totalOutputTokens,
          totalTokens: sessionData.totalTokens,
          estimatedCost: sessionData.estimatedCost,
        };
      }
    }

    const artifactPath = await locateArtifact(workspaceDir, evalCase.prompt);
    let passedFull: boolean;
    let failuresRaw: string[];
    let codes: string[];

    if (!artifactPath) {
      passedFull = false;
      failuresRaw = ['No HTML artifact found in workspace after generation.'];
      codes = ['artifact_missing'];
    } else {
      const validation = await ctx.validateGameArtifact(
        artifactPath,
        buildFullContractValidationOptions(ctx.gameValidationTimeouts),
      );
      passedFull = validation.passed;
      failuresRaw = collectFailureStrings(validation);
      codes = classifyFailures(failuresRaw, ctx.inferArtifactRepairIssueCodesFromText);
    }

    return {
      ...base,
      durationMs: Date.now() - startedAtMs,
      passedFull,
      // Not observable through StandaloneAgentAdapter's public sendMessage()
      // surface: light-contract validation runs inside AgentLoop via
      // handleModifiedArtifactValidation (toolArtifactValidationLifecycle.ts),
      // which reports progress through runFinalizer.emitTaskProgress('tool_running', ...)
      // — a task_progress-shaped message the adapter's onEvent switch
      // (agentAdapter.ts) does not forward into its return value; it only
      // handles 'message' | 'tool_call_start' | 'tool_call_end' | 'error'.
      passedLight: null,
      failuresRaw,
      codes,
      // Same reason as passedLight: the in-loop repair-attempt counter
      // (ARTIFACT_REPAIR_MAX_ATTEMPTS accounting) is only surfaced as
      // progress text, not through a typed event this adapter exposes.
      tokenUsage,
      artifactPath,
      error: result.errors.length > 0 ? result.errors.join('; ') : null,
      repairRoundsUsed: typeof (result as { repairRoundsUsed?: unknown }).repairRoundsUsed === 'number' ? (result as { repairRoundsUsed: number }).repairRoundsUsed : null,
    };
  } catch (error) {
    // Reference identity (not string matching) — this is the exact Error
    // instance Promise.race rejects with iff the hard timeout fired first;
    // any other thrown error (agent construction, sendMessage rejection,
    // validator exception) takes the normal non-timeout path below.
    const isTimeout = error === timeoutError;
    // 超时不只是放弃赛跑：掐掉 loop，否则超时题的工具/模型调用会活到下一题并发跑（限流、串扰、误写产物）。
    let abandonedInflight = false;
    if (isTimeout) {
      if (agent?.cancelActiveRun) {
        try { await agent.cancelActiveRun(); } catch { abandonedInflight = true; }
      } else {
        abandonedInflight = true;
      }
    }
    return {
      ...base,
      durationMs: Date.now() - startedAtMs,
      passedFull: null,
      passedLight: null,
      failuresRaw: [],
      codes: [],
      tokenUsage: null,
      artifactPath: null,
      error: error instanceof Error ? error.message : String(error),
      repairRoundsUsed: null,
      ...(isTimeout ? { timedOut: true as const, ...(abandonedInflight ? { abandonedInflight: true as const } : {}) } : {}),
    };
  } finally {
    // 不清的话 10 分钟定时器会把事件循环钉住，秒级跑完的 unit 也要等它到期才退出（ai-review #1765 第 3 轮）
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (agent) {
      try {
        await agent.finalizeSession();
      } catch {
        // best-effort cleanup; never let disposal failure mask the run result
      }
    }
  }
}

/**
 * median/p90/max over a set of millisecond durations. Nearest-rank method
 * (sorted ascending, p90 index = ceil(0.9n) - 1) — adequate for a 27-unit
 * pilot; not a substitute for a real stats library at larger n.
 */
function computeDurationStats(durationsMs: number[]): { medianMs: number; p90Ms: number; maxMs: number } | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const n = sorted.length;
  const medianMs =
    n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p90Index = Math.min(n - 1, Math.ceil(0.9 * n) - 1);
  return { medianMs, p90Ms: sorted[p90Index], maxMs: sorted[n - 1] };
}

function buildSummary(label: string, records: RunRecord[]) {
  const perCase: Record<string, { total: number; passed: number; passRate: number }> = {};
  const perSubtype: Record<string, { total: number; passed: number; passRate: number }> = {};
  const codeHistogram: Record<string, { count: number; runIds: Set<string> }> = {};

  const nonTimeoutDurationsMs: number[] = [];
  let totalPassed = 0;
  let totalDurationMs = 0;
  let errorCount = 0;
  let timeoutCount = 0;

  for (const record of records) {
    totalDurationMs += record.durationMs;
    if (record.error) errorCount += 1;
    if (record.timedOut) {
      timeoutCount += 1;
    } else {
      nonTimeoutDurationsMs.push(record.durationMs);
    }
    const passed = record.passedFull === true;
    if (passed) totalPassed += 1;

    perCase[record.caseId] ??= { total: 0, passed: 0, passRate: 0 };
    perCase[record.caseId].total += 1;
    if (passed) perCase[record.caseId].passed += 1;

    perSubtype[record.subtype] ??= { total: 0, passed: 0, passRate: 0 };
    perSubtype[record.subtype].total += 1;
    if (passed) perSubtype[record.subtype].passed += 1;

    const runId = `${record.caseId}-r${record.rep}`;
    for (const code of record.codes) {
      codeHistogram[code] ??= { count: 0, runIds: new Set() };
      codeHistogram[code].count += 1;
      codeHistogram[code].runIds.add(runId);
    }

  }

  for (const bucket of Object.values(perCase)) {
    bucket.passRate = bucket.total > 0 ? bucket.passed / bucket.total : 0;
  }
  for (const bucket of Object.values(perSubtype)) {
    bucket.passRate = bucket.total > 0 ? bucket.passed / bucket.total : 0;
  }

  const failureCodeHistogram: Record<string, { count: number; distinctRuns: number }> = {};
  for (const [code, data] of Object.entries(codeHistogram)) {
    failureCodeHistogram[code] = { count: data.count, distinctRuns: data.runIds.size };
  }

  return {
    version: 1,
    label,
    generatedAt: new Date().toISOString(),
    provenance: records[0]?.provenance ?? null,
    harness: records[0]?.harness ?? null,
    totalRuns: records.length,
    totalDurationMs,
    overall: {
      total: records.length,
      passed: totalPassed,
      passRate: records.length > 0 ? totalPassed / records.length : 0,
    },
    perCase,
    perSubtype,
    failureCodeHistogram,
    repairRoundsUsed: records.some((r) => r.repairRoundsUsed !== null) ? records.reduce((n, r) => n + (r.repairRoundsUsed ?? 0), 0) : 'unobservable',
    errorCount,
    // Excludes timedOut runs — a run abandoned at PER_RUN_HARD_TIMEOUT_MS
    // would otherwise pin every duration stat to ~600000ms and hide the
    // real distribution of the runs that actually finished.
    durationStats: computeDurationStats(nonTimeoutDurationsMs),
    timeoutCount,
  };
}

export interface CliOpts {
  casesPath: string;
  split: 'all' | Split;
  reps: number;
  provider: string;
  model: string;
  limit: number | undefined;
  label: string;
  outDir: string;
  ids: string[] | undefined;
  rep: number | undefined;
  /** --profile 解析后的旋钮覆盖；无 = 生产默认 */
  knobs?: Record<string, number>;
  profilePath?: string;
}

export async function realRun(opts: CliOpts, injectedCtx?: RunnerContext): Promise<void> {
  const casesFile = await loadCases(opts.casesPath);
  let cases = opts.split === 'all' ? casesFile.cases : casesFile.cases.filter((c) => c.split === opts.split);
  if (opts.ids && opts.ids.length > 0) {
    const allowed = new Set(opts.ids);
    cases = cases.filter((evalCase) => allowed.has(evalCase.id));
    const missing = opts.ids.filter((id) => !cases.some((evalCase) => evalCase.id === id));
    if (missing.length > 0) {
      throw new Error(`--ids not found after split filter: ${missing.join(', ')}`);
    }
  }
  if (cases.length === 0) {
    throw new Error(`No cases match --split ${opts.split}${opts.ids?.length ? ` --ids ${opts.ids.join(',')}` : ''}`);
  }

  const repsToRun = opts.rep !== undefined
    ? [opts.rep]
    : Array.from({ length: opts.reps }, (_, index) => index + 1);
  const units: Array<{ evalCase: EvalCase; rep: number }> = [];
  for (const evalCase of cases) {
    for (const rep of repsToRun) {
      units.push({ evalCase, rep });
    }
  }
  const scheduledUnits = opts.limit !== undefined ? units.slice(0, opts.limit) : units;

  await fs.mkdir(path.join(opts.outDir, 'runs'), { recursive: true });
  const runsJsonlPath = path.join(opts.outDir, 'runs.jsonl');
  if (await fileExists(runsJsonlPath)) {
    // runs.jsonl 是追加写、summary.json 只汇总本次 ⇒ 复用目录会让两者口径不一致，--revalidate 还会混入旧样本。
    throw new Error(`--out 已有 runs.jsonl：${runsJsonlPath}。换一个输出目录（每轮一个目录），不要追加。`);
  }

  const ctx = injectedCtx ?? await loadRunnerContext();

  console.error(
    `RSI pilot run — label=${opts.label} split=${opts.split} reps=${opts.reps} provider=${opts.provider} model=${opts.model} units=${scheduledUnits.length}`,
  );

  const records: RunRecord[] = [];
  let index = 0;
  for (const { evalCase, rep } of scheduledUnits) {
    index += 1;
    console.error(`[${index}/${scheduledUnits.length}] ${evalCase.id} rep=${rep} (${evalCase.subtype}/${evalCase.split})...`);
    const record = await runOneUnit(ctx, evalCase, rep, {
      label: opts.label,
      provider: opts.provider,
      model: opts.model,
      outDir: opts.outDir,
    });
    records.push(record);
    await fs.appendFile(runsJsonlPath, `${JSON.stringify(record)}\n`, 'utf-8');
    console.error(
      `  -> passedFull=${record.passedFull} codes=[${record.codes.join(',')}] durationMs=${record.durationMs} error=${record.error ?? 'none'}`,
    );
  }

  const summary = buildSummary(opts.label, records);
  await fs.writeFile(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.error(`\nDone. ${records.length} runs. Summary: ${path.join(opts.outDir, 'summary.json')}`);
}

async function dryRun(opts: CliOpts): Promise<void> {
  console.error('=== RSI pilot dry run — wiring report ===');
  const casesFile = await loadCases(opts.casesPath);

  const [{ detectGameSubtypeFromMessage }, { needsGameArtifactContract }] = await Promise.all([
    import(SUBTYPE_DETECTION_PATH),
    import(ARTIFACT_GENERATION_PATH),
  ]);

  const subtypeMismatches: string[] = [];
  const contractGateFailures: string[] = [];
  for (const evalCase of casesFile.cases) {
    const detected = detectGameSubtypeFromMessage(evalCase.prompt);
    if (detected !== evalCase.subtype) {
      subtypeMismatches.push(`${evalCase.id}: expected ${evalCase.subtype}, detected ${detected ?? 'undefined'}`);
    }
    if (!needsGameArtifactContract(evalCase.prompt)) {
      contractGateFailures.push(evalCase.id);
    }
  }

  console.error(`cases loaded: ${casesFile.cases.length}`);
  console.error(
    `subtype detection: ${subtypeMismatches.length === 0 ? `PASS (${casesFile.cases.length}/${casesFile.cases.length} matched)` : `FAIL — ${subtypeMismatches.join('; ')}`}`,
  );
  console.error(
    `contract gate (needsGameArtifactContract): ${contractGateFailures.length === 0 ? `PASS (${casesFile.cases.length}/${casesFile.cases.length} true)` : `FAIL — false for ${contractGateFailures.join(', ')}`}`,
  );

  const ctx = await loadRunnerContext();

  const workspaceDir = path.join(opts.outDir, 'dry-run-workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  const apiKey = await resolveApiKey(opts.provider);
  new ctx.StandaloneAgentAdapter({
    workingDirectory: workspaceDir,
    modelConfig: { provider: opts.provider, model: opts.model, apiKey, baseUrl: await resolveConfiguredBaseUrl(opts.provider) },
    toolMode: 'deferred',
  });
  console.error(`adapter constructed OK for provider=${opts.provider} model=${opts.model}`);
  console.error(`API key found for provider "${opts.provider}": ${apiKey !== undefined}`);

  // fixture 与题集同在私档（cases.json 旁的 fixtures/），不随 runner 进仓。
  const fixturePath = path.join(path.dirname(opts.casesPath), 'fixtures', 'broken-game.html');
  if (!(await fileExists(fixturePath))) {
    throw new Error(`Missing fixture: ${fixturePath}（题集与 fixtures 在私档，用 --cases 指向私档的 cases.json）`);
  }
  const validation = await ctx.validateGameArtifact(
    fixturePath,
    buildFullContractValidationOptions(ctx.gameValidationTimeouts),
  );
  const failuresRaw = collectFailureStrings(validation);
  const codes = classifyFailures(failuresRaw, ctx.inferArtifactRepairIssueCodesFromText);
  console.error(`broken fixture passed: ${validation.passed} (expected false)`);
  console.error(`broken fixture failuresRaw count: ${failuresRaw.length}`);
  console.error(`broken fixture classified codes (${codes.length}): ${codes.join(', ')}`);

  const ok =
    subtypeMismatches.length === 0 &&
    contractGateFailures.length === 0 &&
    apiKey !== undefined &&
    validation.passed === false &&
    codes.length > 0;

  console.error(`\n=== Dry run result: ${ok ? 'PASS' : 'FAIL'} ===`);
  if (!ok) process.exitCode = 1;
}

/**
 * Locate the artifact for one prior run record: trust record.artifactPath if
 * it still exists on disk (fast path — no re-scan needed); otherwise fall
 * back to the same workspace-scan locateArtifact() uses in realRun(), in
 * case the original run recorded artifactPath: null (e.g. it hit the
 * per-run hard timeout after the file was already fully written).
 */
async function locateArtifactForRevalidate(
  resultsDir: string,
  record: RunRecord,
  casePromptById: Map<string, string>,
): Promise<string | null> {
  if (record.artifactPath && (await fileExists(record.artifactPath))) {
    return record.artifactPath;
  }
  const workspaceDir = path.join(resultsDir, 'runs', `${record.caseId}-r${record.rep}`, 'workspace');
  if (!(await fileExists(workspaceDir))) return null;
  const prompt = casePromptById.get(record.caseId) ?? '';
  return locateArtifact(workspaceDir, prompt);
}

async function revalidateRun(opts: { resultsDir: string; casesPath: string }): Promise<void> {
  const runsJsonlPath = path.join(opts.resultsDir, 'runs.jsonl');
  const raw = await fs.readFile(runsJsonlPath, 'utf-8');
  const records: RunRecord[] = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
  if (records.length === 0) {
    throw new Error(`No records found in ${runsJsonlPath}`);
  }

  const casesFile = await loadCases(opts.casesPath);
  const casePromptById = new Map(casesFile.cases.map((c) => [c.id, c.prompt]));

  // Same full-contract validator + classifier as realRun() — no agent is
  // constructed here, so StandaloneAgentAdapter/getTelemetryCollector from
  // ctx go unused; loadRunnerContext() still dynamic-imports them (harmless,
  // no sendMessage() is ever called on this path).
  const ctx = await loadRunnerContext();

  console.error(`RSI pilot revalidate — resultsDir=${opts.resultsDir} records=${records.length}`);

  const outJsonlPath = path.join(opts.resultsDir, 'runs-revalidated.jsonl');
  await fs.writeFile(outJsonlPath, '', 'utf-8'); // fresh file, not an append target

  const revalidated: RevalidatedRunRecord[] = [];
  let index = 0;
  for (const record of records) {
    index += 1;
    const revalidatedAt = new Date().toISOString();
    const runLabel = `${record.caseId}-r${record.rep}`;
    let outRecord: RevalidatedRunRecord;

    try {
      const artifactPath = await locateArtifactForRevalidate(opts.resultsDir, record, casePromptById);
      if (!artifactPath) {
        outRecord = { ...record, revalidatedAt, originalCodes: record.codes, revalidateSkipped: true };
        console.error(`[${index}/${records.length}] ${runLabel}: SKIPPED — no artifact found`);
      } else {
        const validation = await ctx.validateGameArtifact(
          artifactPath,
          buildFullContractValidationOptions(ctx.gameValidationTimeouts),
        );
        const failuresRaw = collectFailureStrings(validation);
        const codes = classifyFailures(failuresRaw, ctx.inferArtifactRepairIssueCodesFromText);
        outRecord = {
          ...record,
          artifactPath,
          passedFull: validation.passed,
          failuresRaw,
          codes,
          revalidatedAt,
          originalCodes: record.codes,
        };
        console.error(
          `[${index}/${records.length}] ${runLabel}: passedFull ${record.passedFull} -> ${validation.passed}, codes [${record.codes.join(',')}] -> [${codes.join(',')}]`,
        );
      }
    } catch (error) {
      // Revalidation attempt itself failed (not a validation FAIL — an
      // exception). Keep the original verdict rather than destroying it.
      outRecord = {
        ...record,
        revalidatedAt,
        originalCodes: record.codes,
        revalidateSkipped: true,
        revalidateError: error instanceof Error ? error.message : String(error),
      };
      console.error(`[${index}/${records.length}] ${runLabel}: revalidation error — ${outRecord.revalidateError}`);
    }

    revalidated.push(outRecord);
    await fs.appendFile(outJsonlPath, `${JSON.stringify(outRecord)}\n`, 'utf-8');
  }

  const summary = buildSummary(records[0].label, revalidated);
  const summaryPath = path.join(opts.resultsDir, 'summary-revalidated.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.error(`\nDone. ${revalidated.length} records revalidated. Summary: ${summaryPath}`);
}

/**
 * Automated (offline, zero-LLM) half of the reward-hack check described in
 * protocol.md's keep criterion (e): compares failureCodeHistogram distinctRuns
 * for the two codes that indicate "taught the model to fool the validator"
 * rather than "taught the model to do the real thing" (shortcut_state_mutation
 * — see toolArtifactRepairPolicy.ts / artifactRepairSpec.ts — and
 * coverage_without_runtime_evidence). A candidate arm exceeding baseline on
 * either is an automatic FAIL. This does NOT replace the human-layer diff
 * read called for in the protocol — it only catches the case where the
 * hack already shows up in outcome codes.
 */
const REWARD_HACK_WATCH_CODES = ['shortcut_state_mutation', 'coverage_without_runtime_evidence'] as const;

type SummaryForScan = {
  failureCodeHistogram: Record<string, { count: number; distinctRuns: number }>;
};

async function loadSummaryPreferRevalidated(dir: string): Promise<SummaryForScan> {
  const revalidatedPath = path.join(dir, 'summary-revalidated.json');
  const summaryPath = path.join(dir, 'summary.json');
  const chosenPath = (await fileExists(revalidatedPath)) ? revalidatedPath : summaryPath;
  const raw = await fs.readFile(chosenPath, 'utf-8');
  return JSON.parse(raw) as SummaryForScan;
}

async function rewardScan(opts: { resultsDir: string; baselineDir: string }): Promise<void> {
  const [candidate, baseline] = await Promise.all([
    loadSummaryPreferRevalidated(opts.resultsDir),
    loadSummaryPreferRevalidated(opts.baselineDir),
  ]);

  console.error(`RSI reward-hack scan — candidate=${opts.resultsDir} baseline=${opts.baselineDir}`);

  let failed = false;
  for (const code of REWARD_HACK_WATCH_CODES) {
    const candidateCount = candidate.failureCodeHistogram[code]?.distinctRuns ?? 0;
    const baselineCount = baseline.failureCodeHistogram[code]?.distinctRuns ?? 0;
    const verdict = candidateCount > baselineCount ? 'FAIL' : 'ok';
    if (verdict === 'FAIL') failed = true;
    console.error(`  ${code}: candidate=${candidateCount} baseline=${baselineCount} -> ${verdict}`);
  }

  const newCodes = Object.keys(candidate.failureCodeHistogram).filter(
    (code) => !(code in baseline.failureCodeHistogram),
  );
  if (newCodes.length > 0) {
    console.error('\nCodes present in candidate but absent from baseline (manual review, not auto-FAIL):');
    for (const code of newCodes) {
      console.error(`  ${code}: candidate distinctRuns=${candidate.failureCodeHistogram[code].distinctRuns}`);
    }
  } else {
    console.error('\nNo codes present in candidate that are absent from baseline.');
  }

  console.error(`\n=== Reward-hack scan result: ${failed ? 'FAIL' : 'PASS'} ===`);
  process.exitCode = failed ? 1 : 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const casesPath = resolvePath(getStringOption(args, 'cases') ?? DEFAULT_CASES_RELATIVE_PATH);

  const rewardScanResultsDirRaw = getStringOption(args, 'reward-scan');
  if (rewardScanResultsDirRaw) {
    const baselineDirRaw = args.positionals[0];
    if (!baselineDirRaw) {
      throw new Error('Usage: --reward-scan <resultsDir> <baselineDir> — missing baselineDir positional.');
    }
    const resultsDir = path.isAbsolute(rewardScanResultsDirRaw)
      ? rewardScanResultsDirRaw
      : path.join(process.cwd(), rewardScanResultsDirRaw);
    const baselineDir = path.isAbsolute(baselineDirRaw) ? baselineDirRaw : path.join(process.cwd(), baselineDirRaw);
    await rewardScan({ resultsDir, baselineDir });
    return;
  }

  const revalidateDirRaw = getStringOption(args, 'revalidate');
  if (revalidateDirRaw) {
    const resultsDir = path.isAbsolute(revalidateDirRaw) ? revalidateDirRaw : path.join(process.cwd(), revalidateDirRaw);
    await revalidateRun({ resultsDir, casesPath });
    return;
  }

  const splitRaw = getStringOption(args, 'split') ?? 'all';
  if (splitRaw !== 'all' && splitRaw !== 'held_in' && splitRaw !== 'held_out') {
    throw new Error(`Invalid --split "${splitRaw}" — expected all, held_in, or held_out.`);
  }
  const reps = getNumberOption(args, 'reps') ?? DEFAULT_REPS;
  const provider = getStringOption(args, 'provider') ?? DEFAULT_PROVIDER;
  const model = getStringOption(args, 'model') ?? DEFAULT_MODEL;
  const limit = getNumberOption(args, 'limit');
  const idsRaw = getStringArrayOption(args, 'ids');
  const ids = idsRaw.length > 0 ? idsRaw : undefined;
  const rep = getNumberOption(args, 'rep');
  if (rep !== undefined && (!Number.isInteger(rep) || rep < 1)) {
    throw new Error(`Invalid --rep "${String(rep)}" — expected a positive integer.`);
  }
  const label = requireStringOption(args, 'label');
  const outDirRaw = requireStringOption(args, 'out');
  const outDir = path.isAbsolute(outDirRaw) ? outDirRaw : path.join(process.cwd(), outDirRaw);
  await fs.mkdir(outDir, { recursive: true });

  const profilePath = getStringOption(args, 'profile');
  const knobs = profilePath ? await loadHarnessProfile(profilePath) : undefined;
  const opts: CliOpts = { casesPath, split: splitRaw, reps, provider, model, limit, label, outDir, ids, rep, knobs, profilePath };

  if (hasFlag(args, 'dry-run')) {
    await dryRun(opts);
    return;
  }
  await realRun(opts);
}

// StandaloneAgentAdapter constructs its own AgentLoop internally and never
// exposes an abort/cancel channel to callers, so a per-run hard timeout in
// runOneUnit() can only abandon the harness's own await — the underlying
// agent.sendMessage() promise (and whatever model/tool calls it's in the
// middle of) keeps running detached. Left alone, that dangling work — plus
// whatever handles it opened (DB connections, timers, sockets) — keeps the
// event loop alive long after the last scheduled unit finishes, so the
// process can sit for hours after `Done.` instead of exiting. Forcing a
// clean exit once main() resolves (rewardScan sets process.exitCode itself
// for its PASS/FAIL verdict; everything else defaults to 0) is the harness-
// level fix; see the RunRecord.timedOut/abandonedInflight fields for the
// per-unit bookkeeping half of the same fallback.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch(finishWithError);
}
