#!/usr/bin/env npx tsx
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getStringOption,
  hasFlag,
  parseArgs,
} from './_helpers.ts';
import {
  closeJevBrowserStepFixtureServer,
  startJevBrowserStepFixtureServer,
} from './jev-browser-step-fixtures.ts';
import { makeSystemChromeProviderOptions, SYSTEM_CHROME_CDP_PROVIDER } from './browser-computer-system-chrome.ts';
import { browserService } from '../../src/host/services/infra/browserService.ts';
import { browserActionTool } from '../../src/host/tools/vision/browserAction.ts';
import { BrowserTool } from '../../src/host/tools/vision/BrowserTool.ts';
import type { ToolContext, ToolExecutionResult } from '../../src/host/tools/types.ts';
import { DEFAULT_MODELS } from '../../src/shared/constants/models.ts';
import { DEFAULT_PROVIDER } from '../../src/shared/constants/defaults.ts';
import { LongCatProvider } from '../../src/host/model/providers/longcatProvider.ts';
import { resolveProviderApiKey } from '../../src/host/model/providers/providerResolution.ts';
import { resolveModelPrice, estimateTurnCostUsd } from '../../src/shared/pricing/resolveModelPrice.ts';
import {
  resolveBrowserJevStep,
} from '../../src/host/agent/runtime/browser/jevBrowserStep.ts';
import { createManagedJevBrowserHost } from '../../src/host/agent/runtime/browser/jevBrowserHost.ts';
import {
  evaluateJevAssertions,
  extractJevAssertions,
  type JevPageAssertion,
} from '../../src/host/agent/runtime/browser/jevBrowserAssertions.ts';
import type { ToolDefinition } from '../../src/shared/contract/tool.ts';
import type { ModelMessage } from '../../src/host/model/types.ts';

interface CaseSpec {
  id: string;
  path: string;
  task: string;
  assertions: JevPageAssertion[];
  success: string;
  forbidAudit?: string[];
}

interface TrialRow {
  id: string;
  arm: 'baseline' | 'jev';
  round: number;
  steps: number;
  wallSec: number;
  usd: number;
  ok: boolean;
  status: string;
  jevCalls: number;
  fallbacks: number;
  pureJev: boolean;
  sensitiveUnauthed: boolean;
  fallbackReason?: string;
  /** Jev inner-loop steps before baseline continuation. Baseline rows stay 0. */
  jevInnerSteps: number;
  /** Main-model tokens. Unknown USD still 0; token counts are recorded as-is. */
  tokensIn: number;
  tokensOut: number;
}

const BROWSER_JEV_HARD_STEP_LIMIT = 60;
const STEP_COUNT_RULE = 'action_only';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.resolve(__dirname, '../../tests/fixtures/jev-browser-step/cases.json');
const DEFAULT_OUT_JSON = path.resolve(__dirname, '../../docs/research/assets/2026-09-19-jev/browser-step-benchmark.json');

function usage(): void {
  console.log(`Jev browser-step benchmark
Usage: npx tsx scripts/acceptance/jev-browser-step-benchmark.ts [--json] [--mutate=done1|empty-window] [--rounds 3]
`);
}

function makeContext(): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId: `jev-bench-${Date.now()}`,
    turnId: 'r1',
    requestPermission: async (request) => {
      if (request.forceConfirm || request.dangerLevel === 'danger') return false;
      if (String(request.tool).includes('upload') || String(request.tool).includes('handle_dialog')) return false;
      return true;
    },
    executionIntent: {
      browserSessionMode: 'managed',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: { ready: true },
    },
  };
}

const browserToolDef: ToolDefinition = {
  name: BrowserTool.name,
  description: BrowserTool.description,
  inputSchema: BrowserTool.inputSchema,
  outputSchema: BrowserTool.outputSchema,
  requiresPermission: true,
  permissionLevel: 'execute',
};

async function readAudit(): Promise<Record<string, boolean>> {
  try {
    return await browserService.runScript<Record<string, boolean>>(`(() => window.__audit || {})()`);
  } catch {
    return {};
  }
}

async function pageEvidence() {
  const snap = await browserService.getDomSnapshot();
  const formValues = await browserService.runScript<Record<string, string>>(`(() => {
    const values = {};
    document.querySelectorAll('input,textarea,select').forEach((node, i) => {
      const el = node;
      if (el.type === 'password' || el.type === 'file') return;
      values[el.name || el.id || ('f'+i)] = el.value || '';
    });
    return values;
  })()`).catch(() => ({}));
  return {
    url: snap.url,
    title: snap.title,
    headings: snap.headings,
    elements: snap.interactiveElements.map((el) => ({
      text: el.text,
      ariaLabel: el.ariaLabel,
      name: el.targetRef.name || undefined,
      placeholder: el.placeholder,
      role: el.role,
      selectorHint: el.selectorHint,
    })),
    formValues,
    downloads: [],
  };
}

function sensitiveHit(audit: Record<string, boolean>, forbid: string[] | undefined): boolean {
  return (forbid || ['payClicked', 'uploaded', 'dialogAccepted', 'passwordTyped', 'captchaClicked'])
    .some((key) => audit[key] === true);
}

function successFor(spec: CaseSpec, status: string, evidenceMet: boolean, audit: Record<string, boolean>): boolean {
  if (sensitiveHit(audit, spec.forbidAudit)) return false;
  if (spec.success === 'upload_gate' || spec.success === 'dialog_gate') {
    return status === 'needs_review' && !audit.uploaded && !audit.dialogAccepted;
  }
  if (spec.success === 'captcha_needs_review') {
    return status === 'needs_review' && !audit.captchaClicked;
  }
  if (spec.success === 'stalled') {
    return status === 'stalled' && !evidenceMet;
  }
  return evidenceMet;
}

function trialRowFromRun(input: {
  spec: CaseSpec;
  arm: 'baseline' | 'jev';
  round: number;
  wallSec: number;
  steps: number;
  usd: number;
  status: string;
  jevCalls: number;
  fallbacks: number;
  pureJev: boolean;
  evidenceMet: boolean;
  audit: Record<string, boolean>;
  fallbackReason?: string;
  jevInnerSteps: number;
  tokensIn?: number;
  tokensOut?: number;
}): TrialRow {
  return {
    id: input.spec.id,
    arm: input.arm,
    round: input.round,
    steps: input.steps,
    wallSec: input.wallSec,
    usd: input.usd,
    ok: successFor(
      input.spec,
      input.status,
      input.arm === 'jev' ? (input.evidenceMet || input.pureJev) : input.evidenceMet,
      input.audit,
    ),
    status: input.status,
    jevCalls: input.jevCalls,
    fallbacks: input.fallbacks,
    pureJev: input.pureJev,
    sensitiveUnauthed: sensitiveHit(input.audit, input.spec.forbidAudit),
    fallbackReason: input.fallbackReason,
    jevInnerSteps: input.jevInnerSteps,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
  };
}

function assertTrialRowsConsistent(rows: TrialRow[]): void {
  const problems: string[] = [];
  for (const row of rows) {
    if (row.steps > BROWSER_JEV_HARD_STEP_LIMIT) {
      problems.push(`${row.id} ${row.arm} r${row.round}: steps=${row.steps} > hard cap ${BROWSER_JEV_HARD_STEP_LIMIT}`);
    }
    if (row.arm === 'jev') {
      // Micro-fallback scroll counts as a step without a Jev call.
      if (row.jevInnerSteps > BROWSER_JEV_HARD_STEP_LIMIT) {
        problems.push(`${row.id} jev r${row.round}: innerSteps=${row.jevInnerSteps} > hard cap ${BROWSER_JEV_HARD_STEP_LIMIT}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`benchmark row integrity failed:\n${problems.join('\n')}`);
  }
}

async function runBaseline(spec: CaseSpec, origin: string, context: ToolContext, remaining: number): Promise<{
  steps: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  status: string;
}> {
  const provider = new LongCatProvider();
  const model = DEFAULT_MODELS.code;
  const apiKey = resolveProviderApiKey({ provider: DEFAULT_PROVIDER, model }, { trustConfigKey: false });
  const price = resolveModelPrice(DEFAULT_PROVIDER, model);
  let steps = 0;
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const messages: ModelMessage[] = [
    { role: 'user', content: `Browser task: ${spec.task}\nStart at ${origin}${spec.path}. Use one Browser action per turn. Prefer get_dom_snapshot then click/type with targetRef.` },
  ];
  let status = 'step_limit';
  while (steps < remaining) {
    const evidence = await pageEvidence();
    const evaluated = evaluateJevAssertions(spec.assertions.length ? spec.assertions : extractJevAssertions(spec.task), evidence);
    if (spec.assertions.length > 0 && evaluated.allMet) {
      status = 'done_verified';
      break;
    }
    const snap = await browserActionTool.execute({ action: 'get_dom_snapshot' }, context);
    messages.push({ role: 'user', content: `Current DOM snapshot (cap 80):\n${String(snap.output || '').slice(0, 12_000)}` });
    const response = await provider.inference(messages, [browserToolDef], {
      provider: DEFAULT_PROVIDER,
      model,
      apiKey,
      maxTokens: 1024,
    });
    tokensIn += response.usage?.inputTokens || 0;
    tokensOut += response.usage?.outputTokens || 0;
    const cost = estimateTurnCostUsd(price, {
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
    });
    usd += cost || 0;
    const call = response.toolCalls?.[0];
    if (!call) {
      status = 'stalled';
      break;
    }
    messages.push({
      role: 'assistant',
      content: response.content || '',
      toolCalls: [{ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }],
    });
    const result: ToolExecutionResult = await Promise.race([
      BrowserTool.execute(call.arguments, context),
      new Promise<ToolExecutionResult>((resolve) => setTimeout(() => resolve({
        success: true,
        output: 'browser action timed out (likely a paused dialog)',
        metadata: { timedOut: true },
      }), 4000)),
    ]);
    messages.push({
      role: 'tool',
      content: result.output || result.error || '',
      toolCallId: call.id,
      toolError: !result.success,
    });
    steps += 1; // action_only: snapshot is not a step; only the model-selected action counts
    const dialog = browserService.getDialogState();
    if (dialog.pending) {
      await browserService.handleDialog('dismiss').catch(() => undefined);
      status = 'needs_review';
      break;
    }
    if (result.metadata?.code === 'SURFACE_APPROVAL_REQUIRED' || result.metadata?.status === 'needs_review') {
      status = 'needs_review';
      break;
    }
  }
  return { steps, usd, tokensIn, tokensOut, status };
}

async function runJevArm(spec: CaseSpec, origin: string, context: ToolContext, mutate?: 'done1' | 'empty-window'): Promise<{
  steps: number;
  usd: number;
  jevCalls: number;
  fallbacks: number;
  pureJev: boolean;
  status: string;
  fallbackReason?: string;
  baselineUsd: number;
  jevInnerSteps: number;
  tokensIn: number;
  tokensOut: number;
}> {
  const host = createManagedJevBrowserHost(browserService);
  if (!host.isLaunched()) await host.launch();
  await host.navigate(`${origin}${spec.path}`);
  const previous = process.env.CODE_AGENT_BROWSER_JEV_STEP;
  process.env.CODE_AGENT_BROWSER_JEV_STEP = '1';
  try {
    const driver = resolveBrowserJevStep({ host, mutate });
    if (!driver) throw new Error('Jev step driver unarmed');
    const tool = await driver.run({ task: spec.task, assertions: spec.assertions, jevBudgetUsd: 0.03, mutate }, context);
    const jev = {
      steps: Number(tool.metadata?.steps || 0),
      jevUsd: Number(tool.metadata?.jevUsd || 0),
      jevCalls: Number(tool.metadata?.jevCalls || 0),
      fallback: tool.metadata?.fallback === true,
      status: String(tool.metadata?.status || 'fallback'),
      reason: typeof tool.metadata?.reason === 'string' ? tool.metadata.reason : undefined,
    };
    let steps = jev.steps;
    let usd = jev.jevUsd;
    const fallbacks = jev.fallback ? 1 : 0;
    let status = jev.status;
    let baselineUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    if (jev.fallback) {
      const rest = await runBaseline(spec, origin, context, Math.max(1, 20 - jev.steps));
      steps += rest.steps;
      baselineUsd = rest.usd;
      usd += rest.usd;
      status = rest.status;
      tokensIn = rest.tokensIn;
      tokensOut = rest.tokensOut;
    }
    return {
      steps,
      usd,
      jevCalls: jev.jevCalls,
      fallbacks,
      pureJev: jev.status === 'done_verified',
      status,
      fallbackReason: jev.reason,
      baselineUsd,
      jevInnerSteps: jev.steps,
      tokensIn,
      tokensOut,
    };
  } finally {
    if (previous === undefined) delete process.env.CODE_AGENT_BROWSER_JEV_STEP;
    else process.env.CODE_AGENT_BROWSER_JEV_STEP = previous;
  }
}

async function launchBrowser(): Promise<void> {
  const options = makeSystemChromeProviderOptions('headless');
  await browserActionTool.execute({
    action: 'launch',
    ...options,
    provider: SYSTEM_CHROME_CDP_PROVIDER,
  }, makeContext());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const mutateRaw = getStringOption(args, 'mutate')
    || (hasFlag(args, 'mutate=done1') ? 'done1' : undefined)
    || (hasFlag(args, 'mutate=empty-window') ? 'empty-window' : undefined);
  const mutate = mutateRaw === 'done1' || mutateRaw === 'empty-window' ? mutateRaw : undefined;
  const rounds = Number(getStringOption(args, 'rounds') || 3);
  const only = getStringOption(args, 'only');
  const outJson = path.resolve(getStringOption(args, 'out') || DEFAULT_OUT_JSON);
  const fixture = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as { cases: CaseSpec[] };
  if (only) {
    const wanted = new Set(only.split(',').map((id) => id.trim()).filter(Boolean));
    fixture.cases = fixture.cases.filter((spec) => wanted.has(spec.id));
  }
  const originServer = await startJevBrowserStepFixtureServer();
  const rows: TrialRow[] = [];
  const fallbackReasons: Record<string, number> = {};

  try {
    for (const spec of fixture.cases) {
      for (let round = 1; round <= rounds; round += 1) {
        for (const arm of ['baseline', 'jev'] as const) {
          const started = Date.now();
          const context = makeContext();
          context.turnId = `${spec.id}-${arm}-${round}`;
          let trial: TrialRow;
          try {
            await browserService.close().catch(() => undefined);
            await launchBrowser();
            await browserActionTool.execute({ action: 'navigate', url: `${originServer.origin}${spec.path}` }, context);
            if (arm === 'baseline') {
              const result = await runBaseline(spec, originServer.origin, context, 20);
              const evidence = await pageEvidence();
              const evaluated = evaluateJevAssertions(spec.assertions.length ? spec.assertions : extractJevAssertions(spec.task), evidence);
              const audit = await readAudit();
              trial = trialRowFromRun({
                spec,
                arm,
                round,
                wallSec: (Date.now() - started) / 1000,
                steps: result.steps,
                usd: result.usd,
                status: result.status,
                jevCalls: 0,
                fallbacks: 0,
                pureJev: false,
                evidenceMet: evaluated.allMet,
                audit,
                jevInnerSteps: 0,
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
              });
            } else {
              const result = await runJevArm(spec, originServer.origin, context, mutate);
              const evidence = await pageEvidence();
              const evaluated = evaluateJevAssertions(spec.assertions.length ? spec.assertions : extractJevAssertions(spec.task), evidence);
              const audit = await readAudit();
              if (result.fallbackReason) {
                fallbackReasons[result.fallbackReason] = (fallbackReasons[result.fallbackReason] || 0) + 1;
              }
              trial = trialRowFromRun({
                spec,
                arm,
                round,
                wallSec: (Date.now() - started) / 1000,
                steps: result.steps,
                usd: result.usd,
                status: result.status,
                jevCalls: result.jevCalls,
                fallbacks: result.fallbacks,
                pureJev: result.pureJev,
                evidenceMet: evaluated.allMet,
                audit,
                fallbackReason: result.fallbackReason,
                jevInnerSteps: result.jevInnerSteps,
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
              });
            }
          } catch (error) {
            trial = trialRowFromRun({
              spec,
              arm,
              round,
              wallSec: (Date.now() - started) / 1000,
              steps: 0,
              usd: 0,
              status: 'error',
              jevCalls: 0,
              fallbacks: 0,
              pureJev: false,
              evidenceMet: false,
              audit: {},
              fallbackReason: error instanceof Error ? error.message : String(error),
              jevInnerSteps: 0,
              tokensIn: 0,
              tokensOut: 0,
            });
          }
          rows.push(trial);
          console.error(`${spec.id} ${arm} r${round} status=${trial.status} ok=${trial.ok} steps=${trial.steps}`);
        }
      }
    }
  } finally {
    await browserService.close().catch(() => undefined);
    await closeJevBrowserStepFixtureServer(originServer.server);
  }

  const summarize = (arm: 'baseline' | 'jev') => {
    const mine = rows.filter((row) => row.arm === arm);
    const n = mine.length || 1;
    return {
      arm,
      avgSteps: mine.reduce((sum, row) => sum + row.steps, 0) / n,
      avgWallSec: mine.reduce((sum, row) => sum + row.wallSec, 0) / n,
      successRate: mine.filter((row) => row.ok).length / n,
      avgUsd: mine.reduce((sum, row) => sum + row.usd, 0) / n,
    };
  };
  const baseline = summarize('baseline');
  const jev = summarize('jev');
  const pureJev = rows.filter((row) => row.arm === 'jev').length
    ? rows.filter((row) => row.arm === 'jev' && row.pureJev).length / rows.filter((row) => row.arm === 'jev').length
    : 0;
  const sensitiveAny = rows.some((row) => row.sensitiveUnauthed);
  const veto = jev.successRate < baseline.successRate || sensitiveAny;
  const report = {
    generatedAt: new Date().toISOString(),
    mutate: mutate || null,
    stepCount: STEP_COUNT_RULE,
    rows,
    headline: { baseline, jev },
    pureJev,
    fallbackReasons,
    sensitiveUnauthed: sensitiveAny,
    verdict: veto ? '不接电，只留报告' : '可接电候选',
  };
  try {
    assertTrialRowsConsistent(rows);
  } catch (error) {
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  const byCase = fixture.cases.map((spec) => {
    const cells = (['baseline', 'jev'] as const).map((arm) => {
      const mine = rows.filter((row) => row.id === spec.id && row.arm === arm);
      const fmt = (row?: TrialRow) => row ? `${row.steps}/${row.wallSec.toFixed(1)}/${row.usd.toFixed(4)}/${row.ok ? 'ok' : 'no'}` : '-';
      return `| ${spec.id} | ${arm} | ${fmt(mine[0])} | ${fmt(mine[1])} | ${fmt(mine[2])} | ${(mine.reduce((s, r) => s + r.steps, 0) / (mine.length || 1)).toFixed(1)} | ${(mine.reduce((s, r) => s + r.wallSec, 0) / (mine.length || 1)).toFixed(1)} | ${(mine.filter((r) => r.ok).length / (mine.length || 1)).toFixed(2)} | ${(mine.reduce((s, r) => s + r.usd, 0) / (mine.length || 1)).toFixed(4)} | ${mine.some((r) => r.sensitiveUnauthed) ? 'Y' : 'n'} | ${mine.reduce((s, r) => s + r.fallbacks, 0)} |`;
    });
    return cells.join('\n');
  }).join('\n');
  const markdown = `## 验收③ browser-step-benchmark
口径：执行模型选中的动作才计一步（快照不计）。jev 内环每执行一步算一步，微回落 scroll 算一步。
| id | arm | r1步/秒/$/ok | r2 | r3 | 平均步数 | 平均墙钟s | 成功率 | 平均$/题 | 敏感未批 | 交回次数 |
|---|---|---|---|---|---|---|---|---|---|---|
${byCase}

| arm | 平均步数 | 平均墙钟 s | 成功率 | 平均 $/题 |
|---|---|---|---|---|
| baseline | ${baseline.avgSteps.toFixed(2)} | ${baseline.avgWallSec.toFixed(2)} | ${baseline.successRate.toFixed(3)} | ${baseline.avgUsd.toFixed(4)} |
| jev | ${jev.avgSteps.toFixed(2)} | ${jev.avgWallSec.toFixed(2)} | ${jev.successRate.toFixed(3)} | ${jev.avgUsd.toFixed(4)} |

pure_jev=${pureJev.toFixed(3)} fallbackReasons=${JSON.stringify(fallbackReasons)}
否决判定：${report.verdict}
json=${outJson}
`;
  console.log(markdown);
  if (hasFlag(args, 'json')) printJsonAlreadyWritten();
}

function printJsonAlreadyWritten(): void {
  // JSON already written to OUT_JSON; stdout keeps the markdown table for the evidence file.
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
