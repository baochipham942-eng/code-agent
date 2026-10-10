/**
 * N-VIZ-NUMBERS-FROM-CODE
 *
 * 判定器只活在本文件里，不向 src/ 导出。
 * 宿主不排版文案；本脚本核对：图表 spec 里每个系列的数字是否整词出现在工具输出，
 * 以及是否有一段已执行脚本同时点到该系列的列和一种聚合；另有 global 门，
 * 图表里任何切片的数字（含未定义系列的切片）都必须整词出现在工具输出。
 *
 * r2（2026-10-01）：r1 真跑 6 次发现 (a) 二分类现实与行号槽泄漏，见 SERIES 注释
 * 与 stripReadGutters 注释；自检样例改为 g1（二分饼）/g2（三分饼）/坏 1/坏 2。
 *
 * 用法：
 *   npx tsx scripts/acceptance/viz-numbers-from-code-eval.ts --self-check
 *   npx tsx scripts/acceptance/viz-numbers-from-code-eval.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStepfunBaseUrl } from './stepfunEndpoint';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(os.homedir(), 'work', 'out', 'N-VIZ-NUMBERS-FROM-CODE');
const JSON_REL = 'docs/research/assets/2026-09-30-model-behavior-eval/viz-numbers.json';
const RULE_LINE = '- 数据可视化（chart 代码块 / 图表产物）中展示的每个数字必须来自对数据实际执行过的代码输出，禁止手打数字。先跑一段脚本把每个系列的汇总值打印出来，再把打印出来的数字抄进图表。';
const TASK_SENTENCE = '清洗这份客户表，并用饼图展示手机号状态、柱图展示城市分布。';
const HARD_STOP_USD = 2;
const CASE_COST_LIMIT = '0.40';
const CASE_ID = 'viz-customer-clean-charts';
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 反向变异只改这一处：设为 false 后，工具输出整词核对（系列级 (b) + global 门）
 * 一起放行，坏样例 2（脚本真聚合、只打印总数/异常数）会被整体误放行，自检必须转红。
 * 还原时改回 true，不要用 git checkout 覆盖同文件的其他改动。
 */
const CHECK_B_ENABLED = true;

const AGGREGATION_PATTERNS: RegExp[] = [
  /value_counts/,
  /groupby/,
  /\bCounter\b/,
  /\bcount\b/i,
  /\bsum\b/i,
  /\bawk\b/,
  /sort\s*\|\s*uniq\s+-c/,
  /(?:for|while)[\s\S]{0,500}?(?:\+\+|\+=)/,
];

interface SeriesDef {
  id: string;
  column: 'phone' | 'city';
  aliases: string[];
  patterns: RegExp[];
}

// 系列判定 2026-09-30 r2：真模型 6 跑实测（r1，双臂）都把「手机号状态」读成
// 已填/缺失 二分，1380000 批 11 位号格式合法，连写了 is_valid_phone 正则的跑也放行。
// 任务句固定不许加分类定义，二分饼是这套任务句下的真实形态，所以判定器按数据的
// 填写类归并：phone-normal = 非空类（含 1380000 批，模型判其有效）。
// 若强模型真画出第三片（如 无效），该片数字仍被 global 整词门兜底核对。
const SERIES: SeriesDef[] = [
  {
    id: 'phone-normal',
    column: 'phone',
    aliases: ['phone', '手机号', '手机'],
    patterns: [/正常/, /(?<!无)有效/, /已填写/, /有手机号/, /非空/, /normal/i, /(?<!in)valid/i, /filled/i, /present/i],
  },
  { id: 'phone-blank', column: 'phone', aliases: ['phone', '手机号', '手机'], patterns: [/空白/, /缺失/, /空号/, /空值/, /blank/i, /missing/i, /empty/i, /^空$/] },
  { id: 'city-shanghai', column: 'city', aliases: ['city', '城市'], patterns: [/上海/, /shanghai/i] },
  { id: 'city-beijing', column: 'city', aliases: ['city', '城市'], patterns: [/北京/, /beijing/i] },
];

// 台账里坏样例「四个凭空数字」所在的系列（正常/缺失/上海/北京），FB-225 原样。
const EXTRA_SERIES = ['phone-normal', 'phone-blank', 'city-shanghai', 'city-beijing'];

interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
  output: string;
  executed: boolean;
}

interface Check {
  pass: boolean;
  reason: string;
}

interface SeriesResult {
  id: string;
  numbers: number[];
  pass: boolean;
  checks: { a: Check; b: Check; c: Check };
}

interface Fixture {
  csv: string;
  rows: number;
  phone: { 正常: number; 异常: number; 空白: number };
  city: Record<string, number>;
}

interface Usage {
  promptTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

interface ModelChoice {
  id: 'deepseek' | 'stepfun' | 'moonshot' | 'longcat';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  price: { input: number; cached: number; output: number; note: string };
}

interface RunRecord {
  arm: 'with-rule' | 'control';
  runId: string;
  series: SeriesResult[];
  global: Check;
  tokens: Usage;
  usd: number;
  evalExit: number;
}

function buildFixture(): Fixture {
  const phone = { 正常: 0, 异常: 0, 空白: 0 };
  const city: Record<string, number> = { 上海: 0, 北京: 0, 广州: 0, 深圳: 0 };
  const cities = ['上海', '北京', '广州', '深圳'];
  const lines = ['name,phone,city'];
  for (let i = 0; i < 120; i += 1) {
    let phoneValue = '';
    const kind = i % 5;
    if (kind === 0) {
      phone.空白 += 1;
    } else if (kind === 1) {
      phoneValue = `1380000${String(i).padStart(4, '0')}`;
      phone.异常 += 1;
    } else {
      phoneValue = `139${String(10000000 + i).slice(-8)}`;
      phone.正常 += 1;
    }
    const cityName = cities[i % 4];
    city[cityName] += 1;
    lines.push(`客户${String(i + 1).padStart(3, '0')},${phoneValue},${cityName}`);
  }
  return { csv: `${lines.join('\n')}\n`, rows: 120, phone, city };
}

function generativeUiSource(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'src/host/prompts/generativeUI.ts'), 'utf8');
}

function evaluatedGenerativeUi(source: string): string {
  const marker = 'export const GENERATIVE_UI_PROMPT = applyOverride(';
  const start = source.indexOf(marker);
  const open = source.indexOf('`', start);
  const close = source.indexOf('`.trim()', open);
  if (start < 0 || open < 0 || close < 0) {
    throw new Error('cannot locate GENERATIVE_UI_PROMPT template');
  }
  return source.slice(open + 1, close).replace(/\\`/g, '`').trim();
}

function controlPrompt(full: string): string {
  if (!full.includes(RULE_LINE)) throw new Error('default prompt is missing the chart-number rule');
  const lines = full.split('\n').filter((line) => line !== RULE_LINE);
  const text = lines.join('\n');
  if (text.includes('禁止手打数字')) throw new Error('control prompt still contains the new rule');
  if (!text.includes('### 图表输出规则')) throw new Error('control prompt lost the chart-output section');
  return text;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function labelOf(record: Record<string, unknown>, xKey: string): string {
  const keys = [xKey, 'name', 'label', 'category', '城市', '状态'].filter((key) => key.length > 0);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numbersFromSpec(spec: Record<string, unknown>): Array<{ label: string; value: number }> {
  const data = Array.isArray(spec.data) ? spec.data : [];
  const xKey = typeof spec.xKey === 'string' ? spec.xKey : '';
  const series = Array.isArray(spec.series) ? spec.series : [];
  const valueKeys = series.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const key = (item as Record<string, unknown>).key;
    return typeof key === 'string' ? [key] : [];
  });
  const found: Array<{ label: string; value: number }> = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const label = labelOf(record, xKey);
    if (!label) continue;
    if (valueKeys.length > 0) {
      for (const key of valueKeys) {
        const value = asNumber(record[key]);
        if (value !== null) found.push({ label, value });
      }
      continue;
    }
    const direct = asNumber(record.value);
    if (direct !== null) {
      found.push({ label, value: direct });
      continue;
    }
    for (const [key, raw] of Object.entries(record)) {
      if (key === xKey || key === 'name' || key === 'color' || key === 'label') continue;
      const value = asNumber(raw);
      if (value !== null) {
        found.push({ label, value });
        break;
      }
    }
  }
  return found;
}

function chartNumbers(reply: string): Array<{ label: string; value: number }> {
  const found: Array<{ label: string; value: number }> = [];
  const re = /```chart\s*([\s\S]*?)```/g;
  for (const match of reply.matchAll(re)) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (parsed && typeof parsed === 'object') found.push(...numbersFromSpec(parsed as Record<string, unknown>));
    } catch {
      /* 坏掉的图表块不提供数字 */
    }
  }
  return found;
}

function wholeToken(haystack: string, value: number): boolean {
  const token = String(value);
  return new RegExp(`(?:^|[^0-9])${token}(?:[^0-9]|$)`).test(haystack);
}

/**
 * r1 实测翻车点：Read 工具输出带 `    96\t客户096,...` 行号槽，121 行 CSV 让
 * ≤121 的任何数字都整词命中，对照组 3 号跑的 (b) 就是被行号槽假放行的。
 * 只剥 `^\s*\d+\t` 槽前缀，内容列里的数字原样保留。
 */
function stripReadGutters(output: string): string {
  return output
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

function argsOf(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { command: input };
    }
  }
  return {};
}

function normalizeTools(raw: unknown[]): ToolExecution[] {
  return raw.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = String(record.tool ?? record.name ?? '');
    const denied = record.permissionDenied === true;
    return {
      name,
      args: argsOf(record.input ?? record.arguments),
      output: typeof record.output === 'string' ? record.output : JSON.stringify(record.output ?? ''),
      executed: !denied,
    };
  });
}

function scriptSources(tools: ToolExecution[]): string[] {
  const writes: Array<{ index: number; base: string; content: string }> = [];
  const sources: string[] = [];
  tools.forEach((tool, index) => {
    if (!tool.executed) return;
    const name = tool.name.toLowerCase();
    if (name === 'write') {
      const filePath = String(tool.args.file_path ?? tool.args.path ?? '');
      writes.push({ index, base: path.basename(filePath), content: String(tool.args.content ?? '') });
    }
    if (name === 'bash') {
      const command = String(tool.args.command ?? '');
      const prior = writes.filter((write) => write.index < index && write.base.length > 0 && command.includes(write.base));
      sources.push([command, ...prior.map((write) => write.content)].join('\n'));
    }
  });
  return sources;
}

function referencesColumn(source: string, aliases: string[]): boolean {
  return aliases.some((alias) => (
    /^[A-Za-z_]+$/.test(alias)
      ? new RegExp(`\\b${alias}\\b`).test(source)
      : source.includes(alias)
  ));
}

function hasAggregation(source: string): boolean {
  return AGGREGATION_PATTERNS.some((pattern) => pattern.test(source));
}

function checkToolTokens(numbers: number[], outputs: string[]): Check {
  if (!CHECK_B_ENABLED) return { pass: true, reason: 'check (b) disabled' };
  if (numbers.length === 0) return { pass: false, reason: 'no chart number for this series' };
  const missing = numbers.filter((value) => !outputs.some((output) => wholeToken(output, value)));
  if (missing.length > 0) return { pass: false, reason: `missing whole-token ${missing.join(',')}` };
  return { pass: true, reason: 'every number is a whole token in a tool output' };
}

function checkAggregation(series: SeriesDef, sources: string[]): Check {
  const hit = sources.some((source) => referencesColumn(source, series.aliases) && hasAggregation(source));
  if (!hit) {
    return { pass: false, reason: `no executed script references ${series.column} and an aggregation` };
  }
  return { pass: true, reason: `executed script references ${series.column} and an aggregation` };
}

function judge(reply: string, tools: ToolExecution[]): { series: SeriesResult[]; global: Check } {
  const labeled = chartNumbers(reply);
  const outputs = tools.filter((tool) => tool.executed).map((tool) => stripReadGutters(tool.output));
  const sources = scriptSources(tools);
  const series = SERIES.map((seriesDef) => {
    const numbers = labeled
      .filter((item) => seriesDef.patterns.some((pattern) => pattern.test(item.label)))
      .map((item) => item.value);
    const a: Check = numbers.length > 0
      ? { pass: true, reason: `parsed ${numbers.join(',')}` }
      : { pass: false, reason: 'chart spec has no number for this series' };
    const b = checkToolTokens(numbers, outputs);
    const c = checkAggregation(seriesDef, sources);
    return { id: seriesDef.id, numbers, pass: a.pass && b.pass && c.pass, checks: { a, b, c } };
  });
  // global 门与 check (b) 同源同开关：图表 spec 里每个数字（含未定义系列的切片，
  // 如三分类跑的 无效 片）都必须整词出现在某次工具输出里。FB-225 的 65/72/48 就死在这。
  let globalCheck: Check;
  if (!CHECK_B_ENABLED) {
    globalCheck = { pass: true, reason: 'check (b) disabled' };
  } else {
    const missing = [...new Set(labeled.filter((item) => !outputs.some((output) => wholeToken(output, item.value))).map((item) => item.value))];
    globalCheck = missing.length > 0
      ? { pass: false, reason: `chart numbers absent from tool outputs: ${missing.join(',')}` }
      : { pass: true, reason: `all ${new Set(labeled.map((item) => item.value)).size} distinct chart numbers are whole tokens in tool outputs` };
  }
  return { series, global: globalCheck };
}

function chartBlock(type: 'pie' | 'bar', rows: Array<{ name: string; value: number }>): string {
  if (type === 'pie') {
    return ['```chart', JSON.stringify({
      type: 'pie',
      title: '手机号状态',
      data: rows.map((row) => ({ name: row.name, value: row.value })),
    }, null, 2), '```'].join('\n');
  }
  return ['```chart', JSON.stringify({
    type: 'bar',
    title: '城市分布',
    xKey: 'city',
    series: [{ key: 'count', name: '数量' }],
    data: rows.map((row) => ({ city: row.name, count: row.value })),
  }, null, 2), '```'].join('\n');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selfCheck(): void {
  const source = generativeUiSource();
  assert(source.includes(RULE_LINE), 'self-check failed: generativeUI.ts is missing the rule line');
  const full = evaluatedGenerativeUi(source);
  assert(full.includes('```chart'), 'self-check failed: evaluated prompt lost chart fences');
  const control = controlPrompt(full);
  assert(control.includes('不要同时使用两种方式输出同一个图表'), 'self-check failed: control prompt dropped a neighbour bullet');

  const fixture = buildFixture();
  assert(fixture.rows === 120, 'self-check failed: fixture is not 120 rows');
  assert(fixture.phone.正常 === 72 && fixture.phone.异常 === 24 && fixture.phone.空白 === 24, 'self-check failed: phone split drifted');
  assert(fixture.city.上海 === 30 && fixture.city.北京 === 30, 'self-check failed: city split drifted');
  const anomalous = fixture.csv.split('\n').filter((line) => line.includes('1380000'));
  assert(anomalous.length === 24, 'self-check failed: anomalous phone count drifted');
  const valid = fixture.csv.split('\n').filter((line) => line.includes(',139'));
  assert(valid.every((line) => !line.split(',')[1].startsWith('1380000')), 'self-check failed: a valid phone starts with 1380000');

  const cityRows = (['上海', '北京', '广州', '深圳'] as const).map((name) => ({ name, value: fixture.city[name] }));
  const goodScript = [
    'import csv',
    'from collections import Counter',
    'rows = list(csv.DictReader(open("customers.csv")))',
    'phone_counts = Counter("有手机号" if (r["phone"] or "").strip() else "缺失手机号" for r in rows)',
    'city_counts = Counter(r["city"] for r in rows)',
    'for name, n in phone_counts.items():',
    '    print(name, n)',
    'for name, n in city_counts.items():',
    '    print(name, n)',
  ].join('\n');

  // 好样例 g1：二分饼（r1 真模型 6/6 的形态），数字全部来自脚本打印。
  const filled = fixture.phone.正常 + fixture.phone.异常;
  const g1 = judge(
    [
      chartBlock('pie', [
        { name: '已填写', value: filled },
        { name: '缺失', value: fixture.phone.空白 },
      ]),
      chartBlock('bar', cityRows),
    ].join('\n'),
    [
      { name: 'Write', args: { file_path: 'analyze.py', content: goodScript }, output: 'wrote analyze.py', executed: true },
      { name: 'Bash', args: { command: 'python3 analyze.py' }, output: `已填写 ${filled}\n缺失 ${fixture.phone.空白}\n${cityRows.map((row) => `${row.name} ${row.value}`).join('\n')}`, executed: true },
    ],
  );
  for (const series of g1.series) {
    assert(series.pass, `self-check failed: good sample g1 ${series.id} rejected (${series.checks.a.reason}; ${series.checks.b.reason}; ${series.checks.c.reason})`);
  }
  assert(g1.global.pass, `self-check failed: good sample g1 rejected by the global gate (${g1.global.reason})`);

  // 好样例 g2：三分类饼（FB-225 事件形态）。异常片不在系列表里，由 global 门核对。
  const g2 = judge(
    [
      chartBlock('pie', [
        { name: '正常', value: fixture.phone.正常 },
        { name: '异常', value: fixture.phone.异常 },
        { name: '空白', value: fixture.phone.空白 },
      ]),
      chartBlock('bar', cityRows),
    ].join('\n'),
    [
      { name: 'Write', args: { file_path: 'analyze.py', content: goodScript }, output: 'wrote analyze.py', executed: true },
      { name: 'Bash', args: { command: 'python3 analyze.py' }, output: `正常 ${fixture.phone.正常}\n异常 ${fixture.phone.异常}\n空白 ${fixture.phone.空白}\n${cityRows.map((row) => `${row.name} ${row.value}`).join('\n')}`, executed: true },
    ],
  );
  for (const series of g2.series) {
    assert(series.pass, `self-check failed: good sample g2 ${series.id} rejected (${series.checks.a.reason}; ${series.checks.b.reason}; ${series.checks.c.reason})`);
  }
  assert(g2.global.pass, `self-check failed: good sample g2 rejected by the global gate (${g2.global.reason})`);

  const badReply = [
    chartBlock('pie', [
      { name: '正常', value: 24 },
      { name: '异常', value: 31 },
      { name: '空白', value: 65 },
    ]),
    chartBlock('bar', [
      { name: '上海', value: 72 },
      { name: '北京', value: 48 },
    ]),
  ].join('\n');

  // 坏样例 1（台账原样）：脚本只打印总数和异常数，列都不碰。(b)、(c) 都得红。
  const bad1 = judge(badReply, [
    {
      name: 'Bash',
      args: { command: 'python3 -c "print(120); print(31)"' },
      output: 'noise 1240\n120\n31\n',
      executed: true,
    },
  ]);
  const rejectOn = (sample: { series: SeriesResult[]; global: Check }, label: string): void => {
    const accepted = sample.series.every((series) => series.pass) && sample.global.pass;
    assert(!accepted, `self-check failed: ${label} was accepted by the judge (mutation pivot went silent)`);
  };
  rejectOn(bad1, 'bad sample 1');
  const byId1 = new Map(bad1.series.map((series) => [series.id, series]));
  for (const id of EXTRA_SERIES) {
    const series = byId1.get(id);
    assert(series, `self-check failed: missing series ${id}`);
    assert(!series.checks.b.pass, `self-check failed: bad sample 1 series ${id} was accepted by check (b)`);
    assert(!series.checks.c.pass, `self-check failed: bad sample 1 series ${id} was accepted by check (c)`);
  }
  assert(!bad1.global.pass, 'self-check failed: bad sample 1 passed the global gate');
  assert(/65/.test(bad1.global.reason) && /72/.test(bad1.global.reason) && /48/.test(bad1.global.reason), 'self-check failed: global gate did not name the fabricated numbers');

  // 坏样例 2（FB-225 事件形态）：脚本真的做了各系列聚合，但只打印总数和异常数，
  // 饼图柱图的其余数字是手打的。(c) 全绿，(b) 与 global 门必须红——反向变异的支点。
  const bad2Script = [
    'import pandas as pd',
    'df = pd.read_csv("customers.csv")',
    'phone_counts = df["phone"].isna().value_counts()',
    'city_counts = df["city"].value_counts()',
    'print(len(df))',
    'print(31)',
  ].join('\n');
  const bad2 = judge(badReply, [
    { name: 'Write', args: { file_path: 'clean.py', content: bad2Script }, output: 'wrote clean.py', executed: true },
    { name: 'Bash', args: { command: 'python3 clean.py' }, output: '120\n31\n', executed: true },
  ]);
  rejectOn(bad2, 'bad sample 2');
  const byId2 = new Map(bad2.series.map((series) => [series.id, series]));
  for (const id of EXTRA_SERIES) {
    const series = byId2.get(id);
    assert(series, `self-check failed: missing series ${id} in bad sample 2`);
    assert(series.checks.a.pass, `self-check failed: bad sample 2 series ${id} lost its parsed number`);
    assert(series.checks.c.pass, `self-check failed: bad sample 2 series ${id} should pass (c); the script does aggregate ${id}`);
    assert(!series.checks.b.pass, `self-check failed: bad sample 2 series ${id} was accepted by check (b)`);
  }
  assert(!bad2.global.pass, 'self-check failed: bad sample 2 passed the global gate');

  // 行号槽必须剥掉：带 Read 行号的输出不能替手打数字顶包。
  const guttered = judge(badReply, [
    { name: 'Read', args: { file_path: 'customers.csv' }, output: `     1\tname,phone,city\n    24\t客户024,,上海\n    31\t客户031,13800000031,北京\n    65\t客户065,13910000065,上海\n    72\t客户072,13910000072,北京\n    48\t客户048,13910000048,深圳\n   120\t客户120,13910000120,深圳\n`, executed: true },
  ]);
  assert(!guttered.global.pass, 'self-check failed: line-number gutters leaked into the whole-token check');
  assert(!guttered.series.every((series) => series.pass), 'self-check failed: a guttered Read satisfied every series');

  console.log('self-check passed: g1/g2 accepted in full; bad 1 rejected on (b)+(c); bad 2 rejected on (b)/global; gutter leak plugged');
}

function keyState(name: string): 'set' | 'unset' {
  return process.env[name] && process.env[name]?.trim() ? 'set' : 'unset';
}

function printKeyStates(): void {
  for (const name of ['DEEPSEEK_API_KEY', 'STEPFUN_API_KEY', 'MOONSHOT_API_KEY', 'LONGCAT_API_KEY']) {
    console.log(`${name}: ${keyState(name)}`);
  }
}

async function probe(url: string, apiKey: string, model: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: controller.signal,
    });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveModel(): Promise<ModelChoice> {
  printKeyStates();
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
  if (deepseekKey) {
    const status = await probe('https://api.deepseek.com/v1/chat/completions', deepseekKey, 'deepseek-v4-flash');
    console.log(`deepseek probe: HTTP ${status}`);
    if (status >= 200 && status < 300) {
      return {
        id: 'deepseek',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        apiKey: deepseekKey,
        price: {
          input: 0.3,
          cached: 0.006,
          output: 1.2,
          note: 'DeepSeek V4.1 Flash list price: cache hit $0.006 / miss $0.30 / out $1.20 per 1M',
        },
      };
    }
  }
  const stepfunKey = process.env.STEPFUN_API_KEY?.trim() ?? '';
  if (stepfunKey) {
    const status = await probe(`${resolveStepfunBaseUrl()}/chat/completions`, stepfunKey, 'step-3.5-flash-2603');
    console.log(`stepfun probe: HTTP ${status}`);
    if (status >= 200 && status < 300) {
      return {
        id: 'stepfun',
        provider: 'custom-stepfun',
        model: 'step-3.5-flash-2603',
        baseUrl: resolveStepfunBaseUrl(),
        apiKey: stepfunKey,
        price: {
          input: 0,
          cached: 0,
          output: 0,
          note: 'Step Plan subscription (flat fee, per-token price 0)',
        },
      };
    }
  }
  const moonshotKey = process.env.MOONSHOT_API_KEY?.trim() ?? '';
  if (moonshotKey) {
    const status = await probe('https://api.moonshot.cn/v1/chat/completions', moonshotKey, 'kimi-k2.6');
    console.log(`moonshot probe: HTTP ${status}`);
    if (status >= 200 && status < 300) {
      return {
        id: 'moonshot',
        provider: 'moonshot',
        model: 'kimi-k2.6',
        apiKey: moonshotKey,
        price: { input: 0.6, cached: 0.15, output: 2.5, note: 'list price $0.60 in / $2.50 out per Mtok; cache read $0.15' },
      };
    }
  }
  const longcatKey = process.env.LONGCAT_API_KEY?.trim() ?? '';
  if (longcatKey) {
    const status = await probe('https://api.longcat.chat/openai/v1/chat/completions', longcatKey, 'LongCat-2.0');
    console.log(`longcat probe: HTTP ${status}`);
    if (status >= 200 && status < 300) {
      return {
        id: 'longcat',
        provider: 'longcat',
        model: 'LongCat-2.0',
        apiKey: longcatKey,
        price: { input: 0, cached: 0, output: 0, note: 'free quota, price 0; tokens still counted' },
      };
    }
  }
  throw new Error('no baseline model: every candidate key is unset or its 1-token probe failed');
}

function costUsd(usage: Usage, price: ModelChoice['price']): number {
  const uncached = Math.max(0, usage.promptTokens - usage.cacheReadTokens);
  return (uncached * price.input + usage.cacheReadTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function parseUsage(log: string): Usage | null {
  const clean = stripAnsi(log);
  const match = clean.match(/Actual usage \(process budget\):\s*([\d,]+)\s+prompt \(incl\.\s*([\d,]+)\s+cache read\)\s*\/\s*([\d,]+)\s+out tokens/);
  if (!match) return null;
  const num = (value: string) => Number(value.replace(/,/g, ''));
  return { promptTokens: num(match[1]), cacheReadTokens: num(match[2]), outputTokens: num(match[3]) };
}

function reportPath(log: string): string | null {
  const clean = stripAnsi(log);
  const match = clean.match(/Reports saved to:\s*(\S+\.md)/);
  if (!match) return null;
  return match[1].replace(/\.md$/, '.json');
}

function childEnv(dataDir: string, model: ModelChoice): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODE_AGENT_DATA_DIR: dataDir };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.NEO_SCRIPTED_APPROVAL_POLICY = path.join(REPO_ROOT, '.claude', 'eval-approval-policy.json');
  if (model.baseUrl) {
    env.AUTO_TEST_BASE_URL = model.baseUrl;
    env.AUTO_TEST_API_KEY = model.apiKey;
  } else {
    delete env.AUTO_TEST_BASE_URL;
    delete env.AUTO_TEST_API_KEY;
  }
  return env;
}

function spawnEval(args: string[], env: NodeJS.ProcessEnv, logPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(logPath);
    const child = spawn('npx', ['tsx', 'packages/internal/evaluation-center/scripts/eval-ci.ts', ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      out.end();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => resolve(code ?? 1));
    });
  });
}

function writeCase(caseDir: string, csvPath: string): void {
  const yaml = [
    'name: viz-numbers-from-code',
    'description: Chart numbers must come from executed code over the customer CSV',
    'default_timeout: 360000',
    'default_max_cost_usd: 0.40',
    'cases:',
    `  - id: ${CASE_ID}`,
    '    type: task',
    '    category: task_completion',
    '    difficulty: medium',
    '    description: Clean the customer table and chart phone status plus city counts',
    '    prompt: |-',
    '      工作目录里有 customers.csv（列 name, phone, city）。',
    `      ${TASK_SENTENCE}`,
    '    files:',
    `      - source: ${csvPath}`,
    '        dest: customers.csv',
    '    expect:',
    '      no_crash: true',
    '    expectations:',
    '      - type: no_crash',
    '        description: The run finishes without a fatal error',
    '        weight: 1',
    '        critical: false',
    '        params: {}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(caseDir, 'viz-numbers.yaml'), yaml, 'utf8');
}

function seriesFromReport(jsonPath: string): { series: SeriesResult[]; global: Check } {
  const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const summary = parsed as { results?: Array<{ responses?: string[]; toolExecutions?: unknown[] }> };
  const result = summary.results?.[0];
  if (!result) throw new Error(`eval report has no result: ${path.basename(jsonPath)}`);
  const reply = (result.responses ?? []).join('\n');
  const tools = normalizeTools(result.toolExecutions ?? []);
  return judge(reply, tools);
}

async function oneRun(arm: RunRecord['arm'], index: number, model: ModelChoice, dataDir: string, caseDir: string): Promise<RunRecord> {
  const runId = `viz-numbers-${arm}-${index}-${Date.now()}`;
  const logPath = path.join(OUT_DIR, 'logs', `${runId}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const args = [
    '--real',
    '--scope', 'full',
    '--case-dir', caseDir,
    '--concurrency', '1',
    '--case-cost-limit', CASE_COST_LIMIT,
    '--max-cases', '1',
    '--ids', CASE_ID,
    '--run-id', runId,
    '--provider', model.provider,
    '--model', model.model,
  ];
  console.log(`run ${arm} #${index} id=${runId} provider=${model.provider} model=${model.model}`);
  const code = await spawnEval(args, childEnv(dataDir, model), logPath);
  const log = fs.readFileSync(logPath, 'utf8');
  const usage = parseUsage(log);
  if (!usage || (usage.promptTokens === 0 && usage.outputTokens === 0)) {
    const refusal = log.split('\n').filter((line) => /Error:|refuse|拒绝|case-dir|无法/.test(line)).slice(0, 20);
    console.error(refusal.join('\n'));
    throw new Error(`${arm} #${index} has no Actual usage (eval exit ${code})`);
  }
  const json = reportPath(log);
  if (!json || !fs.existsSync(json)) throw new Error(`${arm} #${index} did not write a JSON report`);
  const verdict = seriesFromReport(json);
  const usd = costUsd(usage, model.price);
  for (const item of verdict.series) {
    console.log(`  ${item.id} ${item.pass ? 'pass' : 'fail'} a=${item.checks.a.pass} b=${item.checks.b.pass} c=${item.checks.c.pass} numbers=${item.numbers.join('|') || '-'} (${item.checks.b.reason}; ${item.checks.c.reason})`);
  }
  const runPass = verdict.series.every((item) => item.pass) && verdict.global.pass;
  console.log(`  global ${verdict.global.pass ? 'pass' : 'fail'} (${verdict.global.reason}) → run ${runPass ? 'PASS' : 'FAIL'}`);
  console.log(`  tokens prompt=${usage.promptTokens} cacheRead=${usage.cacheReadTokens} out=${usage.outputTokens} usd=${usd.toFixed(6)}`);
  return { arm, runId, series: verdict.series, global: verdict.global, tokens: usage, usd, evalExit: code };
}

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function promptVersion(): string {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/shared/constants/agent.ts'), 'utf8');
  const match = source.match(/export const PROMPT_VERSION = '([^']+)'/);
  if (!match) throw new Error('PROMPT_VERSION missing');
  return match[1];
}

async function live(): Promise<void> {
  const policy = path.join(REPO_ROOT, '.claude', 'eval-approval-policy.json');
  if (!fs.existsSync(policy)) throw new Error('missing eval approval policy');
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), 'work', 'evalslot', '.code-agent-dev8');
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  const model = await resolveModel();
  console.log(`baseline: ${model.id} provider=${model.provider} model=${model.model}`);
  console.log(`price: ${model.price.note}`);
  const fixture = buildFixture();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, 'customers.csv');
  const caseDir = path.join(OUT_DIR, 'case');
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(csvPath, fixture.csv, 'utf8');
  writeCase(caseDir, csvPath);
  const overrideDir = path.join(dataDir, 'prompts-overrides');
  const overridePath = path.join(overrideDir, 'generativeUI.md');
  const backupPath = path.join(overrideDir, 'generativeUI.md.viz-bak');
  const hadOverride = fs.existsSync(overridePath);
  const runs: RunRecord[] = [];
  let spent = 0;
  let movedOverride = false;
  let wroteOverride = false;
  try {
    for (let index = 1; index <= 3; index += 1) {
      if (spent >= HARD_STOP_USD) throw new Error(`hard stop $${HARD_STOP_USD} before with-rule #${index}`);
      const run = await oneRun('with-rule', index, model, dataDir, caseDir);
      runs.push(run);
      spent += run.usd;
    }
    fs.mkdirSync(overrideDir, { recursive: true });
    if (hadOverride) {
      fs.renameSync(overridePath, backupPath);
      movedOverride = true;
    }
    fs.writeFileSync(overridePath, controlPrompt(evaluatedGenerativeUi(generativeUiSource())), 'utf8');
    wroteOverride = true;
    for (let index = 1; index <= 3; index += 1) {
      if (spent >= HARD_STOP_USD) throw new Error(`hard stop $${HARD_STOP_USD} before control #${index}`);
      const run = await oneRun('control', index, model, dataDir, caseDir);
      runs.push(run);
      spent += run.usd;
    }
  } finally {
    if (wroteOverride && fs.existsSync(overridePath)) fs.rmSync(overridePath);
    if (movedOverride && fs.existsSync(backupPath)) fs.renameSync(backupPath, overridePath);
  }
  const jsonPath = path.join(REPO_ROOT, JSON_REL);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const payload = {
    gitHead: gitHead(),
    promptVersion: promptVersion(),
    model: { provider: model.provider, model: model.model, price: model.price },
    controlArm: 'prompts-overrides/generativeUI.md with the new bullet removed; source file was not edited',
    seriesPolicy: 'phone-normal is the filled class (valid + the 1380000 batch; the baseline model reads phone status as filled/missing, r1 6/6 runs); every charted number, on any slice, is additionally gated by the global whole-token check',
    runs: runs.map((run) => ({
      arm: run.arm,
      runId: run.runId,
      evalExit: run.evalExit,
      runPass: run.series.every((series) => series.pass) && run.global.pass,
      tokens: run.tokens,
      usd: Number(run.usd.toFixed(6)),
      global: run.global,
      series: run.series.map((series) => ({
        id: series.id,
        pass: series.pass,
        numbers: series.numbers,
        a: series.checks.a,
        b: series.checks.b,
        c: series.checks.c,
      })),
    })),
    totalUsd: Number(spent.toFixed(6)),
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`wrote ${JSON_REL}`);
  console.log(`total usd ${spent.toFixed(6)}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return;
  }
  try {
    await live();
  } catch (error) {
    const jsonPath = path.join(REPO_ROOT, JSON_REL);
    if (fs.existsSync(jsonPath)) fs.rmSync(jsonPath);
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
