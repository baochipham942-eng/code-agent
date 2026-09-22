/**
 * 零付费重放失败原因分类：读一份已落盘的 TestRunSummary JSON，用当前项目码本
 * （.claude/eval-failcodes.yaml）把每题 failure 重算一遍，打印逐题码与报告里的
 * 「失败原因分布」一节。输入文件只读，不回写。
 *
 * 用法：npx tsx scripts/eval-replay-failcodes.ts <summary.json>
 */
import fs from 'node:fs';

import { loadProjectFailureCodebookWithSource } from '../src/host/testing/failureCodes';
import { generateMarkdownReport } from '../src/host/testing/reportGenerator';
import { classifyTestResultFailure } from '../src/host/testing/testResultFailure';
import type { TestRunSummary } from '../src/host/testing/types';

const file = process.argv[2];
if (!file) {
  console.error('用法：npx tsx scripts/eval-replay-failcodes.ts <summary.json>');
  process.exit(1);
}

const summary = structuredClone(JSON.parse(fs.readFileSync(file, 'utf8'))) as TestRunSummary;
const { codebook, source } = loadProjectFailureCodebookWithSource();
summary.failureCodebookSource = source;
summary.failureDistribution = { unknown: 0 };
for (const result of summary.results) {
  result.failure = classifyTestResultFailure(result, codebook);
  if (!result.failure) continue;
  summary.failureDistribution[result.failure.code] = (summary.failureDistribution[result.failure.code] ?? 0) + 1;
  console.log(`${result.testId}\t${result.status}\t${result.failure.code}\t[${result.failure.symptoms.join(',')}]`);
}
console.log(`\nfailureDistribution ${JSON.stringify(summary.failureDistribution)}\n`);

const report = generateMarkdownReport(summary);
const start = report.indexOf('## 失败原因分布');
const end = report.indexOf('\n## ', start + 1);
console.log(report.slice(start, end === -1 ? undefined : end));
