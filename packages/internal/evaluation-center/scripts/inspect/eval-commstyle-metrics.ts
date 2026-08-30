import fs from 'node:fs';
import path from 'node:path';

interface EvalResult {
  testId: string;
  status: string;
  responses: string[];
  turnCount: number;
}

interface EvalReport {
  results: EvalResult[];
}

interface ArmRun {
  arm: 'A' | 'B';
  round: number;
  file: string;
  results: EvalResult[];
}

const ENGAGEMENT_PATTERN = /(?:需要我|要不要我|说一声)/u;
const PATH_PATTERN = /(?:[A-Za-z]:\\|\.{0,2}\/|\/)?(?:[\p{L}\p{N}_@.-]+[\\/])+[\p{L}\p{N}_@.-]+/gu;
const CODE_TOKEN_PATTERN = /(?:`[^`\n]+`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[\w-]+\.(?:js|jsx|ts|tsx|json|ya?ml|md|html|css|csv|txt|pptx)\b)/gu;
const TECH_TOKEN_PATTERN = /\b(?:AI|API|CLI|CSV|CSS|Electron|Git|HTML|JSON|LLM|Markdown|Neo|npm|Node(?:\.js)?|PPT|PPTX|provider|React|runtime|SDK|SQL|Tauri|token|TypeScript|UI|URL|YAML)\b/giu;

function usage(): never {
  throw new Error(
    'Usage: npx tsx scripts/inspect/eval-commstyle-metrics.ts A1=report.json B1=report.json ... [--sample-ids=id1,id2]',
  );
}

function parseArgs(args: string[]): { runs: ArmRun[]; sampleIds: string[] } {
  const runs: ArmRun[] = [];
  let sampleIds: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--sample-ids=')) {
      sampleIds = arg.slice('--sample-ids='.length).split(',').filter(Boolean);
      continue;
    }
    const match = /^([AB])([1-4])=(.+)$/u.exec(arg);
    if (!match) usage();
    const file = path.resolve(match[3]);
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;
    if (!Array.isArray(report.results) || report.results.length === 0) {
      throw new Error(`Report has no results: ${file}`);
    }
    runs.push({
      arm: match[1] as 'A' | 'B',
      round: Number(match[2]),
      file,
      results: report.results,
    });
  }

  const labels = new Set(runs.map((run) => `${run.arm}${run.round}`));
  for (const arm of ['A', 'B'] as const) {
    for (let round = 1; round <= 4; round += 1) {
      if (!labels.has(`${arm}${round}`)) usage();
    }
  }
  return { runs, sampleIds };
}

function finalReply(result: EvalResult): string {
  return [...result.responses].reverse().find((response) => response.trim().length > 0)?.trim() ?? '';
}

function lastSentence(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  const pieces = normalized.split(/(?<=[。！？!?])\s*/u).filter(Boolean);
  return pieces.at(-1) ?? normalized;
}

function hasTrailingQuestion(text: string): boolean {
  const tail = lastSentence(text);
  return /[?？](?:[”’」』】）)\]]*)$/u.test(tail) || ENGAGEMENT_PATTERN.test(tail);
}

function jargonCount(text: string): number {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [PATH_PATTERN, CODE_TOKEN_PATTERN, TECH_TOKEN_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!ranges.some(([seenStart, seenEnd]) => start < seenEnd && end > seenStart)) {
        ranges.push([start, end]);
      }
    }
  }
  return ranges.length;
}

function visibleCharacterCount(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}

function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.0';
}

function metrics(results: EvalResult[]): {
  cases: number;
  repliesAvailable: number;
  trailingQuestions: number;
  trailingQuestionRate: number;
  jargonTokens: number;
  visibleCharacters: number;
  jargonDensity: number;
  averageReplyLength: number;
  averageTurns: number;
  passed: number;
} {
  const replies = results.map(finalReply);
  const availableReplies = replies.filter((reply) => reply.length > 0);
  const trailingQuestions = replies.filter(hasTrailingQuestion).length;
  const jargonTokens = replies.reduce((sum, reply) => sum + jargonCount(reply), 0);
  const visibleCharacters = replies.reduce((sum, reply) => sum + visibleCharacterCount(reply), 0);
  const replyLength = replies.reduce((sum, reply) => sum + Array.from(reply).length, 0);
  const turns = results.reduce((sum, result) => sum + result.turnCount, 0);
  return {
    cases: results.length,
    repliesAvailable: availableReplies.length,
    trailingQuestions,
    trailingQuestionRate: trailingQuestions / results.length,
    jargonTokens,
    visibleCharacters,
    jargonDensity: visibleCharacters > 0 ? (jargonTokens / visibleCharacters) * 100 : 0,
    averageReplyLength: availableReplies.length > 0 ? replyLength / availableReplies.length : 0,
    averageTurns: turns / results.length,
    passed: results.filter((result) => result.status === 'passed').length,
  };
}

function statusFlips(a: ArmRun, b: ArmRun): string {
  const bById = new Map(b.results.map((result) => [result.testId, result]));
  const flips: string[] = [];
  for (const aResult of a.results) {
    const bResult = bById.get(aResult.testId);
    if (!bResult || aResult.status === bResult.status) continue;
    flips.push(`${aResult.testId}:${aResult.status}→${bResult.status}`);
  }
  return flips.join('<br>') || '无';
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

const { runs, sampleIds } = parseArgs(process.argv.slice(2));
const byLabel = new Map(runs.map((run) => [`${run.arm}${run.round}`, run]));

console.log('| 轮次 | 臂 | N | 有最终回复 | 结尾追问率/N | 行话/百字 | 平均回复长度 | 平均 turnCount | pass |');
console.log('|---:|:---:|---:|---:|---:|---:|---:|---:|---:|');
for (let round = 1; round <= 4; round += 1) {
  for (const arm of ['A', 'B'] as const) {
    const run = byLabel.get(`${arm}${round}`)!;
    const value = metrics(run.results);
    console.log(
      `| ${round} | ${arm} | ${value.cases} | ${value.repliesAvailable}/${value.cases} | ${value.trailingQuestions}/${value.cases} (${fixed(value.trailingQuestionRate * 100)}%) | ${fixed(value.jargonDensity, 2)} | ${fixed(value.averageReplyLength)} | ${fixed(value.averageTurns, 2)} | ${value.passed} |`,
    );
  }
}

console.log('\n| 轮次 | pass/fail 状态翻转（A→B） |');
console.log('|---:|---|');
for (let round = 1; round <= 4; round += 1) {
  console.log(`| ${round} | ${escapeCell(statusFlips(byLabel.get(`A${round}`)!, byLabel.get(`B${round}`)!))} |`);
}

for (const arm of ['A', 'B'] as const) {
  const allResults = runs.filter((run) => run.arm === arm).flatMap((run) => run.results);
  const value = metrics(allResults);
  console.log(
    `\n${arm} 臂四轮合并：N=${value.cases}，有最终回复 ${value.repliesAvailable}/${value.cases}，结尾追问 ${value.trailingQuestions}/${value.cases} (${fixed(value.trailingQuestionRate * 100)}%)，行话 ${fixed(value.jargonDensity, 2)}/百字，平均回复长度 ${fixed(value.averageReplyLength)}，平均 turnCount ${fixed(value.averageTurns, 2)}，pass ${value.passed}/${value.cases}。`,
  );
}

if (sampleIds.length > 0) {
  const a = byLabel.get('A1')!;
  const b = byLabel.get('B1')!;
  const aById = new Map(a.results.map((result) => [result.testId, finalReply(result)]));
  const bById = new Map(b.results.map((result) => [result.testId, finalReply(result)]));
  console.log('\n| 用例 | A 臂最终回复原文（第 1 轮） | B 臂最终回复原文（第 1 轮） |');
  console.log('|---|---|---|');
  for (const id of sampleIds) {
    console.log(`| ${id} | ${escapeCell(aById.get(id) ?? '缺失')} | ${escapeCell(bById.get(id) ?? '缺失')} |`);
  }
}
