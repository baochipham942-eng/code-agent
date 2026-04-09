// ============================================================================
// Proposal Generator — Self-Evolving v2.5 Phase 4
//
// Closes the self-evolving loop by auto-drafting Proposal files from the
// aggregate failure_attribution data in ~/.claude/grader-reports/. For the
// top-N root-cause categories (by count across recent reports), writes a
// template Proposal to ~/.claude/proposals/ with:
//
//   - hypothesis = "Agent 应当减少 <category> 类失败"
//   - target_metric = "<category> 根因出现次数下降 >= 50%"
//   - rollback_condition = "session 成功率下降 > 5pp"
//   - rule_content = an editable draft based on category + representative
//                     root_cause_summary sampled from the reports
//
// Output: writes proposal files, prints their paths and seed stats.
// Usage:  npx tsx scripts/proposal-generate.ts [--top N] [--dry-run]
//
// The generator is deliberately non-LLM; drafts are starting points for the
// human to refine before running `npm run proposal -- eval <id>`.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeProposal, generateProposalId, defaultProposalsDir } from '../src/main/evaluation/proposals';
import type { Proposal } from '../src/main/evaluation/proposals';

interface ReportAttribution {
  category: string;
  summary: string;
  sessionId?: string;
  relatedRegressionCases: string[];
}

interface CategoryCluster {
  category: string;
  count: number;
  samples: ReportAttribution[];
  relatedRegressionCases: Set<string>;
}

function defaultGraderReportsDir(): string {
  return path.join(os.homedir(), '.claude', 'grader-reports');
}

async function loadRecentAttributions(
  dir: string,
  limit: number
): Promise<ReportAttribution[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));

  // Sort by filename desc (convention YYYY-MM-DD-... so lex sort ≈ recency).
  jsonFiles.sort((a, b) => (a < b ? 1 : -1));
  const take = jsonFiles.slice(0, limit);

  const out: ReportAttribution[] = [];
  for (const file of take) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as {
        session_id?: string;
        failure_attribution?: {
          root_cause_category?: string;
          root_cause_summary?: string;
          related_regression_cases?: string[];
        };
      };
      const attr = parsed.failure_attribution;
      if (!attr?.root_cause_category) continue;
      out.push({
        category: attr.root_cause_category,
        summary: attr.root_cause_summary ?? '',
        sessionId: parsed.session_id,
        relatedRegressionCases: attr.related_regression_cases ?? [],
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

function cluster(attributions: ReportAttribution[]): CategoryCluster[] {
  const map = new Map<string, CategoryCluster>();
  for (const a of attributions) {
    let c = map.get(a.category);
    if (!c) {
      c = {
        category: a.category,
        count: 0,
        samples: [],
        relatedRegressionCases: new Set(),
      };
      map.set(a.category, c);
    }
    c.count++;
    if (c.samples.length < 3) c.samples.push(a);
    for (const r of a.relatedRegressionCases) c.relatedRegressionCases.add(r);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const CATEGORY_RECIPES: Record<
  string,
  {
    hypothesis: (count: number) => string;
    metric: (category: string) => string;
    ruleDraftHeader: string;
    ruleDraftBullets: string[];
  }
> = {
  loop: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中出现工具重复调用循环，应当自我中断`,
    metric: () => 'loop 根因次数 >= 50% 下降（连续 2 次 synthesize 周期）',
    ruleDraftHeader: '防循环规则（待人工 refine）',
    ruleDraftBullets: [
      '当同一工具连续 3 次使用相似参数时，必须停止',
      '立即报告当前状态，重新评估任务路径',
      '禁止盲目重试；优先考虑替代工具或完全不同的方法',
    ],
  },
  tool_error: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中早期工具失败无修复，应当加强首错恢复`,
    metric: () => 'tool_error 根因次数 >= 40% 下降',
    ruleDraftHeader: '首错恢复规则（待人工 refine）',
    ruleDraftBullets: [
      '工具首次失败时必须诊断失败原因而非直接重试',
      '检查参数、前置条件、环境变量',
      '2 次修复失败后必须换路径或问用户',
    ],
  },
  env_failure: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中遇到环境/协议失败（API 错误、协议破坏），应当及早发现并 fail-fast`,
    metric: () => 'env_failure 根因次数 >= 50% 下降',
    ruleDraftHeader: '环境故障早报规则（待人工 refine）',
    ruleDraftBullets: [
      '识别明显的环境错误标志（API 400/500、协议字段缺失）',
      '不要重试环境级错误；立即报告',
      '检查 attribution 相关的已知 regression cases',
    ],
  },
  hallucination: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中出现幻觉型工具调用，应当强制引用原始观察结果`,
    metric: () => 'hallucination 根因次数 >= 60% 下降',
    ruleDraftHeader: '抗幻觉规则（待人工 refine）',
    ruleDraftBullets: [
      '工具结果必须被下一步明确引用或使用',
      '禁止在未观察输出的情况下重复相同调用',
      '如需确认，读取结果后再推进',
    ],
  },
  bad_decision: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中出现工具选择错误 / 参数错误，应当强化规划阶段`,
    metric: () => 'bad_decision 根因次数 >= 40% 下降',
    ruleDraftHeader: '决策质量规则（待人工 refine）',
    ruleDraftBullets: [
      '对多步任务先写一个 brief plan',
      '工具调用前确认参数与目标匹配',
      '模糊需求先问清楚再执行',
    ],
  },
  missing_context: {
    hypothesis: (n) =>
      `Agent 在最近 ${n} 个 session 中缺少必要上下文导致失败，应当强化读前置文件`,
    metric: () => 'missing_context 根因次数 >= 40% 下降',
    ruleDraftHeader: '上下文充分性规则（待人工 refine）',
    ruleDraftBullets: [
      '修改文件前必须先 Read',
      '调用 API 前读 README / types 定义',
      '不确定时优先查询而非猜测',
    ],
  },
};

function draftProposal(
  cluster: CategoryCluster,
  proposalId: string
): Proposal {
  const recipe =
    CATEGORY_RECIPES[cluster.category] ?? CATEGORY_RECIPES.tool_error;
  const sampleLines = cluster.samples
    .map((s, i) => `${i + 1}. ${s.summary.slice(0, 120)}`)
    .join('\n');

  const ruleContent = [
    `## ${recipe.ruleDraftHeader}`,
    '',
    ...recipe.ruleDraftBullets.map((b) => `- ${b}`),
    '',
    '## 近期证据样本',
    '',
    sampleLines,
    '',
    cluster.relatedRegressionCases.size > 0
      ? `关联 regression cases: ${[...cluster.relatedRegressionCases].join(', ')}`
      : '',
  ]
    .filter((l) => l.length > 0 || l === '')
    .join('\n');

  return {
    id: proposalId,
    filePath: '',
    createdAt: new Date().toISOString(),
    status: 'pending',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: recipe.hypothesis(cluster.count),
    targetMetric: recipe.metric(cluster.category),
    rollbackCondition: 'session 成功率下降 > 5pp 或用户主动回滚',
    tags: [cluster.category, 'auto-generated'],
    sunset: addDays(new Date(), 30),
    ruleContent,
  };
}

function addDays(d: Date, n: number): string {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  const y = out.getUTCFullYear();
  const m = String(out.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(out.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseArgs(): { top: number; dryRun: boolean; limit: number } {
  const argv = process.argv.slice(2);
  let top = 3;
  let dryRun = false;
  let limit = 50;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top' && argv[i + 1]) top = parseInt(argv[++i], 10);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10);
  }
  return { top, dryRun, limit };
}

async function main() {
  const { top, dryRun, limit } = parseArgs();
  const reportsDir = defaultGraderReportsDir();
  const proposalsDir = defaultProposalsDir();

  console.log(`\n── proposal-generate (v2.5 Phase 4) ──`);
  console.log(`reports:   ${reportsDir}`);
  console.log(`proposals: ${proposalsDir}`);
  console.log(`top:       ${top}`);
  console.log(`dry-run:   ${dryRun}`);
  console.log();

  const attributions = await loadRecentAttributions(reportsDir, limit);
  console.log(`Loaded ${attributions.length} attribution record(s) from the last ${limit} reports.`);

  if (attributions.length === 0) {
    console.log('No failure_attribution data in grader reports (v2.2 schema required).');
    console.log('Run `npm run attribution grader <sessionId>` and embed the output into recent reports first.');
    return;
  }

  const clusters = cluster(attributions);
  console.log(`\nCategory clusters:`);
  for (const c of clusters) {
    console.log(`  ${c.category.padEnd(18)} count=${c.count}  samples=${c.samples.length}`);
  }

  const topClusters = clusters.slice(0, top);
  if (topClusters.length === 0) {
    console.log('\nNothing to generate.');
    return;
  }

  console.log(`\nGenerating ${topClusters.length} proposal(s):`);
  for (const c of topClusters) {
    if (dryRun) {
      console.log(`  [dry-run] ${c.category} (count=${c.count}) — would write proposal`);
      continue;
    }
    await fs.mkdir(proposalsDir, { recursive: true });
    const id = await generateProposalId(proposalsDir);
    const draft = draftProposal(c, id);
    const written = await writeProposal(proposalsDir, draft);
    console.log(`  ✅ ${id}  [${c.category}]  → ${written.filePath}`);
  }

  if (!dryRun) {
    console.log(`\nNext step: npm run proposal -- list --status pending`);
    console.log(`           then: npm run proposal -- eval <id>`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
