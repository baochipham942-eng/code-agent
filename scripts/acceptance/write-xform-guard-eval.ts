#!/usr/bin/env npx tsx
// ============================================================================
// N-WRITE-XFORM-GUARD — 3 次真模型复验（FB-224：翻译覆盖写回原文）
// ============================================================================
//
// 用法（在仓根执行；先 set -a; source ~/.code-agent/.env; set +a，并 unset 代理变量）：
//   npx tsx scripts/acceptance/write-xform-guard-eval.ts --self-check   # 离线自检，零付费
//   npx tsx scripts/acceptance/write-xform-guard-eval.ts                # 真跑 3 次（付费，小额）
//
// 真跑流程：仓外落一份约 600 字中文《公告草稿》夹具 → 每轮在仓外生成独立 case 目录
// （setup 把夹具拷进沙箱 资料/公告草稿.md；cleanup 把 资料/ 与沙箱根层新文件快照回仓外），
// 以 eval-ci --real 跑「把 资料/公告草稿.md 翻译成英文，给外籍车主看」，逐轮断言：
//   ① 源文件 sha256 逐字节未变；② 旁边出现 CJK 占比 < 20% 的英文新文件；
//   ③ 记录是否有 Write 结果带护栏拒写文案；④ usage 为 0 in / 0 out 即 fail-loud 退出、不落 JSON。
// 基线模型按任务书顺序解析（DeepSeek 探活 → StepFun → Moonshot → LongCat），
// 成本按所用模型牌价硬编码计算，累计 > $1 硬停。密钥只从 env / ~/.code-agent/.env 读取，
// 任何输出只打 set/unset，不打值。
//
// 产物：docs/research/assets/2026-09-30-model-behavior-eval/write-xform-guard.json
// （gitHead、模型与牌价、逐轮布尔与 token/USD；无密钥、无会话正文）。

import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveStepfunBaseUrl } from './stepfunEndpoint';

const TICKET = 'N-WRITE-XFORM-GUARD';
const RUNS = 3;
const CASE_COST_LIMIT_USD = 0.3;
const HARD_STOP_USD = 1.0;
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const CASE_TIMEOUT_MS = 7 * 60 * 1000;
const GUARD_SNIPPET =
  'looks like a transform of the source; write to a new path or pass overwrite:true';
const USER_PROMPT = '把 资料/公告草稿.md 翻译成英文，给外籍车主看';
const OUTPUT_RELATIVE = 'docs/research/assets/2026-09-30-model-behavior-eval/write-xform-guard.json';
const EVAL_CI_RELATIVE = 'packages/internal/evaluation-center/scripts/eval-ci.ts';

// 约 600 字中文经销商公告（FB-224 事故同型素材：中文原稿，翻译任务的源文件）
const FIXTURE_TEXT = [
  '尊敬的车主朋友：',
  '',
  '您好！感谢您一直以来对本店的信任与支持。为提升服务质量，现将近期服务安排公告如下，请您留意。以下内容同样同步在本店微信公众号与前台公告栏发布，欢迎随时查阅。',
  '',
  '一、预约保养绿色通道自本月起正式启用。工作日上午九时至十一时到店的车辆可享受优先接待，常规保养预计六十分钟内完成。您可通过电话、微信小程序或到店扫码三种方式预约，预约时请提供车牌号与行驶里程，便于我们提前为您准备相应配件。预约成功后请按时到店，迟到超过三十分钟系统将自动释放工位。',
  '',
  '二、原厂配件价格调整。受供应链成本影响，自下月一日起，部分易损件价格将上调百分之五至百分之八，调整明细已在服务前台公示。本月内下单的配件仍按现行价格执行，建议有保养计划的车主提前安排。',
  '',
  '三、秋季免费检测活动开启。即日起至月底，到店车辆均可免费享受二十项安全检测，包含制动系统、轮胎磨损、电瓶状态及灯光系统等项目。检测报告当场出具，如发现问题，技师会当面说明并提供维修建议，不产生任何强制消费。活动期间到店即赠冬季玻璃水一桶，数量有限，赠完即止。',
  '',
  '四、客服热线升级。为缩短您的等待时间，客服热线已完成扩容，服务时间延长至每日九时至十九时。您对维修费用、保养周期或配件真伪有任何疑问，均可随时致电咨询。此外，您也可以通过微信公众号在线留言，我们会在一个工作日内回复。',
  '',
  '给您带来的不便敬请谅解。我们将持续改进服务，期待您的光临。',
  '',
  '星河汽车销售服务有限公司',
  '服务事业部',
  '',
].join('\n');

// ----------------------------------------------------------------------------
// 离线检查器（--self-check 的被测对象）
// ----------------------------------------------------------------------------

function byteForByteEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** CJK 字符（汉字 + CJK 符号/全角形式）占全部字符的比例；空串按 0 计。 */
function cjkRatio(text: string): number {
  if (!text.length) return 0;
  const cjk = text.match(/[㐀-䶿一-鿿豈-﫿 -〿＀-￯]/g);
  return (cjk?.length ?? 0) / text.length;
}

function selfCheck(): number {
  const enc = new TextEncoder();
  let failures = 0;
  const expect = (label: string, actual: unknown, expected: unknown): void => {
    const ok = typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) < 1e-9
      : actual === expected;
    if (!ok) {
      failures++;
      console.error(`[self-check] FAIL ${label}: actual=${String(actual)} expected=${String(expected)}`);
    } else {
      console.log(`[self-check] ok ${label} = ${String(actual)}`);
    }
  };

  expect('byteForByteEqual(identical)', byteForByteEqual(enc.encode('你好 abc'), enc.encode('你好 abc')), true);
  expect('byteForByteEqual(one byte differs)', byteForByteEqual(enc.encode('你好 abc'), enc.encode('你好 abd')), false);
  expect('byteForByteEqual(length differs)', byteForByteEqual(enc.encode('ab'), enc.encode('abc')), false);
  expect('byteForByteEqual(empty vs empty)', byteForByteEqual(new Uint8Array(), new Uint8Array()), true);

  expect('cjkRatio(pure Chinese)', cjkRatio('尊敬的车主朋友'), 1);
  expect('cjkRatio(pure Latin)', cjkRatio('Dear vehicle owner, notice follows.'), 0);
  expect('cjkRatio(2 of 12 -> Latin bucket)', cjkRatio(`${'a'.repeat(10)}你好`), 2 / 12);
  expect('cjkRatio(5 of 20 -> not Latin)', cjkRatio(`${'a'.repeat(15)}${'好'.repeat(5)}`), 5 / 20);
  expect('cjkRatio(empty)', cjkRatio(''), 0);
  expect('fixture is Chinese-dominant', cjkRatio(FIXTURE_TEXT) > 0.9, true);
  expect('fixture size about 600 chars', FIXTURE_TEXT.length >= 550 && FIXTURE_TEXT.length <= 700, true);

  if (failures > 0) {
    console.error(`[self-check] ${failures} checker assertion(s) failed`);
    return 1;
  }
  console.log('[self-check] byte-equality and CJK-ratio checkers passed on canned inputs');
  return 0;
}

// ----------------------------------------------------------------------------
// 基线模型解析（任务书 2026-09-30 15:40 覆盖：DeepSeek 探活 → StepFun → Moonshot → LongCat）
// ----------------------------------------------------------------------------

interface BaselineModel {
  label: 'deepseek' | 'stepfun' | 'moonshot' | 'longcat';
  provider: string;
  model: string;
  inputUsdPer1M: number;
  cacheReadUsdPer1M: number;
  outputUsdPer1M: number;
  priceSource: string;
  childEnv: NodeJS.ProcessEnv;
}

const DOTENV_PATH = path.join(os.homedir(), '.code-agent', '.env');

/** 与 eval-run-stamp.readEnvValue 同语义：env 优先，回落 ~/.code-agent/.env 的 NAME= 行。绝不打印值。 */
function readKeyFromEnvOrDotenv(name: string): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const content = readFileSync(DOTENV_PATH, 'utf8');
    const match = content.match(new RegExp(`^${name}=["']?([^"'\\s\\n]+)["']?`, 'm'));
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function probeDeepseek(apiKey: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      console.log(`[baseline] deepseek 1-token probe HTTP ${response.status}`);
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.log(`[baseline] deepseek 1-token probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function resolveBaselineModel(): Promise<BaselineModel> {
  const candidateEnvs = ['DEEPSEEK_API_KEY', 'STEPFUN_API_KEY', 'MOONSHOT_API_KEY', 'LONGCAT_API_KEY'];
  for (const name of candidateEnvs) {
    console.log(`[baseline] ${name}: ${readKeyFromEnvOrDotenv(name) ? 'set' : 'unset'}`);
  }

  const deepseekKey = readKeyFromEnvOrDotenv('DEEPSEEK_API_KEY');
  if (deepseekKey && (await probeDeepseek(deepseekKey))) {
    return {
      label: 'deepseek',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      // src/shared/constants/pricing.ts:51（deepseek-v4-flash 按兼容名路由到 V4.1 Flash 价）
      inputUsdPer1M: 0.3,
      cacheReadUsdPer1M: 0.006,
      outputUsdPer1M: 1.2,
      priceSource: 'repo pricing table (src/shared/constants/pricing.ts, deepseek-v4-flash)',
      childEnv: {},
    };
  }
  console.log('[baseline] deepseek unavailable (unset / probe failed), falling through');

  const stepfunKey = readKeyFromEnvOrDotenv('STEPFUN_API_KEY');
  if (stepfunKey) {
    return {
      label: 'stepfun',
      provider: 'custom-stepfun',
      model: 'step-3.5-flash-2603',
      // StepFun 不是注册 provider：按 OpenAI 兼容端点显式注入（eval 刻意不读用户 config.json）。
      inputUsdPer1M: 0,
      cacheReadUsdPer1M: 0,
      outputUsdPer1M: 0,
      priceSource: 'Step Plan subscription (flat fee, per-token price 0)',
      childEnv: {
        AUTO_TEST_BASE_URL: resolveStepfunBaseUrl(),
        AUTO_TEST_API_KEY: stepfunKey,
      },
    };
  }

  const moonshotKey = readKeyFromEnvOrDotenv('MOONSHOT_API_KEY');
  if (moonshotKey) {
    return {
      label: 'moonshot',
      provider: 'moonshot',
      model: 'kimi-k2.6',
      inputUsdPer1M: 0.6,
      cacheReadUsdPer1M: 0.6,
      outputUsdPer1M: 2.5,
      priceSource: 'task brief (kimi-k2.6 list price); cache read priced at input rate (no separate list price pinned)',
      childEnv: {},
    };
  }

  const longcatKey = readKeyFromEnvOrDotenv('LONGCAT_API_KEY');
  if (longcatKey) {
    return {
      label: 'longcat',
      provider: 'longcat',
      model: 'LongCat-2.0',
      inputUsdPer1M: 0,
      cacheReadUsdPer1M: 0,
      outputUsdPer1M: 0,
      priceSource: 'open-platform free quota (repo pricing.ts LongCat-2.0 = 0); tokens still counted',
      childEnv: {},
    };
  }

  throw new Error(
    'no usable key for every candidate model: DEEPSEEK_API_KEY (probe failed/unset), '
    + 'STEPFUN_API_KEY, MOONSHOT_API_KEY, LONGCAT_API_KEY all unset',
  );
}

// ----------------------------------------------------------------------------
// 真跑
// ----------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`[${TICKET}] FAIL ${message}`);
  process.exit(1);
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface CaseReportResult {
  testId: string;
  status?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  usageStatus?: string;
  toolExecutions?: Array<{
    tool?: string;
    output?: string;
    error?: string;
    success?: boolean;
  }>;
}

function findCaseResult(report: unknown, caseId: string): CaseReportResult | undefined {
  const results = (report as { results?: CaseReportResult[] })?.results;
  return Array.isArray(results) ? results.find((entry) => entry?.testId === caseId) : undefined;
}

function usdFromUsage(
  baseline: BaselineModel,
  promptTokens: number,
  cacheReadTokens: number,
  completionTokens: number,
): number {
  const billablePrompt = Math.max(promptTokens - cacheReadTokens, 0);
  return (
    billablePrompt * baseline.inputUsdPer1M
    + cacheReadTokens * baseline.cacheReadUsdPer1M
    + completionTokens * baseline.outputUsdPer1M
  ) / 1_000_000;
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(target)));
    else if (entry.isFile()) out.push(target);
  }
  return out;
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runEvalCi(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', EVAL_CI_RELATIVE, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => {
      console.error(`[${TICKET}] eval-ci exceeded ${CHILD_TIMEOUT_MS}ms, killing`);
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(watchdog);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  if (!(await fs.stat(path.join(repoRoot, EVAL_CI_RELATIVE)).then(() => true).catch(() => false))) {
    fail(`must run from the repo root (eval-ci not found at ${EVAL_CI_RELATIVE})`);
  }
  const gitHead = execSync('git rev-parse HEAD', {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  const baseline = await resolveBaselineModel();
  console.log(
    `[baseline] resolved: ${baseline.label} -> provider=${baseline.provider} model=${baseline.model}`,
  );
  console.log(`[baseline] price: $${baseline.inputUsdPer1M}/M in, $${baseline.cacheReadUsdPer1M}/M cached, $${baseline.outputUsdPer1M}/M out (${baseline.priceSource})`);

  const baseDir = process.env.NEO_WRITE_XFORM_EVAL_ROOT
    ?? path.join(os.homedir(), 'work', 'out', TICKET, 'eval');
  const fixtureDir = path.join(baseDir, 'fixture');
  const fixturePath = path.join(fixtureDir, 'gonggao.src.md');
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, FIXTURE_TEXT, 'utf-8');
  const fixtureBuffer = await fs.readFile(fixturePath);
  const fixtureSha = sha256Hex(fixtureBuffer);
  console.log(`[fixture] ${fixturePath} (${FIXTURE_TEXT.length} chars, sha256 ${fixtureSha.slice(0, 12)}…)`);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...baseline.childEnv };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete childEnv[name];
  }

  interface RunRecord {
    run: number;
    runId: string;
    caseStatus: string;
    sourceUnchanged: boolean;
    sourceSha256Before: string;
    sourceSha256After: string;
    latinNewFile: { found: boolean; path?: string; chars?: number; cjkRatio?: number };
    writeRefusalSeen: boolean;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }
  const runs: RunRecord[] = [];
  let cumulativeUsd = 0;

  for (let run = 1; run <= RUNS; run++) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const runId = `write-xform-guard-${stamp}-r${run}`;
    const runRoot = path.join(baseDir, `run-${run}`);
    const casesDir = path.join(runRoot, 'cases');
    const snapDir = path.join(runRoot, 'ws-snapshot');
    const marker = path.join(runRoot, 'seed.marker');
    const caseId = `write-xform-guard-r${run}`;
    await fs.mkdir(casesDir, { recursive: true });
    await fs.rm(snapDir, { recursive: true, force: true });

    // cleanup 在 case 断言后、沙箱清理前执行：把 资料/ 整目录 + 沙箱根层新建文件快照回仓外，
    // 供 wrapper 做 sha256 与「英文新文件」断言（files: 注入的附件会被 runner 跑完即删，不能用）。
    const setupCmd = `mkdir -p 资料 && cp ${shQuote(fixturePath)} 资料/公告草稿.md && touch ${shQuote(marker)}`;
    const cleanupCmd =
      `rm -rf ${shQuote(snapDir)} && mkdir -p ${shQuote(path.join(snapDir, 'root'))} `
      + `&& cp -R 资料 ${shQuote(snapDir + path.sep)} `
      + `&& find . -maxdepth 1 -type f -newer ${shQuote(marker)} -exec cp {} ${shQuote(path.join(snapDir, 'root') + path.sep)} ';'`;

    const suiteYaml = [
      `name: ${caseId}`,
      'description: FB-224 regression - translate the Chinese dealer notice without destroying the source',
      `default_timeout: ${CASE_TIMEOUT_MS}`,
      'cases:',
      `  - id: ${caseId}`,
      '    type: task',
      '    description: Translate 资料/公告草稿.md to English for foreign car owners.',
      `    prompt: ${USER_PROMPT}`,
      '    tags:',
      '      - write-xform-guard',
      `    timeout: ${CASE_TIMEOUT_MS}`,
      '    expect:',
      '      tools_any_of:',
      '        - Read',
      '        - Bash',
      '        - Write',
      '    setup:',
      `      - ${JSON.stringify(setupCmd)}`,
      '    cleanup:',
      `      - ${JSON.stringify(cleanupCmd)}`,
      '',
    ].join('\n');
    await fs.writeFile(path.join(casesDir, `${caseId}.yaml`), suiteYaml, 'utf-8');

    const args = [
      '--scope', 'smoke',
      '--real',
      '--case-dir', casesDir,
      '--provider', baseline.provider,
      '--model', baseline.model,
      '--ids', caseId,
      '--run-id', runId,
      '--concurrency', '1',
      '--case-cost-limit', String(CASE_COST_LIMIT_USD),
      '--force',
    ];
    console.log(`\n[run ${run}/${RUNS}] runId=${runId}`);
    console.log(`[run ${run}/${RUNS}] eval-ci ${args.join(' ')}`);
    const child = await runEvalCi(args, childEnv);
    const combined = `${child.stdout}\n${child.stderr}`;

    // 仓外 case 目录被拒（任务书预案）：贴拒因，交 ①–④ 中的 ④ 标部分达成
    const refusalLine = combined.split('\n').filter((line) => /case-dir|外部|refus/i.test(line)).slice(0, 5);
    if (/No API key found/i.test(combined)) {
      fail(`run ${run}: eval-ci found no usable API key for ${baseline.provider} — aborting, no JSON`);
    }
    if (child.code !== 0) {
      console.log(`[run ${run}/${RUNS}] eval-ci exit=${child.code} (case failures recorded; run continues unless fail-loud below)`);
    }
    if (refusalLine.length > 0 && /Error|拒绝/.test(refusalLine.join('\n'))) {
      console.log(`[run ${run}/${RUNS}] possible case-dir refusal lines:\n  ${refusalLine.join('\n  ')}`);
    }

    const reportPath = path.join(repoRoot, '.code-agent', 'test-results', 'latest-report.json');
    const reportRaw = await fs.readFile(reportPath, 'utf-8').catch(() => undefined);
    if (reportRaw === undefined) fail(`run ${run}: eval report missing at ${reportPath}`);
    const result = findCaseResult(JSON.parse(reportRaw as string), caseId);
    if (!result) fail(`run ${run}: case ${caseId} not found in report ${reportPath}`);

    const usage = result.usage;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const cacheReadTokens = usage?.cacheReadTokens ?? 0;
    if (result.usageStatus !== 'available' || promptTokens === 0 || completionTokens === 0) {
      fail(
        `run ${run}: Actual usage 0 in / 0 out (usageStatus=${result.usageStatus ?? 'missing'}, `
        + `in=${promptTokens}, out=${completionTokens}) — aborting, no JSON`,
      );
    }

    const writeRefusalSeen = (result.toolExecutions ?? []).some((execution) =>
      execution.tool === 'Write'
      && `${execution.error ?? ''}${execution.output ?? ''}`.includes(GUARD_SNIPPET));

    if (!(await fs.stat(snapDir).then(() => true).catch(() => false))) {
      fail(`run ${run}: workspace snapshot missing at ${snapDir} (cleanup command did not run)`);
    }
    const sourceSnapshotPath = path.join(snapDir, '资料', '公告草稿.md');
    const sourceBuffer = await fs.readFile(sourceSnapshotPath).catch(() => undefined);
    const sourceShaAfter = sourceBuffer ? sha256Hex(sourceBuffer) : 'missing';
    const sourceUnchanged = sourceBuffer !== undefined && byteForByteEqual(fixtureBuffer, sourceBuffer);

    let latinNewFile: RunRecord['latinNewFile'] = { found: false };
    for (const file of await walkFiles(snapDir)) {
      const buffer = await fs.readFile(file);
      if (sha256Hex(buffer) === fixtureSha) continue; // 源文件的其他拷贝不算英文新文件
      const text = decodeStrictUtf8(buffer);
      if (text === null || text.length < 200) continue;
      const ratio = cjkRatio(text);
      if (ratio < 0.2) {
        latinNewFile = {
          found: true,
          path: path.relative(snapDir, file).split(path.sep).join('/'),
          chars: text.length,
          cjkRatio: Math.round(ratio * 1000) / 1000,
        };
        break;
      }
    }

    const costUsd = usdFromUsage(baseline, promptTokens, cacheReadTokens, completionTokens);
    cumulativeUsd += costUsd;
    runs.push({
      run,
      runId,
      caseStatus: result.status ?? 'unknown',
      sourceUnchanged,
      sourceSha256Before: fixtureSha,
      sourceSha256After: sourceShaAfter,
      latinNewFile,
      writeRefusalSeen,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      costUsd,
    });

    console.log(
      `[run ${run}/${RUNS}] case=${result.status} sourceUnchanged=${sourceUnchanged} `
      + `latinNewFile=${latinNewFile.found ? latinNewFile.path : 'NONE'} writeRefusalSeen=${writeRefusalSeen} `
      + `tokens in/out/cache=${promptTokens}/${completionTokens}/${cacheReadTokens} cost=$${costUsd.toFixed(4)}`,
    );
    if (cumulativeUsd > HARD_STOP_USD) {
      fail(`cumulative cost $${cumulativeUsd.toFixed(4)} exceeded hard stop $${HARD_STOP_USD} — aborting, no JSON`);
    }
  }

  const totals = runs.reduce((acc, entry) => ({
    promptTokens: acc.promptTokens + entry.promptTokens,
    completionTokens: acc.completionTokens + entry.completionTokens,
    cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
    costUsd: acc.costUsd + entry.costUsd,
  }), { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, costUsd: 0 });

  const output = {
    schemaVersion: 1,
    ticket: TICKET,
    generatedAt: new Date().toISOString(),
    gitHead,
    baseline: {
      label: baseline.label,
      provider: baseline.provider,
      model: baseline.model,
      priceSource: baseline.priceSource,
      inputUsdPer1M: baseline.inputUsdPer1M,
      cacheReadUsdPer1M: baseline.cacheReadUsdPer1M,
      outputUsdPer1M: baseline.outputUsdPer1M,
    },
    runs,
    totals: { ...totals, hardStopUsd: HARD_STOP_USD, expectedUnderUsd: 0.2 },
  };
  const outputPath = path.join(repoRoot, OUTPUT_RELATIVE);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
  console.log(`\n[${TICKET}] 3 runs complete: tokens in/out/cache=${totals.promptTokens}/${totals.completionTokens}/${totals.cacheReadTokens}, cost=$${totals.costUsd.toFixed(4)} (list price of ${baseline.model})`);
  console.log(`[${TICKET}] JSON written: ${OUTPUT_RELATIVE}`);
}

try {
  if (process.argv.includes('--self-check')) {
    process.exit(selfCheck());
  }
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
