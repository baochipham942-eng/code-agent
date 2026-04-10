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
import {
  writeProposal,
  generateProposalId,
  defaultProposalsDir,
  findSimilarProposal,
  appendEvidenceToProposal,
  polishRecipe,
  type PolishChatFn,
  type StaticRecipe,
  type PolishedRecipe,
} from '../src/main/evaluation/proposals';
import type { Proposal } from '../src/main/evaluation/proposals';
import { DEFAULT_MODELS } from '../src/shared/constants/models';
import { buildChatFn } from '../src/main/evaluation/llmChatFactory';
// NOTE: We intentionally do NOT import ModelRouter here — it pulls in
// configService which references __dirname and fails under tsx's ESM loader.
// `buildChatFn` from llmChatFactory provides a direct-HTTP ChatFn instead.

interface ReportAttribution {
  category: string;
  summary: string;
  sessionId?: string;
  confidence: number; // 0-1, default 1 if absent
  relatedRegressionCases: string[];
  reportDate?: string; // YYYY-MM-DD parsed from filename
}

interface CategoryCluster {
  category: string;
  count: number;
  weightedScore: number; // sum of confidence
  samples: ReportAttribution[];
  evidenceKeys: string[]; // de-duped session ids
  relatedRegressionCases: Set<string>;
}

function defaultGraderReportsDir(): string {
  return path.join(os.homedir(), '.claude', 'grader-reports');
}

/**
 * Parse a YYYY-MM-DD prefix from a grader-report filename (convention).
 * Returns null when the filename does not start with a date.
 */
function parseReportDate(filename: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m ? m[1] : null;
}

function daysBetween(fromISODate: string, to: Date): number {
  const d = new Date(`${fromISODate}T00:00:00Z`).getTime();
  const t = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((t - d) / 86400000);
}

async function loadRecentAttributions(
  dir: string,
  limit: number,
  windowDays: number,
  now: Date = new Date()
): Promise<{ attributions: ReportAttribution[]; scanned: number; filteredByWindow: number }> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { attributions: [], scanned: 0, filteredByWindow: 0 };
  }

  // Sort by filename desc (convention YYYY-MM-DD-... so lex sort ≈ recency).
  const jsonNames = files.filter((f) => f.endsWith('.json')).sort((a, b) => (a < b ? 1 : -1));
  const take = jsonNames.slice(0, limit);

  const out: ReportAttribution[] = [];
  let filteredByWindow = 0;
  for (const name of take) {
    const reportDate = parseReportDate(name);
    if (reportDate && windowDays > 0) {
      const age = daysBetween(reportDate, now);
      if (age > windowDays) {
        filteredByWindow++;
        continue;
      }
    }
    const file = path.join(dir, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as {
        session_id?: string;
        failure_attribution?: {
          root_cause_category?: string;
          root_cause_summary?: string;
          root_cause_confidence?: number;
          related_regression_cases?: string[];
        };
      };
      const attr = parsed.failure_attribution;
      if (!attr?.root_cause_category) continue;
      const conf =
        typeof attr.root_cause_confidence === 'number'
          ? Math.max(0, Math.min(1, attr.root_cause_confidence))
          : 1;
      out.push({
        category: attr.root_cause_category,
        summary: attr.root_cause_summary ?? '',
        sessionId: parsed.session_id,
        confidence: conf,
        relatedRegressionCases: attr.related_regression_cases ?? [],
        reportDate: reportDate ?? undefined,
      });
    } catch {
      // skip malformed
    }
  }
  return { attributions: out, scanned: take.length, filteredByWindow };
}

function cluster(attributions: ReportAttribution[]): CategoryCluster[] {
  const map = new Map<string, CategoryCluster>();
  for (const a of attributions) {
    let c = map.get(a.category);
    if (!c) {
      c = {
        category: a.category,
        count: 0,
        weightedScore: 0,
        samples: [],
        evidenceKeys: [],
        relatedRegressionCases: new Set(),
      };
      map.set(a.category, c);
    }
    c.count++;
    c.weightedScore += a.confidence;
    // Keep every attribution — draftProposal truncates for display; merge path
    // needs the full set so it can write summaries for all newly added keys.
    c.samples.push(a);
    if (a.sessionId && !c.evidenceKeys.includes(a.sessionId)) {
      c.evidenceKeys.push(a.sessionId);
    }
    for (const r of a.relatedRegressionCases) c.relatedRegressionCases.add(r);
  }
  // Sort by weighted score (severity-weighted count) rather than raw count.
  return [...map.values()].sort((a, b) => b.weightedScore - a.weightedScore);
}

interface CategoryRecipeTemplate {
  hypothesis: (count: number) => string;
  metric: (category: string) => string;
  ruleDraftHeader: string;
  ruleDraftBullets: string[];
}

const CATEGORY_RECIPES: Record<string, CategoryRecipeTemplate> = {
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

/**
 * Renders the static template for a given cluster. Used both as the default
 * recipe and as the baseline passed to the LLM polisher.
 */
function renderStaticRecipe(cluster: CategoryCluster): StaticRecipe {
  const template =
    CATEGORY_RECIPES[cluster.category] ?? CATEGORY_RECIPES.tool_error;
  return {
    hypothesis: template.hypothesis(cluster.count),
    targetMetric: template.metric(cluster.category),
    ruleDraftHeader: template.ruleDraftHeader,
    ruleDraftBullets: [...template.ruleDraftBullets],
  };
}

/** Shape that both static and polished recipes conform to. */
type ResolvedRecipe = StaticRecipe;

function draftProposal(
  cluster: CategoryCluster,
  proposalId: string,
  recipe: ResolvedRecipe,
  tagsExtra: string[] = []
): Proposal {
  // Show at most 3 samples in the initial body for readability.
  const sampleLines = cluster.samples
    .slice(0, 3)
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
    hypothesis: recipe.hypothesis,
    targetMetric: recipe.targetMetric,
    rollbackCondition: 'session 成功率下降 > 5pp 或用户主动回滚',
    tags: [cluster.category, 'auto-generated', ...tagsExtra],
    sunset: addDays(new Date(), 30),
    evidenceKeys: [...cluster.evidenceKeys],
    ruleContent,
  };
}

/**
 * Try to polish the static recipe via an injected chat function. Returns the
 * polished recipe plus a source tag, or falls back to the static recipe. Any
 * failure (network, parse, schema) is logged and absorbed.
 */
async function resolveRecipe(
  cluster: CategoryCluster,
  chatFn: PolishChatFn | null
): Promise<{ recipe: ResolvedRecipe; source: 'static' | 'llm-polished'; note?: string }> {
  const staticRecipe = renderStaticRecipe(cluster);
  if (!chatFn) return { recipe: staticRecipe, source: 'static' };

  let polished: PolishedRecipe | null = null;
  try {
    polished = await polishRecipe(
      {
        category: cluster.category,
        count: cluster.count,
        weightedScore: cluster.weightedScore,
        sampleSummaries: cluster.samples.map((s) => s.summary),
        staticRecipe,
      },
      chatFn
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { recipe: staticRecipe, source: 'static', note: `polish threw: ${msg.split('\n')[0]}` };
  }

  if (!polished) {
    return { recipe: staticRecipe, source: 'static', note: 'polish returned null (fallback)' };
  }

  return { recipe: polished, source: 'llm-polished' };
}

/**
 * Build EvidenceItem candidates from the cluster's raw attributions. Unlike
 * the draft path which caps samples to 3 for readability, merge path forwards
 * every attribution so dedup by key is accurate.
 */
function clusterEvidenceItems(c: CategoryCluster): { key: string; summary: string }[] {
  const seen = new Set<string>();
  const out: { key: string; summary: string }[] = [];
  for (const s of c.samples) {
    if (!s.sessionId || seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    out.push({ key: s.sessionId, summary: s.summary });
  }
  return out;
}

function addDays(d: Date, n: number): string {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  const y = out.getUTCFullYear();
  const m = String(out.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(out.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

interface CliArgs {
  top: number;
  dryRun: boolean;
  limit: number;
  windowDays: number;
  llmPolish: boolean;
  polishModel: string; // "provider/model"
}

const DEFAULT_POLISH_MODEL = `zhipu/${DEFAULT_MODELS.quick}`;

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let top = 3;
  let dryRun = false;
  let limit = 50;
  let windowDays = 14;
  let llmPolish = false;
  let polishModel = DEFAULT_POLISH_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top' && argv[i + 1]) top = parseInt(argv[++i], 10);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10);
    else if (a === '--window-days' && argv[i + 1]) windowDays = parseInt(argv[++i], 10);
    else if (a === '--llm-polish') llmPolish = true;
    else if (a === '--polish-model' && argv[i + 1]) polishModel = argv[++i];
  }
  return { top, dryRun, limit, windowDays, llmPolish, polishModel };
}

/**
 * Thin wrapper around the shared `buildChatFn` factory for the --llm-polish
 * CLI flow. Keeps the old return shape (`{chatFn, provider, model} | {error}`)
 * so the main() code below is unchanged.
 */
async function buildPolishChatFn(polishModel: string): Promise<{
  chatFn: PolishChatFn;
  provider: string;
  model: string;
} | { error: string }> {
  return buildChatFn({ polishModel, temperature: 0.3, maxTokens: 1024 });
}

async function main() {
  const { top, dryRun, limit, windowDays, llmPolish, polishModel } = parseArgs();
  const reportsDir = defaultGraderReportsDir();
  const proposalsDir = defaultProposalsDir();

  console.log(`\n── proposal-generate (v2.5 Phase 6) ──`);
  console.log(`reports:      ${reportsDir}`);
  console.log(`proposals:    ${proposalsDir}`);
  console.log(`top:          ${top}`);
  console.log(`window-days:  ${windowDays}`);
  console.log(`llm-polish:   ${llmPolish}${llmPolish ? ` (${polishModel})` : ''}`);
  console.log(`dry-run:      ${dryRun}`);
  console.log();

  // Build the optional polish chatFn up front so failures abort before any IO.
  let chatFn: PolishChatFn | null = null;
  if (llmPolish && !dryRun) {
    const built = await buildPolishChatFn(polishModel);
    if ('error' in built) {
      console.log(`⚠ LLM polish disabled: ${built.error}`);
      console.log('  (falling back to static templates for this run)');
    } else {
      console.log(`LLM polisher ready: ${built.provider}/${built.model}`);
      chatFn = built.chatFn;
    }
    console.log();
  }

  const { attributions, scanned, filteredByWindow } = await loadRecentAttributions(
    reportsDir,
    limit,
    windowDays
  );
  console.log(
    `Scanned ${scanned} report(s), loaded ${attributions.length} attribution record(s), ` +
      `skipped ${filteredByWindow} outside ${windowDays}d window.`
  );

  if (attributions.length === 0) {
    console.log('No failure_attribution data in grader reports (v2.2 schema required).');
    console.log('Run `npm run attribution grader <sessionId>` and embed the output into recent reports first.');
    return;
  }

  const clusters = cluster(attributions);
  console.log(`\nCategory clusters (sorted by severity-weighted score):`);
  for (const c of clusters) {
    console.log(
      `  ${c.category.padEnd(18)} count=${c.count}  weighted=${c.weightedScore.toFixed(2)}  ` +
        `evidence=${c.evidenceKeys.length}  samples=${c.samples.length}`
    );
  }

  const topClusters = clusters.slice(0, top);
  if (topClusters.length === 0) {
    console.log('\nNothing to generate.');
    return;
  }

  let created = 0;
  let merged = 0;
  let skipped = 0;
  console.log(`\nProcessing ${topClusters.length} cluster(s):`);
  for (const c of topClusters) {
    // Check for an existing open proposal in the same category first.
    const similar = await findSimilarProposal(proposalsDir, c.category);

    if (similar) {
      const candidates = clusterEvidenceItems(c);
      if (dryRun) {
        const existingKeys = new Set(similar.evidenceKeys ?? []);
        const newKeys = candidates.filter((it) => !existingKeys.has(it.key)).map((it) => it.key);
        if (newKeys.length === 0) {
          console.log(`  [dry-run] ${c.category}: would skip (all evidence already in ${similar.id})`);
          skipped++;
        } else {
          console.log(
            `  [dry-run] ${c.category}: would merge ${newKeys.length} new evidence key(s) into ${similar.id}`
          );
          merged++;
        }
        continue;
      }
      const { addedKeys } = await appendEvidenceToProposal(similar.filePath, candidates);
      if (addedKeys.length === 0) {
        console.log(`  ⏭  ${c.category}: all evidence already present in ${similar.id} — skipped`);
        skipped++;
      } else {
        console.log(
          `  🔀 ${c.category}: merged ${addedKeys.length} new evidence key(s) → ${similar.id}`
        );
        merged++;
      }
      continue;
    }

    // No similar open proposal — create a fresh one.
    if (dryRun) {
      console.log(`  [dry-run] ${c.category} (count=${c.count}, weighted=${c.weightedScore.toFixed(2)}) — would write new proposal`);
      created++;
      continue;
    }
    const resolved = await resolveRecipe(c, chatFn);
    const tagExtra = resolved.source === 'llm-polished' ? ['llm-polished'] : [];
    await fs.mkdir(proposalsDir, { recursive: true });
    const id = await generateProposalId(proposalsDir);
    const draft = draftProposal(c, id, resolved.recipe, tagExtra);
    const written = await writeProposal(proposalsDir, draft);
    const sourceBadge = resolved.source === 'llm-polished' ? '🤖' : '📋';
    console.log(`  ✅ ${id}  ${sourceBadge} [${c.category}]  → ${written.filePath}`);
    if (resolved.note) console.log(`     note: ${resolved.note}`);
    created++;
  }

  console.log(`\nSummary: created=${created}  merged=${merged}  skipped=${skipped}`);
  if (!dryRun && (created > 0 || merged > 0)) {
    console.log(`\nNext step: npm run proposal -- list --status pending`);
    console.log(`           then: npm run proposal -- eval <id>`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
