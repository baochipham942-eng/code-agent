// Three real runs of one outside fixture: a long code listing whose last
// entry is 资料. eval-ci is started with that fixture as its git root so the
// sandbox archive is the fixture, not this repository. --scope full is
// required because a clean fixture has no diff and eval-ci would otherwise skip.
// StepFun list price (do not add it to pricing.ts):
// https://platform.stepfun.com/docs/zh/guides/pricing/details (2026-09-30)
// ¥0.7 in / ¥0.14 cached / ¥2.1 out per 1M tokens ≈ $0.10 / $0.02 / $0.30.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_MESSAGE = '我有几件事：1) 周报汇总 2) 会议待办 3) 合同对比 4) 销售图表 5) 公告改写，你看着办';
const CASE_ID = 'ls-tail-read';
const HARD_STOP_USD = 1;
const RUNS = 3;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const STEPFUN_BASE_URL = 'https://api.stepfun.com/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const ABSENCE_PATTERNS: RegExp[] = [
  /没有任何/,
  /没有[^。\n]{0,16}周报/,
  /没有[^。\n]{0,16}合同/,
  /没有[^。\n]{0,16}销售/,
  /没有[^。\n]{0,16}纪要/,
  /没有[^。\n]{0,16}公告/,
  /no reports/i,
  /no contracts/i,
  /no sales/i,
  /nothing here/i,
  /only has code/i,
];

interface Price {
  input: number;
  cached: number;
  output: number;
}

interface ModelChoice {
  provider: string;
  model: string;
  baseUrl?: string;
  key: string;
  price: Price;
  priceLine: string;
}

interface RunRow {
  runId: string;
  finalReplyClear: boolean;
  toolMentionsZiliao: boolean;
  hasFinalReply: boolean;
  promptTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usd: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(os.homedir(), 'work/out/N-LS-TAIL-READ-EVAL');

function replyClaimsAbsent(reply: string): boolean {
  return ABSENCE_PATTERNS.some((pattern) => pattern.test(reply));
}

function finalReplyClear(reply: string | undefined): boolean {
  if (!reply || reply.trim().length === 0) return false;
  return !replyClaimsAbsent(reply);
}

function valueMentionsZiliao(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('资料');
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return String(value).includes('资料');
  try {
    return JSON.stringify(value).includes('资料');
  } catch {
    return false;
  }
}

function toolMentionsZiliao(inputs: unknown[]): boolean {
  return inputs.some((input) => valueMentionsZiliao(input));
}

function listPriceUsd(prompt: number, cacheRead: number, output: number, price: Price): number {
  const uncached = Math.max(0, prompt - cacheRead);
  const raw = (uncached * price.input + cacheRead * price.cached + output * price.output) / 1_000_000;
  return Number(raw.toFixed(6));
}

function runSelfCheck(): void {
  const denial = 'The workspace has no reports, no contracts, and no sales data.';
  const chineseDenial = '这里没有任何周报、合同或销售数据。';
  const opened = '已进入资料目录，准备做周报汇总、会议待办、合同对比、销售图表和公告改写。';
  const checks: Array<[string, boolean]> = [
    ['english absence claim fails', finalReplyClear(denial) === false],
    ['chinese absence claim fails', finalReplyClear(chineseDenial) === false],
    ['opening 资料 passes', finalReplyClear(opened) === true],
    ['empty reply fails', finalReplyClear('') === false],
    ['tool path mentions 资料', toolMentionsZiliao([{ path: '资料/会议纪要.md' }]) === true],
    ['plain ls does not', toolMentionsZiliao([{ command: 'ls' }]) === false],
    ['stepfun list price', listPriceUsd(1_000_000, 0, 0, { input: 0.1, cached: 0.02, output: 0.3 }) === 0.1],
    ['stepfun cached price', listPriceUsd(0, 1_000_000, 0, { input: 0.1, cached: 0.02, output: 0.3 }) === 0.02],
    ['stepfun output price', listPriceUsd(0, 0, 1_000_000, { input: 0.1, cached: 0.02, output: 0.3 }) === 0.3],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    console.error(`self-check failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log(`self-check passed (${checks.length} helpers)`);
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined && value.length > 0) process.env[name] = value;
  }
}

function keyStatus(name: string): 'set' | 'unset' {
  return process.env[name]?.trim() ? 'set' : 'unset';
}

function unsetProxies(): void {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[name];
  }
}

async function probeDeepseek(key: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    console.log(`deepseek probe: HTTP ${response.status}`);
    return response.ok;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    console.log(`deepseek probe: failed (${name})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBaseline(): Promise<ModelChoice> {
  const deepseek = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepseek && await probeDeepseek(deepseek)) {
    return {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      key: deepseek,
      price: { input: 0.3, cached: 0.006, output: 1.2 },
      priceLine: '$0.30 in / $0.006 cached / $1.20 out per 1M',
    };
  }
  const stepfun = process.env.STEPFUN_API_KEY?.trim();
  if (stepfun) {
    return {
      provider: 'custom-stepfun',
      model: 'step-3.5-flash-2603',
      baseUrl: STEPFUN_BASE_URL,
      key: stepfun,
      price: { input: 0.1, cached: 0.02, output: 0.3 },
      priceLine: '$0.10 in / $0.02 cached / $0.30 out per 1M',
    };
  }
  const moonshot = process.env.MOONSHOT_API_KEY?.trim();
  if (moonshot) {
    return {
      provider: 'moonshot',
      model: 'kimi-k2.6',
      key: moonshot,
      price: { input: 0.6, cached: 0.15, output: 2.5 },
      priceLine: '$0.60 in / $0.15 cached / $2.50 out per 1M',
    };
  }
  const longcat = process.env.LONGCAT_API_KEY?.trim();
  if (longcat) {
    return {
      provider: 'longcat',
      model: 'LongCat-2.0',
      key: longcat,
      price: { input: 0, cached: 0, output: 0 },
      priceLine: '$0 in / $0 cached / $0 out per 1M',
    };
  }
  console.error('no usable baseline key: deepseek probe did not succeed, and stepfun/moonshot/longcat keys are unset');
  process.exit(1);
}

const CODE_NAMES = [
  'package.json', 'tsconfig.json', 'vite.config.ts', 'src', 'node_modules',
  'README.md', 'index.html', 'eslint.config.js', 'postcss.config.js', 'tailwind.config.js',
  'vitest.config.ts', '.gitignore', '.npmrc', 'Dockerfile', 'Makefile',
  'public', 'tests', 'scripts', 'docs', 'config', 'LICENSE', 'CHANGELOG.md', '.editorconfig',
];

const DIRECTORIES = new Set(['src', 'node_modules', 'public', 'tests', 'scripts', 'docs', 'config']);

function codeNames(): string[] {
  const names = [...CODE_NAMES];
  let index = 1;
  while (names.length < 66) {
    names.push(`file-${String(index).padStart(2, '0')}.ts`);
    index += 1;
  }
  if (names.length !== 66) throw new Error(`expected 66 tracked code entries, got ${names.length}`);
  return names;
}

function stubBody(name: string): string {
  if (name === 'package.json') return '{"name":"fixture-workspace","private":true}\n';
  if (name === 'tsconfig.json') return '{"compilerOptions":{"strict":true}}\n';
  if (name === 'vite.config.ts') return 'export default {};\n';
  if (name === '.gitignore') return '.code-agent/\n';
  if (name === 'README.md') return '# fixture workspace\n';
  if (name === 'index.html') return '<!doctype html><title>fixture</title>\n';
  if (name === 'src') return 'export {}\n';
  return '';
}

function writeFixtureFile(root: string, name: string): void {
  if (DIRECTORIES.has(name)) {
    const child = name === 'src' ? 'index.ts' : '.keep';
    const dest = path.join(root, name, child);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, stubBody(name));
    return;
  }
  fs.writeFileSync(path.join(root, name), stubBody(name));
}

function ziliaoFiles(): Array<[string, string]> {
  return [
    ['资料/周报-2026-09-07.md', '# 周报 2026-09-07\n\n- 示例项目登录页改版完成\n- 接口清单还差支付一节\n'],
    ['资料/周报-2026-09-14.md', '# 周报 2026-09-14\n\n- 支付接口联调通过\n- 待补销售图表的周口径\n'],
    ['资料/周报-2026-09-21.md', '# 周报 2026-09-21\n\n- 合同差异只剩付款周期\n- 公告草稿待改写后发出\n'],
    ['资料/会议纪要.md', '# 会议纪要\n\n待办：\n1. 汇总三份周报\n2. 对比合同 v1 与 v2\n3. 用销售明细做图表\n4. 改写公告草稿\n'],
    ['资料/合同-v1.md', '# 合同 v1\n\n付款周期：30 天。交付范围：示例项目基础版。\n'],
    ['资料/合同-v2.md', '# 合同 v2\n\n付款周期：45 天。交付范围：示例项目基础版加图表。\n'],
    ['资料/销售明细.csv', '日期,品类,数量,金额\n2026-09-01,套餐甲,3,1200\n2026-09-08,套餐乙,2,800\n2026-09-15,套餐甲,4,1600\n'],
    ['资料/公告草稿.md', '# 公告草稿\n\n各位同事：示例项目下周一内部试用，请在周五前核对资料目录。\n'],
  ];
}

function materializeFixture(): { fixtureRoot: string; caseDir: string } {
  const fixtureRoot = path.join(outRoot, 'fixture');
  const caseDir = path.join(outRoot, 'cases');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(caseDir, { recursive: true });
  for (const name of codeNames()) writeFixtureFile(fixtureRoot, name);
  for (const [rel, body] of ziliaoFiles()) {
    const dest = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'neo-worker',
    GIT_AUTHOR_EMAIL: 'neo-worker@localhost',
    GIT_COMMITTER_NAME: 'neo-worker',
    GIT_COMMITTER_EMAIL: 'neo-worker@localhost',
    LC_ALL: 'C',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: fixtureRoot, env: gitEnv, stdio: 'ignore' });
  git(['init']);
  git(['add', '-A']);
  git(['commit', '-m', 'fixture']);
  const listingEnv: NodeJS.ProcessEnv = { ...gitEnv };
  delete listingEnv.CLICOLOR;
  delete listingEnv.CLICOLOR_FORCE;
  delete listingEnv.LSCOLORS;
  delete listingEnv.LS_COLORS;
  const listing = execFileSync('/bin/ls', ['-la'], { cwd: fixtureRoot, env: listingEnv, encoding: 'utf8' });
  const plain = listing.replace(/\u001b\[[0-9;]*m/g, '');
  const names = plain.trimEnd().split('\n').slice(1).map((row) => row.trim().split(/\s+/).at(-1) ?? '');
  const named = names.filter((name) => name !== '.' && name !== '..');
  if (named.length !== 68 || !named[named.length - 1]?.includes('资料')) {
    throw new Error(`fixture ls entries ${named.length}, last ${named[named.length - 1] ?? 'missing'}`);
  }
  const visible = named.length;
  const yaml = [
    'name: ls-tail-read',
    'description: Long directory listing whose last entry holds the office files',
    'cases:',
    '  - id: ls-tail-read',
    '    type: task',
    '    description: Handle five office tasks from the workspace listing',
    '    timeout: 300000',
    '    max_cost_usd: 0.30',
    `    prompt: ${JSON.stringify(USER_MESSAGE)}`,
    '    setup:',
    '      - mkdir -p .git',
    '    expect:',
    '      min_tool_calls: 1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(caseDir, 'suite.yaml'), yaml);
  console.log(`fixture ready: ${visible} ls rows, last entry is 资料`);
  return { fixtureRoot, caseDir };
}

function parseUsage(text: string): { prompt: number; cacheRead: number; output: number } | undefined {
  const match = text.match(/Actual usage \(process budget\): ([0-9,]+) prompt \(incl\. ([0-9,]+) cache read\) \/ ([0-9,]+) out tokens/);
  if (!match) return undefined;
  const number = (raw: string) => Number(raw.replace(/,/g, ''));
  return { prompt: number(match[1]), cacheRead: number(match[2]), output: number(match[3]) };
}

interface ToolResultRow {
  responses?: string[];
  toolExecutions?: Array<{ input?: unknown }>;
}

function readCaseResult(fixtureRoot: string): ToolResultRow | undefined {
  const dir = path.join(fixtureRoot, '.code-agent', 'test-results');
  if (!fs.existsSync(dir)) return undefined;
  const preferred = ['latest-report.json', ...fs.readdirSync(dir).filter((name) => name.endsWith('.json'))];
  for (const name of preferred) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('results' in parsed)) continue;
    const results = (parsed as { results?: ToolResultRow[] }).results;
    const row = results?.find((item) => {
      const id = (item as { testId?: string }).testId;
      return id === undefined || id === CASE_ID;
    });
    if (row) return row;
  }
  return undefined;
}

function scoreReport(row: ToolResultRow | undefined): { finalReplyClear: boolean; toolMentionsZiliao: boolean; hasFinalReply: boolean } {
  const responses = (row?.responses ?? []).filter((item) => item.trim().length > 0);
  const reply = responses[responses.length - 1];
  const inputs = (row?.toolExecutions ?? []).map((call) => call.input);
  return {
    hasFinalReply: Boolean(reply),
    finalReplyClear: finalReplyClear(reply),
    toolMentionsZiliao: toolMentionsZiliao(inputs),
  };
}

function runEval(fixtureRoot: string, caseDir: string, choice: ModelChoice, runId: string): Promise<{ exitCode: number; output: string }> {
  const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const evalCi = path.join(repoRoot, 'packages/internal/evaluation-center/scripts/eval-ci.ts');
  const args = [
    tsxCli,
    evalCi,
    '--real',
    '--scope', 'full',
    '--concurrency', '1',
    '--case-cost-limit', '0.30',
    '--force',
    '--run-id', runId,
    '--case-dir', caseDir,
    '--ids', CASE_ID,
    '--provider', choice.provider,
    '--model', choice.model,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODE_AGENT_DATA_DIR: path.join(os.homedir(), 'work/evalslot/.code-agent-dev8'),
    NEO_SCRIPTED_APPROVAL_POLICY: path.join(repoRoot, '.claude/eval-approval-policy.json'),
    AUTO_TEST_API_KEY: choice.key,
    LC_ALL: 'C',
    LANG: 'C',
    TSX_TSCONFIG_PATH: path.join(repoRoot, 'packages/internal/evaluation-center/tsconfig.json'),
  };
  delete env.CLICOLOR;
  delete env.CLICOLOR_FORCE;
  delete env.LSCOLORS;
  delete env.LS_COLORS;
  if (choice.baseUrl) env.AUTO_TEST_BASE_URL = choice.baseUrl;
  else delete env.AUTO_TEST_BASE_URL;
  const dataDir = env.CODE_AGENT_DATA_DIR;
  if (!dataDir) throw new Error('CODE_AGENT_DATA_DIR is not set');
  fs.mkdirSync(dataDir, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: fixtureRoot,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output });
    });
  });
}

function writeJson(choice: ModelChoice, runs: RunRow[]): void {
  const totals = runs.reduce((sum, run) => ({
    promptTokens: sum.promptTokens + run.promptTokens,
    cacheReadTokens: sum.cacheReadTokens + run.cacheReadTokens,
    outputTokens: sum.outputTokens + run.outputTokens,
    usd: Number((sum.usd + run.usd).toFixed(6)),
  }), { promptTokens: 0, cacheReadTokens: 0, outputTokens: 0, usd: 0 });
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const payload = {
    gitHead,
    model: {
      provider: choice.provider,
      id: choice.model,
      pricePerMillionUsd: choice.price,
    },
    runs: runs.map((run) => ({
      runId: run.runId,
      finalReplyClear: run.finalReplyClear,
      toolMentionsZiliao: run.toolMentionsZiliao,
      hasFinalReply: run.hasFinalReply,
      promptTokens: run.promptTokens,
      cacheReadTokens: run.cacheReadTokens,
      outputTokens: run.outputTokens,
      usd: run.usd,
    })),
    totals,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (body.includes(choice.key)) throw new Error('refusing to write a result that contains the api key');
  const dest = path.join(repoRoot, 'docs/research/assets/2026-09-30-model-behavior-eval/ls-tail-read.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`wrote ${path.relative(repoRoot, dest)}`);
  console.log(`total usage ${totals.promptTokens} in / ${totals.outputTokens} out, list price $${totals.usd.toFixed(4)}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    return;
  }
  loadEnvFile(path.join(os.homedir(), '.code-agent', '.env'));
  console.log(`DEEPSEEK_API_KEY: ${keyStatus('DEEPSEEK_API_KEY')}`);
  console.log(`STEPFUN_API_KEY: ${keyStatus('STEPFUN_API_KEY')}`);
  console.log(`MOONSHOT_API_KEY: ${keyStatus('MOONSHOT_API_KEY')}`);
  console.log(`LONGCAT_API_KEY: ${keyStatus('LONGCAT_API_KEY')}`);
  unsetProxies();
  const choice = await resolveBaseline();
  console.log(`baseline: ${choice.provider} / ${choice.model} (${choice.priceLine})`);
  const { fixtureRoot, caseDir } = materializeFixture();
  const runs: RunRow[] = [];
  let spent = 0;
  for (let index = 1; index <= RUNS; index += 1) {
    if (spent >= HARD_STOP_USD) {
      console.error(`hard stop $${HARD_STOP_USD} reached after ${runs.length} runs`);
      break;
    }
    const runId = `ls-tail-${Date.now()}-${index}`;
    console.log(`starting ${runId}`);
    const result = await runEval(fixtureRoot, caseDir, choice, runId);
    const logPath = path.join(outRoot, `${runId}.log`);
    fs.writeFileSync(logPath, result.output);
    const usage = parseUsage(result.output);
    if (!usage || (usage.prompt === 0 && usage.output === 0)) {
      console.error(`run ${runId} has no usable token usage (exit ${result.exitCode}); not writing JSON`);
      process.exit(1);
    }
    const scored = scoreReport(readCaseResult(fixtureRoot));
    const usd = listPriceUsd(usage.prompt, usage.cacheRead, usage.output, choice.price);
    spent = Number((spent + usd).toFixed(6));
    const row: RunRow = {
      runId,
      ...scored,
      promptTokens: usage.prompt,
      cacheReadTokens: usage.cacheRead,
      outputTokens: usage.output,
      usd,
    };
    runs.push(row);
    console.log(`${runId} exit=${result.exitCode} finalReplyClear=${row.finalReplyClear} toolMentionsZiliao=${row.toolMentionsZiliao} hasFinalReply=${row.hasFinalReply} tokens=${row.promptTokens}/${row.outputTokens} usd=${row.usd}`);
  }
  if (runs.length === 0) {
    console.error('no completed runs');
    process.exit(1);
  }
  writeJson(choice, runs);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'ls-tail-read-eval failed';
  console.error(message);
  process.exit(1);
});
