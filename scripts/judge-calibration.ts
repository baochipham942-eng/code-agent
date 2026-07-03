// ============================================================================
// Judge 校准数据管道 — 量化 LLM judge 与确定性断言（金标）的真实一致度
// ============================================================================
// 背景：Neo 的 batch 评测打分是确定性断言。本脚本另起一个 LLM judge（zhipu GLM，
// 非 mimo，独立端点不抢评测配额），让它仅凭 agent 的输出+动作判 pass/fail，再把
// judge 判定与断言判定配对，喂 computeCalibration 算 Cohen's Kappa。这回答了
// "如果用 LLM judge 给 Neo 打分，它和确定性事实有多一致" —— 零人工的校准基线。
//
// 用法: npx tsx scripts/judge-calibration.ts <report.json> [--model glm-4.7]
// ============================================================================

import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { computeCalibration, type CalibrationPair, type CalibrationLabel } from '../src/host/testing/calibration/judgeCalibration';
import { saveCalibrationRecord, isTrustedCalibration, CALIBRATION_TRUST_THRESHOLDS } from '../src/host/testing/calibration/calibrationRegistry';
import { CONFIG_DIR_NEW } from '../src/shared/constants/configDir';

// ---- zhipu(0ki 代理) 单次 chat 调用 ---------------------------------------
const ZHIPU_ENDPOINT = 'https://api.0ki.cn/api/paas/v4';

function readEnvKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const content = readFileSync(path.join(os.homedir(), '.code-agent', '.env'), 'utf8');
    const m = content.match(new RegExp(`^${name}=["']?([^"'\\s\\n]+)`, 'm'));
    return m?.[1];
  } catch { return undefined; }
}

const ZHIPU_KEY = readEnvKey('ZHIPU_API_KEY');

async function judgeOnce(model: string, prompt: string): Promise<string | null> {
  const res = await fetch(`${ZHIPU_ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ZHIPU_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0,
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`zhipu ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? null;
}

// ---- 从 judge 文本里抠出 verdict ------------------------------------------
function parseVerdict(text: string | null): CalibrationLabel | null {
  if (!text) return null;
  const m = text.match(/"verdict"\s*:\s*"(pass|fail)"/i) ?? text.match(/\b(pass|fail)\b/i);
  if (!m) return null;
  return m[1].toLowerCase() === 'pass' ? 'pass' : 'fail';
}

function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  return typeof v === 'string' ? v : JSON.stringify(v ?? '');
}

function toolSummary(v: unknown): string {
  try {
    const arr = Array.isArray(v) ? v : [];
    return arr.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return (o.tool ?? o.name ?? '?') as string;
    }).join(', ') || '(无工具调用)';
  } catch { return '(无法解析)'; }
}

interface ReportCase {
  testId: string;
  description?: string;
  status: string;
  score?: number;
  reference_solution?: string;
  toolExecutions?: unknown;
  responses?: unknown;
  errors?: unknown;
}

function buildJudgePrompt(c: ReportCase): string {
  return [
    '你是严格的代码 agent 评测裁判。仅依据下面信息判断 agent 是否真正完成了任务。',
    '只看结果是否达成，不要被礼貌用语或"我已完成"之类的自述误导。',
    '',
    `【任务】${c.description ?? c.testId}`,
    `【参考解法/期望】${c.reference_solution ?? '(无)'}`,
    `【agent 调用的工具】${toolSummary(c.toolExecutions)}`,
    `【agent 最终回复(截断)】${asText(c.responses).slice(0, 1500)}`,
    `【agent 报错】${asText(c.errors).slice(0, 300) || '无'}`,
    '',
    '只输出 JSON，不要解释：{"verdict":"pass"|"fail","reason":"一句话"}',
  ].join('\n');
}

// 金标：确定性断言判定。partial 不计入二分类 Kappa（既非干净通过也非干净失败）。
function groundTruth(status: string): CalibrationLabel | 'skip' {
  if (status === 'passed') return 'pass';
  if (status === 'failed') return 'fail';
  return 'skip'; // partial / error / skipped
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = args.find((a) => !a.startsWith('--'));
  const model = (args.find((a) => a.startsWith('--model='))?.split('=')[1]) ?? 'glm-4.7';
  if (!reportPath) {
    console.error('用法: npx tsx scripts/judge-calibration.ts <report.json> [--model=glm-4.7]');
    process.exit(1);
  }
  if (!ZHIPU_KEY) {
    console.error('缺 ZHIPU_API_KEY（~/.code-agent/.env）');
    process.exit(1);
  }

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const cases: ReportCase[] = (report.results ?? report.cases ?? []) as ReportCase[];
  console.log(`读取 ${cases.length} 个 case（judge=zhipu/${model}），开始评判...\n`);

  const pairs: CalibrationPair[] = [];
  let skipped = 0;
  // 顺序跑（zhipu 免费档并发上限 ~3，顺序最稳），每个 case 一次 judge 调用
  for (const c of cases) {
    const gt = groundTruth(c.status);
    if (gt === 'skip') { skipped++; continue; }
    let judgeLabel: CalibrationLabel | null = null;
    try {
      const out = await judgeOnce(model, buildJudgePrompt(c));
      judgeLabel = parseVerdict(out);
    } catch (e) {
      console.warn(`  judge 失败 ${c.testId}: ${(e as Error).message}`);
    }
    if (!judgeLabel) { skipped++; continue; }
    const agree = judgeLabel === gt ? '✓' : '✗ 分歧';
    console.log(`  ${agree}  ${c.testId}: judge=${judgeLabel} 金标=${gt}`);
    pairs.push({ caseId: c.testId, judgeLabel, groundTruthLabel: gt, judgeScore: undefined, groundTruthScore: c.score });
  }

  const rpt = computeCalibration(pairs);
  console.log('\n' + '='.repeat(56));
  console.log('  Judge 校准报告（LLM judge vs 确定性断言金标）');
  console.log('='.repeat(56));
  console.log(`  配对样本:   ${rpt.total}（跳过 partial/失败判定 ${skipped} 个）`);
  console.log(`  混淆矩阵:   TP=${rpt.confusion.truePositive} TN=${rpt.confusion.trueNegative} FP=${rpt.confusion.falsePositive}(judge虚高) FN=${rpt.confusion.falseNegative}(judge误杀)`);
  console.log(`  裸一致率:   ${(rpt.agreementRate * 100).toFixed(1)}%`);
  console.log(`  Cohen Kappa: ${rpt.cohensKappa.toFixed(3)}  →  ${rpt.kappaInterpretation}`);
  console.log(`  虚高率(FP): ${(rpt.falsePositiveRate * 100).toFixed(1)}%  误杀率(FN): ${(rpt.falseNegativeRate * 100).toFixed(1)}%`);
  if (rpt.disagreements.length) {
    console.log(`  分歧 case:  ${rpt.disagreements.map((d) => `${d.caseId}(judge=${d.judgeLabel})`).join(', ')}`);
  }
  console.log('='.repeat(56));

  const outPath = path.join(path.dirname(reportPath), `calibration-${model}.json`);
  await fs.writeFile(outPath, JSON.stringify({ model, ...rpt }, null, 2), 'utf8');
  console.log(`\n报告已存: ${outPath}`);

  // 制度化落注册表：llm_judge 分数进可信列的唯一凭据（reportGenerator 按此标注）
  const record = {
    judgeId: `zhipu/${model}`,
    kappa: rpt.cohensKappa,
    agreementRate: rpt.agreementRate,
    pairs: rpt.total,
    falsePositiveRate: rpt.falsePositiveRate,
    computedAt: new Date().toISOString(),
  };
  const registryDir = path.join(process.cwd(), CONFIG_DIR_NEW);
  await saveCalibrationRecord(registryDir, record);
  const verdict = isTrustedCalibration(record)
    ? '✅ 达标（llm_judge 分数可进可信列）'
    : `⚠ 未达标（需 κ≥${CALIBRATION_TRUST_THRESHOLDS.minKappa} 且 n≥${CALIBRATION_TRUST_THRESHOLDS.minPairs}），llm_judge 分数不作能力证据`;
  console.log(`注册表已更新: ${path.join(registryDir, 'judge-calibration.json')} → ${verdict}`);
}

main().catch((e) => { console.error('calibration failed:', e); process.exit(1); });
