#!/usr/bin/env npx tsx
// ============================================================================
// eval-ci.ts — CLI entry point for Eval-Driven Development
// ============================================================================
//
// Usage:
//   npx tsx scripts/eval-ci.ts                    # auto-detect scope
//   npx tsx scripts/eval-ci.ts --scope smoke      # smoke tests only
//   npx tsx scripts/eval-ci.ts --scope full       # full suite
//   npx tsx scripts/eval-ci.ts --real              # use real model execution
//   npx tsx scripts/eval-ci.ts --real --model gpt-4o  # real mode with specific model
//   npx tsx scripts/eval-ci.ts --promote          # promote to baseline
//   npx tsx scripts/eval-ci.ts --baseline-info    # show baseline
//   npx tsx scripts/eval-ci.ts --trend            # show trend

import chalk from 'chalk';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ChangeDetector } from '../src/host/testing/ci/changeDetector';
import { BaselineManager } from '../src/host/testing/ci/baselineManager';
import { TrendTracker } from '../src/host/testing/ci/trendTracker';
import { generateDeltaConsole } from '../src/host/testing/ci/deltaReporter';
import {
  TestRunner,
  createDefaultConfig,
  MockAgentAdapter,
  StandaloneAgentAdapter,
  loadAllTestSuites,
  filterTestCases,
  generateConsoleReport,
  saveReport,
} from '../src/host/testing/index';
import type { AgentInterface } from '../src/host/testing/testRunner';
import type { TestRunSummary, TrendDataPoint } from '../src/host/testing/types';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../src/shared/constants';
import { isProviderVariantDisabled } from '../src/host/prompts/providerVariants';

/** roadmap 2.4 A/B 归因（audit D-R3）：当前 run 的 provider 变体臂 */
function providerVariantArm(): 'variant-on' | 'variant-off' {
  return isProviderVariantDisabled() ? 'variant-off' : 'variant-on';
}

const PROVIDER_KEY_CANDIDATES: Record<string, string[]> = {
  moonshot: ['KIMI_K25_API_KEY', 'MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CASES = 50;

/** Rough cost per case by model prefix (USD). Fallback: $0.01 */
function estimateCostPerCase(modelName: string): number {
  const m = modelName.toLowerCase();
  if (m.includes('gpt-4o-mini') || m.includes('gpt-4o mini')) return 0.002;
  if (m.includes('gpt-4o')) return 0.008;
  if (m.includes('gpt-4-turbo') || m.includes('gpt-4 turbo')) return 0.015;
  if (m.includes('gpt-4')) return 0.04;
  if (m.includes('gpt-3.5')) return 0.001;
  if (m.includes('claude-3-opus') || m.includes('claude-opus')) return 0.04;
  if (m.includes('claude-3-sonnet') || m.includes('claude-sonnet')) return 0.008;
  if (m.includes('claude-3-haiku') || m.includes('claude-haiku')) return 0.002;
  if (m.includes('deepseek')) return 0.002;
  if (m.includes('gemini-pro')) return 0.005;
  if (m.includes('gemini')) return 0.003;
  return 0.01; // conservative default
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let scope: 'smoke' | 'full' | undefined;
  let promote = false;
  let baselineInfo = false;
  let trend = false;
  let base: string | undefined;
  let real = false;
  let model: string | undefined;
  let provider: string | undefined;
  let concurrency: number | undefined;
  let maxCases: number = DEFAULT_MAX_CASES;
  let force = false;
  let tags: string[] | undefined;
  let ids: string[] | undefined;
  let compare: string | undefined;
  let judge: 'rules' | 'llm' = 'rules';
  let predictedFixes: string[] | undefined;
  let riskTasks: string[] | undefined;
  let caseDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scope' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'smoke' || val === 'full') {
        scope = val;
      } else {
        console.error(chalk.red(`Invalid scope: ${val}. Use 'smoke' or 'full'.`));
        process.exit(1);
      }
    } else if (arg === '--promote') {
      promote = true;
    } else if (arg === '--baseline-info') {
      baselineInfo = true;
    } else if (arg === '--trend') {
      trend = true;
    } else if (arg === '--base' && i + 1 < args.length) {
      base = args[++i];
    } else if (arg === '--real') {
      real = true;
    } else if (arg === '--model' && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === '--provider' && i + 1 < args.length) {
      provider = args[++i];
    } else if (arg === '--concurrency' && i + 1 < args.length) {
      concurrency = parseInt(args[++i], 10);
    } else if (arg === '--max-cases' && i + 1 < args.length) {
      maxCases = parseInt(args[++i], 10);
    } else if (arg === '--tags' && i + 1 < args.length) {
      tags = args[++i].split(',').map((tag) => tag.trim()).filter(Boolean);
    } else if (arg === '--ids' && i + 1 < args.length) {
      ids = args[++i].split(',').map((id) => id.trim()).filter(Boolean);
    } else if (arg === '--compare' && i + 1 < args.length) {
      compare = args[++i];
    } else if (arg === '--case-dir' && i + 1 < args.length) {
      caseDir = args[++i];
    } else if (arg === '--predicted-fixes' && i + 1 < args.length) {
      predictedFixes = args[++i].split(',').map((id) => id.trim()).filter(Boolean);
    } else if (arg === '--risk-tasks' && i + 1 < args.length) {
      riskTasks = args[++i].split(',').map((id) => id.trim()).filter(Boolean);
    } else if (arg === '--judge' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'rules' || val === 'llm') {
        judge = val;
      } else {
        console.error(chalk.red(`Invalid judge: ${val}. Use 'rules' or 'llm'.`));
        process.exit(1);
      }
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  // Validate --concurrency: must be a positive integer
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency <= 0)) {
    console.error(chalk.red(`Invalid --concurrency value: must be a positive integer.`));
    process.exit(1);
  }

  // Validate --max-cases: must be a positive integer
  if (!Number.isInteger(maxCases) || maxCases <= 0) {
    console.error(chalk.red(`Invalid --max-cases value: must be a positive integer.`));
    process.exit(1);
  }

  return { scope, promote, baselineInfo, trend, base, real, model, provider, concurrency, maxCases, force, tags, ids, compare, judge, predictedFixes, riskTasks, caseDir };
}

function printUsage() {
  console.log(`
${chalk.bold('eval-ci')} — Eval-Driven Development CLI

${chalk.dim('Usage:')}
  npx tsx scripts/eval-ci.ts                    Auto-detect scope from git diff
  npx tsx scripts/eval-ci.ts --scope smoke      Smoke tests only
  npx tsx scripts/eval-ci.ts --scope full       Full eval suite
  npx tsx scripts/eval-ci.ts --real             Use real model execution (default: mock)
  npx tsx scripts/eval-ci.ts --model <name>     Model name (implies --real)
  npx tsx scripts/eval-ci.ts --provider <name>  Model provider (default: from constants)
  npx tsx scripts/eval-ci.ts --concurrency <n>  Parallel test execution count
  npx tsx scripts/eval-ci.ts --max-cases <n>    Max cases in --real mode (default: 50)
  npx tsx scripts/eval-ci.ts --tags <a,b>       Filter test cases by tags
  npx tsx scripts/eval-ci.ts --ids <a,b>        Filter test cases by IDs
  npx tsx scripts/eval-ci.ts --force             Bypass --max-cases limit
  npx tsx scripts/eval-ci.ts --compare <yaml>   A/B paired blind test: baseline vs candidate config (requires --real)
  npx tsx scripts/eval-ci.ts --judge <mode>     Grading for --compare: 'rules' (default, free) or 'llm'
  npx tsx scripts/eval-ci.ts --predicted-fixes <a,b>  Register case ids this change should fix (delta report reconciles)
  npx tsx scripts/eval-ci.ts --risk-tasks <a,b>       Register case ids this change might break
  npx tsx scripts/eval-ci.ts --case-dir <dir>   External test-case dir (e.g. GAIA)；跳过 baseline 对账与 trend
  npx tsx scripts/eval-ci.ts --promote          Promote current results to baseline
  npx tsx scripts/eval-ci.ts --baseline-info    Show current baseline
  npx tsx scripts/eval-ci.ts --trend            Show trend chart
  npx tsx scripts/eval-ci.ts --base <ref>       Git ref to diff against (default: HEAD)
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showBaselineInfo(manager: BaselineManager) {
  const baseline = await manager.load();
  if (!baseline) {
    console.log(chalk.yellow('  No baseline found. Run evals and use --promote to create one.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  Eval Baseline'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log(`  Updated:     ${new Date(baseline.updatedAt).toISOString()}`);
  console.log(`  Commit:      ${baseline.updatedBy}`);
  const baselineMode = baseline.mode ?? 'unknown';
  const modeLabel = baselineMode === 'real'
    ? chalk.green('real')
    : chalk.red(`${baselineMode} ⚠️ 非真实运行，数字不可信，请用 --real --promote 重建`);
  console.log(`  Mode:        ${modeLabel}`);
  console.log(`  Pass Rate:   ${(baseline.globalMetrics.passRate * 100).toFixed(1)}%`);
  console.log(`  Avg Score:   ${(baseline.globalMetrics.averageScore * 100).toFixed(1)}%`);
  console.log(`  Total Cases: ${baseline.globalMetrics.totalCases}`);
  console.log('');
  console.log(chalk.dim('  Thresholds:'));
  console.log(`    Min Pass Rate:    ${(baseline.thresholds.minPassRate * 100).toFixed(0)}%`);
  console.log(`    Max Score Drop:   ${(baseline.thresholds.maxScoreDrop * 100).toFixed(0)}%`);
  console.log(`    Max New Failures: ${baseline.thresholds.maxNewFailures}`);
  console.log('');

  const caseCount = Object.keys(baseline.caseResults).length;
  if (caseCount > 0) {
    const statuses: Record<string, number> = {};
    for (const c of Object.values(baseline.caseResults)) {
      statuses[c.status] = (statuses[c.status] || 0) + 1;
    }
    console.log(chalk.dim('  Case breakdown:'));
    for (const [status, count] of Object.entries(statuses)) {
      console.log(`    ${status}: ${count}`);
    }
    console.log('');
  }
}

async function showTrend(tracker: TrendTracker) {
  const recent = await tracker.getRecent(20);
  if (recent.length === 0) {
    console.log(chalk.yellow('  No trend data yet. Run evals to start tracking.'));
    return;
  }
  console.log('');
  console.log(tracker.generateAsciiChart(recent));
  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCommitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getRepoStatusSnapshot(repoDir: string): string[] | null {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoDir, stdio: 'ignore' });
    const output = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: repoDir,
      encoding: 'utf8',
    });
    return output.split('\n').filter(Boolean).sort();
  } catch {
    return null;
  }
}

function diffStatusSnapshot(before: string[] | null, after: string[] | null): string[] {
  if (!before || !after) return [];
  const beforeSet = new Set(before);
  return after.filter((line) => !beforeSet.has(line));
}

function assertRepoUnchanged(repoDir: string, before: string[] | null): void {
  const after = getRepoStatusSnapshot(repoDir);
  const added = diffStatusSnapshot(before, after);
  if (added.length === 0) return;

  const shown = added.slice(0, 20).join('\n    ');
  const more = added.length > 20 ? `\n    ... and ${added.length - 20} more` : '';
  throw new Error(
    `Eval modified the source worktree. This is blocked because real evals must write only inside the sandbox.\n` +
    `New/changed status entries:\n    ${shown}${more}`
  );
}

function readEnvValue(filePath: string, name: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`^${name}=["']?([^"'\\s\\n]+)["']?`, 'm'));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function loadApiKey(provider: string, workingDir: string): string | undefined {
  const candidates = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];
  const envFiles = [
    path.join(workingDir, '.env'),
    path.join(os.homedir(), '.code-agent', '.env'),
  ];

  for (const name of candidates) {
    if (process.env[name]) return process.env[name];
    for (const envFile of envFiles) {
      const value = readEnvValue(envFile, name);
      if (value) return value;
    }
  }

  return undefined;
}

/**
 * 隔离沙箱：把仓库 tracked 文件（git archive HEAD，不含 .git/node_modules/未跟踪产物）
 * 快照到临时目录，作为 agent 执行的 working directory。
 *
 * Why: eval 跑在真实工作树上会弄脏 repo —— git 类 case 的 agent 命令可能在仓库根
 * `git checkout -b` 切走主仓 HEAD，ppt/codegen/excel case 留 test-*.pptx / build_final.py
 * 等产物，killed run 还来不及 cleanup 就残留。沙箱里没有 .git（archive 排除），根目录
 * 的 git 操作只会无害报错而非污染主仓；产物全落临时目录，跑完整体删除。
 *
 * 注意：仅 agent 的 working directory 走沙箱；test-cases / results / baseline / trend
 * 仍读写真实仓库（这些是 eval 基础设施，不能随沙箱删除而丢失）。
 *
 * 关闭沙箱：CODE_AGENT_EVAL_NO_SANDBOX=true（调试时原地跑）。
 */
function createEvalSandbox(repoDir: string): { dir: string; cleanup: () => void } | null {
  if (process.env.CODE_AGENT_EVAL_NO_SANDBOX === 'true') {
    console.log(chalk.dim('  Eval sandbox 关闭 (CODE_AGENT_EVAL_NO_SANDBOX=true)，在真实工作树跑'));
    return null;
  }
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoDir, stdio: 'ignore' });
  } catch {
    console.log(chalk.yellow('  非 git 仓库，跳过 eval sandbox（在工作树原地跑）'));
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-eval-'));
  try {
    // git archive 输出 tar 到 stdout，解到沙箱目录；shell 管道由 execSync 默认 /bin/sh 执行
    execSync(`git archive HEAD | tar -x -C "${dir}"`, { cwd: repoDir, stdio: 'ignore' });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(chalk.yellow(`  git archive 快照失败，跳过 eval sandbox（在工作树原地跑）: ${err}`));
    return null;
  }
  // 真仓根 → 沙箱的路径重映射（pathUtils.confineEvalPath 消费）：
  // eval 全自动批准 permission 时，agent 的 deny-writes-outside-cwd 防线失效，
  // mimo 可能用真仓绝对路径写文件绕过沙箱。设此 env 让真仓绝对路径落回沙箱。
  process.env.CODE_AGENT_EVAL_REAL_ROOT = path.resolve(repoDir);
  console.log(chalk.cyan(`  Eval sandbox: ${dir}（git archive HEAD 快照，跑完自动清理）`));
  return {
    dir,
    cleanup: () => {
      delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响 eval 结果 */
      }
    },
  };
}

/**
 * Create the appropriate agent adapter based on --real flag
 */
function createAgent(opts: {
  real: boolean;
  model?: string;
  provider?: string;
  workingDir: string;
  repoDir: string;
}): AgentInterface {
  if (!opts.real) {
    const mockAgent = new MockAgentAdapter();
    mockAgent.setMockResponse('列出当前目录', {
      responses: ['当前目录包含以下文件：package.json, src/, ...'],
      toolExecutions: [
        {
          tool: 'bash',
          input: { command: 'ls' },
          output: 'package.json\nsrc\nnode_modules\n',
          success: true,
          duration: 50,
          timestamp: Date.now(),
        },
      ],
    });
    return mockAgent;
  }

  // Real mode: use StandaloneAgentAdapter
  const resolvedProvider = opts.provider
    || process.env.AUTO_TEST_PROVIDER
    || DEFAULT_PROVIDER;
  const resolvedModel = opts.model
    || process.env.AUTO_TEST_MODEL
    || DEFAULT_MODEL;
  console.log(chalk.cyan(`  Mode:     real`));
  console.log(chalk.cyan(`  Provider: ${resolvedProvider}`));
  console.log(chalk.cyan(`  Model:    ${resolvedModel}`));
  console.log('');

  const apiKey = process.env.AUTO_TEST_API_KEY || loadApiKey(resolvedProvider, opts.repoDir);
  if (!apiKey) {
    const candidates = PROVIDER_KEY_CANDIDATES[resolvedProvider] || [`${resolvedProvider.toUpperCase()}_API_KEY`];
    throw new Error(`No API key found for ${resolvedProvider}. Set AUTO_TEST_API_KEY or ${candidates.join(' / ')}.`);
  }

  return new StandaloneAgentAdapter({
    workingDirectory: opts.workingDir,
    modelConfig: {
      provider: resolvedProvider,
      model: resolvedModel,
      apiKey,
    },
  });
}

async function prepareRealEvalRuntime(): Promise<void> {
  process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS ||= '12000';
  process.env.CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS ||= 'false';
  process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';

  const { getProtocolRegistry } = await import('../src/host/tools/protocolRegistry');
  getProtocolRegistry();

  try {
    const { getDatabase } = await import('../src/host/services/core/databaseService');
    const db = getDatabase();
    if (!db.isReady) {
      await db.initialize();
    }
  } catch (error) {
    console.log(chalk.yellow(`  Warning: eval DB initialization skipped: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function runEvals(
  workingDir: string,
  _scope: 'smoke' | 'full',
  opts: {
    real: boolean;
    model?: string;
    provider?: string;
    concurrency?: number;
    tags?: string[];
    ids?: string[];
    prediction?: { predictedFixes: string[]; riskTasks: string[] };
    caseDir?: string;
  }
): Promise<TestRunSummary> {
  // \u9694\u79BB\u6C99\u7BB1\uFF1Aagent \u7684 working directory \u8D70\u4E34\u65F6\u5FEB\u7167\uFF1Btest-cases / results \u4ECD\u8BFB\u5199\u771F\u5B9E\u4ED3\u5E93\u3002
  const repoStatusBefore = getRepoStatusSnapshot(workingDir);
  const sandbox = createEvalSandbox(workingDir);
  const agentWorkingDir = sandbox?.dir ?? workingDir;
  try {
    if (opts.real) {
      await prepareRealEvalRuntime();
    }

    const config = createDefaultConfig(workingDir, {
      verbose: false,
      workingDirectory: agentWorkingDir,
      filterTags: opts.tags,
      filterIds: opts.ids,
      ...(opts.concurrency ? { maxParallel: opts.concurrency, parallel: true } : {}),
      // WP1-4: 预测登记随 summary 落盘/DB，deltaReporter 对账
      ...(opts.prediction ? { prediction: opts.prediction } : {}),
      // 外部基准（如 GAIA）用独立 case 目录
      ...(opts.caseDir ? { testCaseDir: opts.caseDir } : {}),
    });

    const agent = createAgent({
      real: opts.real,
      model: opts.model,
      provider: opts.provider,
      workingDir: agentWorkingDir,
      repoDir: workingDir,
    });

    const runner = new TestRunner(config, agent);

    runner.addEventListener((event) => {
      switch (event.type) {
        case 'case_end': {
          const icon =
            event.result.status === 'passed'
              ? '\u2705'
              : event.result.status === 'failed'
              ? '\u274C'
              : event.result.status === 'infra_excluded'
              ? '\u{1F50C}'
              : '\u23ED\uFE0F';
          console.log(
            `  ${icon} ${event.result.testId.padEnd(30)} ${event.result.duration}ms`
          );
          break;
        }
        case 'suite_end':
          console.log(generateConsoleReport(event.summary));
          break;
      }
    });

    const summary = await runner.runAll();

    const savedFiles = await saveReport(summary, config.resultsDir);
    console.log(chalk.dim(`  Reports saved to: ${savedFiles[0]}`));

    if (sandbox) {
      assertRepoUnchanged(workingDir, repoStatusBefore);
    }

    return summary;
  } finally {
    sandbox?.cleanup();
  }
}

/**
 * WP1-3：--compare 成对盲测。baseline = 当前默认配置，candidate 来自 YAML
 * （可覆盖 model/provider/systemPrompt）。每 case 两配置各真跑一次，
 * ABComparator 盲分配 A/B + 评分 + unblind。paired 对比的统计功效远高于
 * 两轮整体总分对比。
 */
async function runCompareCommand(
  workingDir: string,
  candidatePath: string,
  opts: {
    model?: string;
    provider?: string;
    tags?: string[];
    ids?: string[];
    maxCases: number;
    force: boolean;
    judge: 'rules' | 'llm';
  },
): Promise<void> {
  const { loadCompareConfig, runCompare, generateComparisonConsole, generateComparisonMarkdown } =
    await import('../src/host/testing/comparator');

  const candidate = await loadCompareConfig(candidatePath);
  const resolvedProvider = opts.provider || process.env.AUTO_TEST_PROVIDER || DEFAULT_PROVIDER;
  const resolvedModel = opts.model || process.env.AUTO_TEST_MODEL || DEFAULT_MODEL;
  const baseline = {
    name: 'baseline',
    model: resolvedModel,
    provider: resolvedProvider,
  };

  // Load & filter cases
  const defaultConfig = createDefaultConfig(workingDir);
  const suites = await loadAllTestSuites(defaultConfig.testCaseDir);
  const testCases = filterTestCases(suites, { filterTags: opts.tags, filterIds: opts.ids });
  const totalCases = testCases.length;

  // Cost guard：每 case 跑两次（baseline + candidate）
  const costPerCase = estimateCostPerCase(resolvedModel);
  const casesToRun = Math.min(totalCases, opts.maxCases);
  const estimatedCost = (casesToRun * costPerCase * 2).toFixed(2);
  console.log(chalk.yellow(
    `  ⚠️  Compare mode: up to ${casesToRun} cases × 2 configs with ${resolvedModel} via ${resolvedProvider}. ` +
    `Estimated cost: ~$${estimatedCost}. Use --max-cases to limit.`
  ));
  console.log('');
  if (totalCases > opts.maxCases && !opts.force) {
    console.error(chalk.red(
      `  Error: ${totalCases} test cases exceed --max-cases limit (${opts.maxCases}). ` +
      `Use --force to override or --max-cases <n> to raise the limit.`
    ));
    process.exit(1);
  }

  const repoStatusBefore = getRepoStatusSnapshot(workingDir);
  const sandbox = createEvalSandbox(workingDir);
  const agentWorkingDir = sandbox?.dir ?? workingDir;
  try {
    await prepareRealEvalRuntime();

    const runnerConfig = createDefaultConfig(workingDir, {
      verbose: false,
      workingDirectory: agentWorkingDir,
    });

    const makeAgent = (config: { name: string; model?: string; provider?: string; systemPrompt?: string }) => {
      const provider = config.provider || resolvedProvider;
      const model = config.model || resolvedModel;
      const apiKey = process.env.AUTO_TEST_API_KEY || loadApiKey(provider, workingDir);
      if (!apiKey) {
        const candidates = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];
        throw new Error(`No API key found for ${provider}. Set AUTO_TEST_API_KEY or ${candidates.join(' / ')}.`);
      }
      return new StandaloneAgentAdapter({
        workingDirectory: agentWorkingDir,
        modelConfig: { provider, model, apiKey },
        ...(config.systemPrompt ? { systemPromptOverride: config.systemPrompt } : {}),
      });
    };

    // LLM 评审可选（有额外 API 成本）；默认 heuristic 规则免费。
    // 评审来源即 scoreAuthority 语义：llm → llm_judge，rules → self_check 级弱证据。
    let llmCall: ((prompt: string) => Promise<string>) | undefined;
    if (opts.judge === 'llm') {
      const { quickTask } = await import('../src/host/model/quickModel');
      llmCall = async (prompt: string) => {
        const res = await quickTask(prompt, 2048);
        if (!res.success || !res.content) {
          throw new Error(`LLM judge failed: ${res.error ?? 'empty response'}`);
        }
        return res.content;
      };
    }

    console.log(chalk.cyan(`  Baseline:  ${baseline.name} (${baseline.model} via ${baseline.provider})`));
    console.log(chalk.cyan(`  Candidate: ${candidate.name} (${candidate.model ?? baseline.model} via ${candidate.provider ?? baseline.provider}${candidate.systemPrompt ? ', custom systemPrompt' : ''})`));
    console.log(chalk.cyan(`  Judge:     ${opts.judge}`));
    console.log('');

    const result = await runCompare({
      testCases: testCases.slice(0, casesToRun),
      baseline,
      candidate,
      makeAgent,
      runnerConfig,
      llmCall,
    });

    console.log(generateComparisonConsole(result));

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const reportPath = path.join(defaultConfig.resultsDir, `compare-${timestamp}.md`);
    await fs.promises.mkdir(defaultConfig.resultsDir, { recursive: true });
    await fs.promises.writeFile(reportPath, generateComparisonMarkdown(result));
    console.log(chalk.dim(`  Comparison report saved to: ${reportPath}`));
    console.log('');

    if (sandbox) {
      assertRepoUnchanged(workingDir, repoStatusBefore);
    }
  } finally {
    sandbox?.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { scope, promote, baselineInfo, trend, base, real, model, provider, concurrency, maxCases, force, tags, ids, compare, judge, predictedFixes, riskTasks } = parseArgs(process.argv);
  // WP1-4：任一预测 flag 出现即登记（另一侧默认空列表）
  const prediction = (predictedFixes || riskTasks)
    ? { predictedFixes: predictedFixes ?? [], riskTasks: riskTasks ?? [] }
    : undefined;

  // --model implies --real
  const effectiveReal = real || !!model;

  const workingDir = process.cwd();
  const manager = new BaselineManager(workingDir);
  const tracker = new TrendTracker(workingDir);

  // --compare: A/B paired blind test (WP1-3)
  if (compare) {
    // mock adapter 两侧输出恒等，对比无意义；成对盲测必须真模型
    if (!effectiveReal) {
      console.error(chalk.red('  Error: --compare 需要 --real（或 --model <name>）。mock 两侧输出恒等，对比无意义。'));
      process.exit(1);
    }
    await runCompareCommand(workingDir, compare, { model, provider, tags, ids, maxCases, force, judge });
    return;
  }

  // --baseline-info
  if (baselineInfo) {
    await showBaselineInfo(manager);
    return;
  }

  // --trend
  if (trend) {
    await showTrend(tracker);
    return;
  }

  // --promote: run evals then promote results to baseline
  if (promote) {
    // 来源护栏：mock 跑出的通过率是 adapter 桩的产物，禁止晋升为基线。
    // 在跑 eval 前就拦下，避免白跑（且 mock 跑也没有晋升价值）。
    if (!effectiveReal) {
      console.error(chalk.red(
        '  Error: 拒绝晋升 mock 运行为 baseline。基线必须来自真实模型执行，' +
        '请加 --real（或 --model <name>）。'
      ));
      process.exit(1);
    }

    // --real mode safety guards for promote
    if (effectiveReal) {
      const testCaseDir_ = createDefaultConfig(workingDir).testCaseDir;
      const suites = await loadAllTestSuites(testCaseDir_);
      const totalCases = filterTestCases(suites, { filterTags: tags, filterIds: ids }).length;
      const resolvedModel = model || process.env.AUTO_TEST_MODEL || DEFAULT_MODEL;
      const resolvedProvider = provider || process.env.AUTO_TEST_PROVIDER || DEFAULT_PROVIDER;
      const costPerCase = estimateCostPerCase(resolvedModel);
      const casesToRun = Math.min(totalCases, maxCases);
      const estimatedCost = (casesToRun * costPerCase).toFixed(2);

      console.log(chalk.yellow(
        `  ⚠️  Real mode: will execute up to ${casesToRun} cases with ${resolvedModel} via ${resolvedProvider}. ` +
        `Estimated cost: ~$${estimatedCost} (based on avg 5K tokens/case). Use --max-cases to limit.`
      ));
      console.log('');

      if (totalCases > maxCases && !force) {
        console.error(chalk.red(
          `  Error: ${totalCases} test cases exceed --max-cases limit (${maxCases}). ` +
          `Use --force to override or --max-cases <n> to raise the limit.`
        ));
        process.exit(1);
      }
    }

    console.log(chalk.bold('  Running evals before promoting to baseline...'));
    console.log('');
    const summary = await runEvals(workingDir, 'full', { real: effectiveReal, model, provider, concurrency, tags, ids });
    const commitSha = getCommitSha();
    await manager.promote(summary, commitSha, 'real');
    console.log(chalk.green(`  Baseline promoted (commit: ${commitSha.slice(0, 7)})`));
    console.log(`  Pass rate: ${(summary.total > 0 ? (summary.passed / summary.total) * 100 : 0).toFixed(1)}%`);
    console.log(`  Avg score: ${(summary.averageScore * 100).toFixed(1)}%`);
    console.log('');
    return;
  }

  // Change detection
  const detector = new ChangeDetector();
  const detection = await detector.detectTriggeringChanges(base);

  const effectiveScope = scope ?? detection.scope;

  console.log('');
  console.log(chalk.bold('  Eval-Driven Development'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log(`  Scope:        ${chalk.cyan(effectiveScope)}`);
  console.log(`  Mode:         ${effectiveReal ? chalk.yellow('real') : chalk.dim('mock')}`);
  console.log(`  Variant arm:  ${chalk.cyan(providerVariantArm())} (CODE_AGENT_DISABLE_PROVIDER_VARIANT=${process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT ?? 'unset'})`);
  console.log(`  Should run:   ${detection.shouldRunEval ? chalk.green('yes') : chalk.dim('no')}`);
  console.log(`  Trigger:      ${detection.triggerReason}`);

  if (detection.changedFiles.length > 0) {
    console.log(`  Changed files: ${detection.changedFiles.length}`);
    for (const f of detection.changedFiles.slice(0, 10)) {
      console.log(chalk.dim(`    • ${f}`));
    }
    if (detection.changedFiles.length > 10) {
      console.log(chalk.dim(`    ... and ${detection.changedFiles.length - 10} more`));
    }
  }
  if (tags?.length) {
    console.log(`  Tags:        ${tags.join(', ')}`);
  }
  if (ids?.length) {
    console.log(`  IDs:          ${ids.join(', ')}`);
  }
  console.log('');

  if (!detection.shouldRunEval && !scope) {
    console.log(chalk.dim('  No eval-triggering changes detected. Skipping.'));
    console.log(chalk.dim('  Use --scope smoke|full to force a run.'));
    return;
  }

  // --real mode safety guards
  if (effectiveReal) {
    // Load suites to count total cases
    const testCaseDir_ = caseDir ?? createDefaultConfig(workingDir).testCaseDir;
    const suites = await loadAllTestSuites(testCaseDir_);
    const totalCases = filterTestCases(suites, { filterTags: tags, filterIds: ids }).length;
    const resolvedModel = model || process.env.AUTO_TEST_MODEL || DEFAULT_MODEL;
    const resolvedProvider = provider || process.env.AUTO_TEST_PROVIDER || DEFAULT_PROVIDER;
    const costPerCase = estimateCostPerCase(resolvedModel);
    const casesToRun = Math.min(totalCases, maxCases);
    const estimatedCost = (casesToRun * costPerCase).toFixed(2);

    console.log(chalk.yellow(
      `  ⚠️  Real mode: will execute up to ${casesToRun} cases with ${resolvedModel} via ${resolvedProvider}. ` +
      `Estimated cost: ~$${estimatedCost} (based on avg 5K tokens/case). Use --max-cases to limit.`
    ));
    console.log('');

    if (totalCases > maxCases && !force) {
      console.error(chalk.red(
        `  Error: ${totalCases} test cases exceed --max-cases limit (${maxCases}). ` +
        `Use --force to override or --max-cases <n> to raise the limit.`
      ));
      process.exit(1);
    }
  }

  // Run evals
  console.log(chalk.cyan(`  Running ${effectiveScope} eval suite...`));
  console.log('');
  const summary = await runEvals(workingDir, effectiveScope, { real: effectiveReal, model, provider, concurrency, tags, ids, prediction, caseDir });

  // Real 模式：打印本进程实际 token 消耗与成本（budgetService 进程内累计，
  // 含 Max Mode 的 overhead 记账）—— roadmap 3.3 开关对照需要"成本比"数据
  if (effectiveReal) {
    const { getBudgetService } = await import('../src/host/services');
    const usage = getBudgetService().getUsageHistory();
    const totalIn = usage.reduce((s, u) => s + u.inputTokens, 0);
    const totalOut = usage.reduce((s, u) => s + u.outputTokens, 0);
    console.log(chalk.cyan(
      `  Actual usage: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens, ` +
      `cost $${getBudgetService().getCurrentCost().toFixed(4)} (maxMode=${process.env.CODE_AGENT_MAX_MODE === '1' ? 'on' : 'off'})`
    ));
  }

  // 外部基准（--case-dir）不与自建集 baseline 对账、不进 trend——
  // 语义不同（外部锚点 vs 内部回归），混进来会把 45 子集基线搅成噪声。
  if (caseDir) {
    const capabilityTotal = summary.total - (summary.infraExcluded ?? 0) - summary.skipped;
    const passRate = capabilityTotal > 0 ? summary.passed / capabilityTotal : 0;
    console.log(chalk.bold(`  External benchmark run (${caseDir})`));
    console.log(`  Accuracy: ${chalk.cyan((passRate * 100).toFixed(1) + '%')} (${summary.passed}/${capabilityTotal}${summary.infraExcluded ? `, 🔌 ${summary.infraExcluded} infra-excluded` : ''})`);
    console.log(chalk.dim('  跳过 baseline 对账与 trend（外部锚点不进内部回归基线）'));
    console.log('');
    return;
  }

  // Compare to baseline
  const delta = await manager.compare(summary);
  console.log(generateDeltaConsole(summary, delta));

  // Track trend
  const commitSha = getCommitSha();
  // WP1-2：能力通过率分母排除 infra_excluded（429/超时/5xx/网络）
  const capabilityTotal = summary.total - (summary.infraExcluded ?? 0);
  const passRate = capabilityTotal > 0 ? summary.passed / capabilityTotal : 0;
  const trendPoint: TrendDataPoint = {
    timestamp: Date.now(),
    commitSha,
    scope: effectiveScope,
    passRate,
    averageScore: summary.averageScore,
    totalCases: summary.total,
    duration: summary.duration,
    newFailures: delta.newFailures.length,
    newPasses: delta.newPasses.length,
    mode: effectiveReal ? 'real' : 'mock',
    providerVariantArm: providerVariantArm(),
    ...(summary.infraExcluded ? { infraExcluded: summary.infraExcluded } : {}),
  };
  await tracker.append(trendPoint);
  console.log(chalk.dim(`  Trend data recorded (commit: ${commitSha.slice(0, 7)})`));
  console.log('');

  // Exit with non-zero if regression detected
  if (delta.isRegression) {
    console.log(chalk.red.bold('  Exiting with code 1 due to regression.'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red('eval-ci failed:'), err);
  process.exit(1);
});
