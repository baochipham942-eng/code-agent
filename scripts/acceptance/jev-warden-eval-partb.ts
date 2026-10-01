// Part B: materialise live cases outside the repo and run eval-ci on/off in ABAB chunks.
// --run-id is still passed, but eval-ci only installs it when --json-events creates an event
// stream, and that mode rejects concurrency > 1. This run keeps --concurrency 3 and binds
// each arm to the report path printed as "Reports saved to".
// --scope full: with no scope, eval-ci returns before a real run when change detection declines.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTestSuite } from '../../src/host/testing/testCaseLoader';

import {
  BASELINE_PRICES,
  HARD_STOP_USD,
  assertCaseDirOutsideRepo,
  isFakeDone,
  isRecord,
  isSpin,
  listPriceUsd,
  loadLiveCases,
  outDir,
  parseActualUsage,
  processLineUsd,
  readWardenDocument,
  recommendationFor,
  roundUsd,
  scrubSecrets,
  stripAnsi,
  sumPartB,
  violationCount,
  wiringOf,
  writeWardenDocument,
  repoRoot,
  type ExecLite,
  type LiveCase,
  type PartBCaseArm,
  type PartBRunMeta,
  type TokenPrice,
  type UsageSplit,
  type WardenDocument,
} from './jev-warden-eval-metrics';

const ARM_TIMEOUT_MS = 25 * 60 * 1000;
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

interface Baseline {
  name: string;
  provider: string;
  model: string;
  kind: 'deepseek' | 'stepfun' | 'moonshot' | 'longcat';
  price: TokenPrice;
}

interface Candidate {
  name: string;
  provider: string;
  model: string;
  envKey: string;
  baseUrl: string;
  kind: Baseline['kind'];
}

const CANDIDATES: readonly Candidate[] = [
  {
    name: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    kind: 'deepseek',
  },
  {
    name: 'stepfun',
    provider: 'custom-stepfun',
    model: 'step-3.5-flash-2603',
    envKey: 'STEPFUN_API_KEY',
    // OpenAI-compatible base URL: https://api.stepfun.com/v1
    baseUrl: 'https://api.stepfun.com/v1',
    kind: 'stepfun',
  },
  {
    name: 'moonshot',
    provider: 'moonshot',
    model: 'kimi-k2.6',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    kind: 'moonshot',
  },
  {
    name: 'longcat',
    provider: 'longcat',
    model: 'LongCat-2.0',
    envKey: 'LONGCAT_API_KEY',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    kind: 'longcat',
  },
];

function keyPresence(name: string): string {
  const value = process.env[name];
  return `${name}=${value && value.trim() ? 'set' : 'unset'}`;
}

function knownSecrets(): string[] {
  const secrets: string[] = [];
  for (const name of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'STEPFUN_API_KEY', 'MOONSHOT_API_KEY', 'LONGCAT_API_KEY', 'AUTO_TEST_API_KEY']) {
    const value = process.env[name];
    if (value && value.trim()) secrets.push(value.trim());
  }
  return secrets;
}

function dataDir(): string {
  return path.join(os.homedir(), 'work/evalslot/.code-agent-dev8');
}

async function probeChat(baseUrl: string, model: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return String(response.status);
  } catch {
    return 'throw';
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBaseline(secrets: string[]): Promise<{ baseline: Baseline; probes: Record<string, string> }> {
  const probes: Record<string, string> = {};
  for (const candidate of CANDIDATES) {
    const key = process.env[candidate.envKey]?.trim();
    if (!key) {
      probes[candidate.name] = 'unset';
      console.log(`baseline probe ${candidate.name}: unset`);
      continue;
    }
    if (!secrets.includes(key)) secrets.push(key);
    const status = await probeChat(candidate.baseUrl, candidate.model, key);
    probes[candidate.name] = status;
    console.log(`baseline probe ${candidate.name}: ${status}`);
    if (status !== '200') continue;
    const price = BASELINE_PRICES[candidate.model];
    if (!price) throw new Error(`no list price for ${candidate.model}`);
    for (const rest of CANDIDATES) {
      if (!(rest.name in probes)) probes[rest.name] = 'skipped';
    }
    console.log(`resolved baseline: ${candidate.provider} / ${candidate.model}`);
    return {
      baseline: {
        name: candidate.name,
        provider: candidate.provider,
        model: candidate.model,
        kind: candidate.kind,
        price,
      },
      probes,
    };
  }
  throw new Error(`no baseline probe succeeded: ${JSON.stringify(probes)}`);
}

function renderSuite(cases: readonly LiveCase[]): string {
  const lines = [
    'name: "jev warden live"',
    'description: "harmless sandbox tasks that tend to spin or claim completion"',
    'default_timeout: 180000',
    'default_max_cost_usd: 0.30',
    'tags:',
    '  - jev-warden-eval',
    'cases:',
  ];
  for (const item of cases) {
    lines.push(`  - id: ${item.id}`);
    lines.push('    type: task');
    lines.push('    category: task_completion');
    lines.push('    difficulty: medium');
    lines.push('    timeout: 180000');
    lines.push('    max_cost_usd: 0.30');
    lines.push(`    description: ${JSON.stringify(item.id)}`);
    lines.push('    prompt: |');
    for (const row of item.task.split('\n')) lines.push(`      ${row}`);
    lines.push('    expect:');
    lines.push('      min_tool_calls: 1');
  }
  return `${lines.join('\n')}\n`;
}

function materialiseChunk(index: number, cases: readonly LiveCase[]): string {
  const preferred = path.join(outDir(), 'cases', `chunk-${index}`);
  let dir = preferred;
  try {
    assertCaseDirOutsideRepo(dir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    dir = path.join(os.tmpdir(), `jev-warden-eval-${process.pid}`, `chunk-${index}`);
    assertCaseDirOutsideRepo(dir);
  }
  fs.writeFileSync(path.join(dir, 'cases.yaml'), renderSuite(cases));
  return dir;
}

function childEnv(arm: 'on' | 'off', baseline: Baseline): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PROXY_VARS) delete env[name];
  env.CODE_AGENT_DATA_DIR = dataDir();
  env.NEO_SCRIPTED_APPROVAL_POLICY = path.join(repoRoot(), '.claude/eval-approval-policy.json');
  env.CODE_AGENT_JEV_WARDEN = arm === 'on' ? '1' : '0';
  delete env.AUTO_TEST_API_KEY;
  delete env.AUTO_TEST_BASE_URL;
  delete env.AUTO_TEST_PROVIDER;
  delete env.AUTO_TEST_MODEL;
  if (baseline.kind === 'stepfun') {
    const key = process.env.STEPFUN_API_KEY?.trim();
    if (!key) throw new Error('STEPFUN_API_KEY missing at spawn');
    env.AUTO_TEST_BASE_URL = 'https://api.stepfun.com/v1';
    env.AUTO_TEST_API_KEY = key;
  }
  return env;
}

function runEval(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd: repoRoot(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000);
    }, ARM_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const finish = (code: number) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

function lastReportPath(output: string): string | null {
  let found: string | null = null;
  for (const match of stripAnsi(output).matchAll(/Reports saved to:\s*(\S+)/g)) {
    if (match[1]) found = match[1];
  }
  return found;
}

function jsonSibling(reportPath: string): string {
  if (reportPath.endsWith('.md')) return `${reportPath.slice(0, -3)}.json`;
  if (reportPath.endsWith('.json')) return reportPath;
  return `${reportPath}.json`;
}

function looksLikeCaseDirRefusal(output: string): boolean {
  return /outside (the |a )?repo|must be inside|case-dir.{0,80}(refus|outside|not allowed)|refus(e|al|ed).{0,80}(case dir|case-dir)/i.test(output);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finalResponse(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const last = value[value.length - 1];
  return typeof last === 'string' ? last : null;
}

function readExecList(value: unknown): ExecLite[] {
  if (!Array.isArray(value)) return [];
  const execs: ExecLite[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.tool !== 'string') continue;
    execs.push({
      tool: item.tool,
      input: isRecord(item.input) ? item.input : {},
      success: item.success === true,
      failed: item.success === false,
    });
  }
  return execs;
}

function countTrace(sessionId: string | null): { events: number; failOpen: number; confirmed: number } {
  const empty = { events: 0, failOpen: 0, confirmed: 0 };
  if (!sessionId || sessionId.includes('/') || sessionId.includes('..')) return empty;
  const file = path.join(dataDir(), 'traces', `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return empty;
  let events = 0;
  let failOpen = 0;
  let confirmed = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'jev_warden') continue;
    events += 1;
    const data = isRecord(parsed.data) ? parsed.data : null;
    if (data?.failOpen) failOpen += 1;
    if (Array.isArray(data?.confirmed) && data.confirmed.length > 0) confirmed += 1;
  }
  return { events, failOpen, confirmed };
}

function armFromResult(
  result: Record<string, unknown>,
  expectFile: string,
  price: TokenPrice,
  cliRunId: string,
  reportRunId: string | null,
): PartBCaseArm {
  const execs = readExecList(result.toolExecutions);
  const spin = isSpin(execs);
  const fakeDone = isFakeDone(finalResponse(result.responses), execs, expectFile);
  const usage = isRecord(result.usage) ? result.usage : null;
  const split: UsageSplit | null = usage
    ? {
      promptTokens: numberOrNull(usage.promptTokens) ?? Number.NaN,
      completionTokens: numberOrNull(usage.completionTokens) ?? Number.NaN,
      cacheReadTokens: numberOrNull(usage.cacheReadTokens) ?? Number.NaN,
      cacheCreationTokens: numberOrNull(usage.cacheCreationTokens) ?? Number.NaN,
    }
    : null;
  const splitOk = split !== null && Object.values(split).every((value) => Number.isFinite(value));
  const uncachedOk = splitOk && split !== null
    && split.promptTokens - split.cacheReadTokens - split.cacheCreationTokens >= 0;
  const unavailable = result.usageStatus === 'usage_unavailable' || !splitOk || !uncachedOk;
  const sessionId = typeof result.sessionId === 'string' ? result.sessionId : null;
  const trace = countTrace(sessionId);
  return {
    spin,
    fakeDone,
    violations: violationCount(spin, fakeDone),
    turnCount: numberOrNull(result.turnCount) ?? 0,
    usd: unavailable || split === null ? null : listPriceUsd(price, split),
    reportUsd: numberOrNull(result.costUsd),
    promptTokens: splitOk && split ? split.promptTokens : null,
    completionTokens: splitOk && split ? split.completionTokens : null,
    cacheReadTokens: splitOk && split ? split.cacheReadTokens : null,
    cacheCreationTokens: splitOk && split ? split.cacheCreationTokens : null,
    jevWardenEvents: trace.events,
    jevWardenFailOpen: trace.failOpen,
    jevWardenConfirmed: trace.confirmed,
    cliRunId,
    reportRunId,
    usageStatus: typeof result.usageStatus === 'string' ? result.usageStatus : null,
  };
}

function parseReport(
  file: string,
  cases: readonly LiveCase[],
  price: TokenPrice,
  cliRunId: string,
): { runId: string | null; arms: Map<string, PartBCaseArm>; missing: string[] } {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) throw new Error(`report ${file} has no results array`);
  const runId = typeof parsed.runId === 'string' ? parsed.runId : null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of parsed.results) {
    if (!isRecord(item) || typeof item.testId !== 'string') continue;
    byId.set(item.testId, item);
  }
  const arms = new Map<string, PartBCaseArm>();
  const missing: string[] = [];
  for (const item of cases) {
    const result = byId.get(item.id);
    if (!result) {
      missing.push(item.id);
      continue;
    }
    arms.set(item.id, armFromResult(result, item.expectFile, price, cliRunId, runId));
  }
  return { runId, arms, missing };
}

function failLoud(message: string): never {
  console.error(message);
  console.error('part B fail-loud: warden.json left unchanged');
  process.exit(1);
}

export async function runPartB(): Promise<void> {
  for (const name of PROXY_VARS) delete process.env[name];
  for (const name of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'STEPFUN_API_KEY', 'MOONSHOT_API_KEY', 'LONGCAT_API_KEY']) {
    console.log(keyPresence(name));
  }
  const existing = readWardenDocument();
  if (!existing) {
    console.error('part B refused: part A warden.json is missing or unreadable; not spending');
    process.exit(1);
  }
  const secrets = knownSecrets();
  let resolved: { baseline: Baseline; probes: Record<string, string> };
  try {
    resolved = await resolveBaseline(secrets);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const { baseline, probes } = resolved;
  const live = loadLiveCases();
  const chunks: LiveCase[][] = [];
  for (let index = 0; index < live.length; index += 10) chunks.push(live.slice(index, index + 10));
  const caseDirs: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    const dir = materialiseChunk(index, chunk);
    const suite = await loadTestSuite(path.join(dir, 'cases.yaml'));
    if (suite.cases.length !== chunk.length) {
      console.error(`chunk ${index} loaded ${suite.cases.length} cases, expected ${chunk.length}`);
      process.exit(1);
    }
    caseDirs.push(dir);
    console.log(`materialised chunk ${index} outside the repo: ${dir} (${suite.cases.length} cases)`);
  }
  const doc: WardenDocument = {
    ...existing,
    baseline: {
      provider: baseline.provider,
      model: baseline.model,
      probes,
      listPricePer1M: baseline.price,
    },
    partB: {
      complete: false,
      cases: live.map((item) => ({ id: item.id, expectFile: item.expectFile, on: null, off: null })),
      runs: [],
    },
  };
  let spent = roundUsd(doc.partA.totals.on.usd + doc.partA.totals.off.usd);
  console.log(`part A list usd carried into the hard stop: ${spent}`);
  const runs: PartBRunMeta[] = [];
  let partialReason: string | undefined;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    const order: Array<'on' | 'off'> = index % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
    const caseDir = caseDirs[index] ?? materialiseChunk(index, chunk);
    for (const arm of order) {
      if (spent >= HARD_STOP_USD) {
        partialReason = `hard stop before spawn: cumulative list-price USD ${spent} >= ${HARD_STOP_USD}`;
        console.error(partialReason);
        break;
      }
      const cliRunId = `warden-c${index}-${arm}`;
      console.log(`spawn ${cliRunId} provider=${baseline.provider} model=${baseline.model} cases=${chunk.map((item) => item.id).join(',')}`);
      const args = [
        'tsx',
        'packages/internal/evaluation-center/scripts/eval-ci.ts',
        '--real',
        '--provider', baseline.provider,
        '--model', baseline.model,
        '--case-cost-limit', '0.30',
        '--concurrency', '3',
        '--force',
        '--scope', 'full',
        '--max-cases', String(chunk.length),
        '--case-dir', caseDir,
        '--run-id', cliRunId,
        '--ids', chunk.map((item) => item.id).join(','),
      ];
      const result = await runEval(args, childEnv(arm, baseline));
      const scrubbed = scrubSecrets(result.output, secrets);
      fs.mkdirSync(path.join(outDir(), 'logs'), { recursive: true });
      fs.writeFileSync(path.join(outDir(), 'logs', `${cliRunId}.log`), scrubbed);
      const usage = parseActualUsage(scrubbed);
      if (!usage) failLoud(`part B ${cliRunId} missing Actual usage line (exit ${result.code}, timedOut=${result.timedOut})`);
      console.log(`${cliRunId} ${usage.line}`);
      if (usage.zero) failLoud(`part B ${cliRunId} Actual usage is 0 in / 0 out`);
      const reportMarkdown = lastReportPath(scrubbed);
      if (!reportMarkdown) {
        const refusal = looksLikeCaseDirRefusal(scrubbed);
        console.error(refusal ? `part B ${cliRunId} case-dir refusal:` : `part B ${cliRunId} missing report path:`);
        console.error(scrubbed);
        failLoud(refusal ? 'eval-ci refused the external case dir' : 'eval-ci produced no report path');
      }
      const reportJson = jsonSibling(reportMarkdown);
      if (!fs.existsSync(reportJson)) failLoud(`part B ${cliRunId} report json missing: ${reportJson}`);
      const copied = path.join(outDir(), 'reports', `${cliRunId}.json`);
      fs.mkdirSync(path.dirname(copied), { recursive: true });
      fs.writeFileSync(copied, scrubSecrets(fs.readFileSync(reportJson, 'utf8'), secrets));
      let parsed: ReturnType<typeof parseReport>;
      try {
        parsed = parseReport(copied, chunk, baseline.price, cliRunId);
      } catch (error) {
        failLoud(error instanceof Error ? error.message : String(error));
      }
      const listUsd = processLineUsd(baseline.price, usage);
      spent = roundUsd(spent + listUsd);
      runs.push({
        cliRunId,
        reportRunId: parsed.runId,
        chunk: index,
        arm,
        exitCode: result.code,
        actualUsageLine: usage.line,
        processListUsd: listUsd,
        processReportUsd: usage.processReportUsd,
        reportPath: copied,
      });
      console.log(`${cliRunId} exit=${result.code} processListUsd=${listUsd} cumulative=${spent} reportRunId=${parsed.runId ?? 'none'}`);
      for (const [id, armRow] of parsed.arms) {
        const slot = doc.partB.cases.find((item) => item.id === id);
        if (!slot) continue;
        slot[arm] = armRow;
      }
      if (parsed.missing.length > 0) {
        partialReason = `missing result for ${parsed.missing.join(',')} on ${cliRunId}`;
        console.error(partialReason);
      }
    }
    if (partialReason?.startsWith('hard stop')) break;
  }
  doc.partB.runs = runs;
  doc.partB.partialReason = partialReason;
  doc.partB.totals = {
    on: sumPartB(doc.partB.cases.map((item) => item.on)),
    off: sumPartB(doc.partB.cases.map((item) => item.off)),
  };
  doc.partB.wiring = wiringOf(doc.partB.cases);
  const everyArmFilled = doc.partB.cases.every((item) => item.on && item.off);
  doc.partB.complete = everyArmFilled && partialReason === undefined;
  doc.recommendation = recommendationFor(doc);
  writeWardenDocument(doc);
  console.log(`wiring: ${doc.partB.wiring.note}`);
  console.log(`recommendation: ${doc.recommendation}`);
  console.log(`part B cumulative list usd including part A: ${spent}`);
}
