#!/usr/bin/env tsx
// ============================================================================
// 行为趋势板（N-EVAL-TWO-LAYER-METRICS Layer 2）—— 只报趋势，永不 gate PR
// ----------------------------------------------------------------------------
// 与 Layer 1（context-overhead-ratchet，确定性、gate CI）相对：本脚本读**已有**的
// 历史评测报告（report-*.json，写入位置见 eval-ci.ts persistRunReport / reportGenerator
// saveReport），对每个 case×run 提取轨迹计数（token / 工具调用 / 轮数 / 重试 / 错误恢复）
// 与分数，做两件事：
//   1. 相关性：每个计数与分数的 Spearman 相关（跨 case 用 per-case 中位数；case 内
//      配对用同 case 多 run），|ρ| 达阈值且样本足够的计数才进板——不跟踪分数的计数
//      被剔除并写明（抛掉不相关的 proxy，Anthropic "3x faster" 同款纪律）。
//   2. above-peers 清单：保留计数按 case 类目做同伴比较（Tukey 上围栏 Q3+1.5·IQR），
//      列出计数显著高于同类同伴的 case 及其分数——低分案件的定位从「只看分数」升级为
//      「读轨迹计数」。
//
// 数据口径（如实记录，不造数）：
//   - 只读报告 JSON，不读 SQLite 实验库（库内 per-case 无 token、工具数据只剩计数、
//     分数是 0-100 制，混读会引入两种口径；报告 JSON 是信息最全的单一真源）。
//   - mock 模型 run（environment.model === 'mock-model'）排除：mock harness 的分数
//     不是真模型行为信号。
//   - skipped / not_run / infra_excluded / cost_exceeded 无轨迹语义，排除。
//   - token 只在 2026-09 后的报告里有（usage 字段），样本量单独如实报告，不足即剔除。
//   - 「重试」报告里没有现成字段，用可复算的代理：紧邻的同工具再调用（前一次失败）；
//     「错误恢复」= 同一工具先失败后成功（每工具计一次）。
//   - 类目来自当前 case bank（.claude/test-cases/*.yaml 的 cases[].category）；
//     历史 run 里 caseMeta.category 几乎没有值（205 份报告只有 28 行），按 id 回join，
//     join 不上的归 (unbanked)（含已退役 case）。
// 本脚本永远 exit 0（除参数/结构错误），产 JSON + Markdown 到 --out（默认本包
// reports/trend-board/，该目录 gitignore，属机器本地历史数据派生物）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

// —— 报告 JSON 形状（真源：src/host/testing/types.ts 的 TestRunSummary / TestResult，
//    此处只声明本脚本消费的字段，字段漂移时宁可解析失败也别静默读空） ——————————

interface ToolExecutionRecord {
  tool: string;
  success: boolean;
}

interface ReportResult {
  testId: string;
  status: string;
  score: number | null;
  turnCount?: number;
  errors?: string[];
  toolExecutions?: ToolExecutionRecord[];
  usage?: { totalTokens?: number };
  caseMeta?: { category?: string };
}

interface ReportFile {
  environment?: { model?: string; provider?: string };
  results?: ReportResult[];
}

interface CaseRow {
  caseId: string;
  run: string;
  model: string;
  category: string | null;
  score: number;
  totalTokens: number | null;
  toolCalls: number;
  turnCount: number;
  retries: number;
  errorRecoveries: number;
}

const METRICS = ['totalTokens', 'toolCalls', 'turnCount', 'retries', 'errorRecoveries'] as const;
type MetricName = (typeof METRICS)[number];

const METRIC_LABELS: Record<MetricName, string> = {
  totalTokens: '总 token',
  toolCalls: '工具调用数',
  turnCount: '轮数（turnCount）',
  retries: '重试（同工具紧邻再调用）',
  errorRecoveries: '错误恢复（失败后同工具成功）',
};

const EXCLUDED_STATUSES = new Set(['skipped', 'not_run', 'infra_excluded', 'cost_excluded']);
const MOCK_MODEL = 'mock-model';
/** 进板门槛：跨 case 相关的最低样本（case 数）与最低 |ρ|；不足即剔除并写明 */
const CORRELATION_MIN_CASES = 20;
const CORRELATION_MIN_ABS_RHO = 0.3;
/** 同类目做围栏的最低 case 数 */
const PEER_MIN_CATEGORY_CASES = 5;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(packageRoot, '../../..');

function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of empty');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/** 平均秩处理并列的 Spearman ρ */
function spearman(xs: number[], ys: number[]): number {
  const rank = (values: number[]): number[] => {
    const indexed = values.map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
      const average = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = average;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k += 1) {
    num += (rx[k] - meanX) * (ry[k] - meanY);
    dx += (rx[k] - meanX) ** 2;
    dy += (ry[k] - meanY) ** 2;
  }
  if (dx === 0 || dy === 0) return 0; // 一侧全并列：无单调信息，按 0 处理
  return num / Math.sqrt(dx * dy);
}

function countRetries(executions: ToolExecutionRecord[]): number {
  let retries = 0;
  for (let i = 1; i < executions.length; i += 1) {
    if (!executions[i - 1].success && executions[i].tool === executions[i - 1].tool) retries += 1;
  }
  return retries;
}

function countErrorRecoveries(executions: ToolExecutionRecord[]): number {
  const seenFail = new Set<string>();
  const recovered = new Set<string>();
  for (const exec of executions) {
    if (!exec.success) seenFail.add(exec.tool);
    else if (seenFail.has(exec.tool)) recovered.add(exec.tool);
  }
  return recovered.size;
}

/** 从当前 case bank join 类目（id → category；join 不上返回 null） */
function loadCategoryMap(): Map<string, string> {
  const dir = path.join(repoRoot, '.claude/test-cases');
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  const walk = (current: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) out.push(...walk(file));
      else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) out.push(file);
    }
    return out;
  };
  for (const file of walk(dir)) {
    const data = yaml.load(fs.readFileSync(file, 'utf8')) as { cases?: Array<{ id?: string; category?: string }> } | null;
    for (const testCase of data?.cases ?? []) {
      if (testCase.id) map.set(testCase.id, testCase.category ?? '(未标注)');
    }
  }
  return map;
}

function collectRows(reportsDir: string, categoryMap: Map<string, string>): { rows: CaseRow[]; runsRead: number; runsMock: number; runsUnparsable: number } {
  const rows: CaseRow[] = [];
  let runsRead = 0;
  let runsMock = 0;
  let runsUnparsable = 0;
  if (!fs.existsSync(reportsDir)) return { rows, runsRead, runsMock, runsUnparsable };
  const files = fs.readdirSync(reportsDir).filter((name) => /^report-.*\.json$/.test(name) && name !== 'latest-report.json').sort();
  for (const file of files) {
    let report: ReportFile;
    try {
      report = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8')) as ReportFile;
    } catch {
      runsUnparsable += 1;
      continue;
    }
    if (report.environment?.model === MOCK_MODEL) {
      runsMock += 1;
      continue;
    }
    runsRead += 1;
    for (const result of report.results ?? []) {
      if (EXCLUDED_STATUSES.has(result.status)) continue;
      if (typeof result.score !== 'number') continue;
      const executions = result.toolExecutions ?? [];
      rows.push({
        caseId: result.testId,
        run: file,
        model: report.environment?.model ?? '(unknown)',
        category: categoryMap.get(result.testId) ?? result.caseMeta?.category ?? null,
        score: result.score,
        totalTokens: typeof result.usage?.totalTokens === 'number' ? result.usage.totalTokens : null,
        toolCalls: executions.length,
        turnCount: result.turnCount ?? 0,
        retries: countRetries(executions),
        errorRecoveries: countErrorRecoveries(executions),
      });
    }
  }
  return { rows, runsRead, runsMock, runsUnparsable };
}

interface CorrelationEntry {
  metric: MetricName;
  acrossCasesRho: number;
  acrossCasesN: number;
  withinCaseMedianRho: number | null;
  withinCaseN: number;
  kept: boolean;
  decision: string;
}

function correlate(rows: CaseRow[]): CorrelationEntry[] {
  const byCase = new Map<string, CaseRow[]>();
  for (const row of rows) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, []);
    byCase.get(row.caseId)!.push(row);
  }
  const entries: CorrelationEntry[] = [];
  for (const metric of METRICS) {
    const perCase = [...byCase.values()]
      .map((caseRows) => caseRows.filter((row) => metric !== 'totalTokens' || row.totalTokens !== null))
      .filter((caseRows) => caseRows.length > 0)
      .map((caseRows) => ({
        metricMedian: median(caseRows.map((row) => metric === 'totalTokens' ? row.totalTokens! : row[metric] as number)),
        scoreMedian: median(caseRows.map((row) => row.score)),
      }));
    const acrossRho = perCase.length >= 3
      ? spearman(perCase.map((point) => point.metricMedian), perCase.map((point) => point.scoreMedian))
      : 0;
    // case 内配对（同 case 多 run、计数有波动才算相关样本）
    const withinCaseRhos: number[] = [];
    for (const caseRows of byCase.values()) {
      const usable = caseRows.filter((row) => metric !== 'totalTokens' || row.totalTokens !== null);
      if (usable.length < 4) continue;
      const xs = usable.map((row) => metric === 'totalTokens' ? row.totalTokens! : row[metric] as number);
      if (new Set(xs).size < 2) continue;
      withinCaseRhos.push(spearman(xs, usable.map((row) => row.score)));
    }
    const withinMedian = withinCaseRhos.length > 0 ? median(withinCaseRhos) : null;
    let kept = false;
    let decision: string;
    if (perCase.length < CORRELATION_MIN_CASES) {
      decision = `剔除：样本不足（${perCase.length} 个 case < ${CORRELATION_MIN_CASES}）`;
    } else if (Math.abs(acrossRho) < CORRELATION_MIN_ABS_RHO) {
      decision = `剔除：|ρ|=${Math.abs(acrossRho).toFixed(3)} < ${CORRELATION_MIN_ABS_RHO}，不跟踪分数，进板只会制造噪音`;
    } else {
      kept = true;
      decision = `保留：ρ=${acrossRho.toFixed(3)}（${acrossRho < 0 ? '计数越高分越低' : '计数越高分越高'}），n=${perCase.length}`;
    }
    entries.push({
      metric,
      acrossCasesRho: acrossRho,
      acrossCasesN: perCase.length,
      withinCaseMedianRho: withinMedian,
      withinCaseN: withinCaseRhos.length,
      kept,
      decision,
    });
  }
  return entries;
}

interface BoardRow {
  metric: MetricName;
  caseId: string;
  category: string;
  metricMedian: number;
  fence: number;
  scoreMedian: number;
  runs: number;
  models: string[];
}

function buildBoard(rows: CaseRow[], keptMetrics: MetricName[]): BoardRow[] {
  const byCase = new Map<string, CaseRow[]>();
  for (const row of rows) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, []);
    byCase.get(row.caseId)!.push(row);
  }
  const board: BoardRow[] = [];
  for (const metric of keptMetrics) {
    const byCategory = new Map<string, Array<{ caseId: string; metricMedian: number; scoreMedian: number; runs: number; models: string[] }>>();
    for (const [caseId, caseRows] of byCase) {
      const usable = caseRows.filter((row) => metric !== 'totalTokens' || row.totalTokens !== null);
      if (usable.length === 0) continue;
      const category = caseRows[0].category ?? '(unbanked)';
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category)!.push({
        caseId,
        metricMedian: metric === 'totalTokens'
          ? median(usable.map((row) => row.totalTokens!))
          : median(usable.map((row) => row[metric] as number)),
        scoreMedian: median(usable.map((row) => row.score)),
        runs: usable.length,
        models: [...new Set(usable.map((row) => row.model))].sort(),
      });
    }
    for (const [category, cases] of byCategory) {
      if (cases.length < PEER_MIN_CATEGORY_CASES) continue;
      const sorted = cases.map((entry) => entry.metricMedian).sort((a, b) => a - b);
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const fence = q3 + 1.5 * (q3 - q1);
      for (const entry of cases) {
        if (entry.metricMedian > fence) {
          board.push({ metric, category, ...entry, fence: Math.round(fence * 100) / 100 });
        }
      }
    }
  }
  return board.sort((a, b) => a.metric.localeCompare(b.metric) || a.caseId.localeCompare(b.caseId));
}

function formatMarkdown(coverage: Record<string, number>, correlations: CorrelationEntry[], board: BoardRow[]): string {
  const lines: string[] = [];
  lines.push('# 行为趋势板（eval trend board）');
  lines.push('');
  lines.push(`生成：${new Date().toISOString()} · 数据：${coverage.runsRead} 个非 mock run / ${coverage.rows} 行 case×run / ${coverage.mockRuns} 个 mock run 已排除 / ${coverage.unparsable} 份不可解析报告`);
  lines.push('');
  lines.push('> 趋势板只用于定位，永不 gate PR。分数 0–1，计数均为 per-case 中位数（N run）。');
  lines.push('');
  lines.push('## 相关性（计数 vs 分数，Spearman）');
  lines.push('');
  lines.push('| 计数 | 跨 case ρ | n(case) | case 内中位 ρ | n(配对) | 判定 |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const entry of correlations) {
    lines.push(`| ${METRIC_LABELS[entry.metric]} | ${entry.acrossCasesRho.toFixed(3)} | ${entry.acrossCasesN} | ${entry.withinCaseMedianRho === null ? '—' : entry.withinCaseMedianRho.toFixed(3)} | ${entry.withinCaseN} | ${entry.decision} |`);
  }
  lines.push('');
  lines.push('## above-peers 清单（计数显著高于同类目同伴：中位数 > Tukey 上围栏 Q3+1.5·IQR）');
  lines.push('');
  if (board.length === 0) {
    lines.push('（当前数据下无 above-peers 案件）');
  } else {
    lines.push('| 计数 | case | 类目 | 中位计数 | 类目围栏 | 分数中位 | run 数 | 模型 |');
    lines.push('|---|---|---|---:|---:|---:|---:|---|');
    for (const row of board) {
      lines.push(`| ${METRIC_LABELS[row.metric]} | ${row.caseId} | ${row.category} | ${row.metricMedian} | ${row.fence} | ${row.scoreMedian.toFixed(2)} | ${row.runs} | ${row.models.join(', ')} |`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const reportsDir = path.resolve(option('--reports', path.join(repoRoot, '.code-agent/test-results')));
  const outDir = path.resolve(option('--out', path.join(packageRoot, 'reports/trend-board')));

  const categoryMap = loadCategoryMap();
  const { rows, runsRead, runsMock, runsUnparsable } = collectRows(reportsDir, categoryMap);
  const coverage = { rows: rows.length, runsRead, mockRuns: runsMock, unparsable: runsUnparsable };
  console.log(`[eval-trend-board] 报告目录 ${reportsDir}`);
  console.log(`[eval-trend-board] case bank 类目 ${categoryMap.size} 条；数据 ${rows.length} 行 case×run（${runsRead} 个非 mock run，${runsMock} 个 mock run 排除，${runsUnparsable} 份不可解析）`);
  if (rows.length === 0) {
    console.log('[eval-trend-board] 没有可读的历史报告，趋势板为空（本脚本只读已有数据，不发起评测）');
    return;
  }

  const correlations = correlate(rows);
  console.log('[eval-trend-board] 相关性（Spearman，计数 vs 分数）：');
  for (const entry of correlations) {
    console.log(`  ${METRIC_LABELS[entry.metric].padEnd(18)} ρ=${entry.acrossCasesRho.toFixed(3).padStart(6)} n=${String(entry.acrossCasesN).padStart(4)}  case内中位ρ=${entry.withinCaseMedianRho === null ? '  —  ' : entry.withinCaseMedianRho.toFixed(3)}  ${entry.decision}`);
  }

  const keptMetrics = correlations.filter((entry) => entry.kept).map((entry) => entry.metric);
  const board = buildBoard(rows, keptMetrics);
  console.log(`[eval-trend-board] above-peers 清单（保留计数 ${keptMetrics.length}/${METRICS.length} 项参与同伴比较）：`);
  if (board.length === 0) {
    console.log('  （当前数据下无 above-peers 案件）');
  } else {
    for (const row of board) {
      console.log(`  [${METRIC_LABELS[row.metric]}] ${row.caseId}（${row.category}）中位 ${row.metricMedian} > 围栏 ${row.fence}，分数中位 ${row.scoreMedian.toFixed(2)}，${row.runs} run，模型 ${row.models.join('/')}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    reportsDir,
    coverage,
    thresholds: { CORRELATION_MIN_CASES, CORRELATION_MIN_ABS_RHO, PEER_MIN_CATEGORY_CASES },
    correlations,
    board,
  };
  const jsonPath = path.join(outDir, 'trend-board.json');
  const mdPath = path.join(outDir, 'trend-board.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(mdPath, `${formatMarkdown(coverage, correlations, board)}\n`);
  console.log(`[eval-trend-board] ✓ 已写出 ${path.relative(repoRoot, jsonPath)} 与 ${path.relative(repoRoot, mdPath)}`);
}

await main();
