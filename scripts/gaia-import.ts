#!/usr/bin/env npx tsx
// ============================================================================
// gaia-import.ts — GAIA validation metadata.jsonl → TestRunner YAML case
// ============================================================================
//
// GAIA 数据集是 gated（防污染 + 许可），题目与答案只落本地目录，
// 不进公开 git —— 本脚本只做本地转换，仓库里只有转换器本身。
//
// Usage:
//   npx tsx scripts/gaia-import.ts \
//     --input ~/.code-agent/gaia/metadata.jsonl \
//     --out ~/.code-agent/gaia/test-cases \
//     --level 1 --no-file-only --limit 25
//
// 生成的 case 走 expect.final_answer（GAIA quasi-exact match，
// deterministic_assertion 桶），跑法：
//   npx tsx scripts/eval-ci.ts --real --case-dir ~/.code-agent/gaia/test-cases \
//     --model LongCat-2.0 --provider longcat --concurrency 1

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

// GAIA 官方论文的作答约定：判分是 quasi-exact match，模型必须按此格式收尾，
// 否则答案对了也提不出来。嵌在每题 prompt 前部（不动 system prompt）。
const GAIA_ANSWER_CONVENTION = [
  'You are a general AI assistant. I will ask you a question. Report your thoughts, and finish your answer with the following template: FINAL ANSWER: [YOUR FINAL ANSWER].',
  'YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.',
  "If you are asked for a number, don't use comma to write your number neither use units such as $ or percent sign unless specified otherwise.",
  "If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise.",
  'If you are asked for a comma separated list, apply the above rules depending of whether the element to be put in the list is a number or a string.',
].join(' ');

/** 单题超时：GAIA 多为联网多步任务，比本地 case 宽松得多 */
const GAIA_CASE_TIMEOUT_MS = 600_000;

interface GaiaRow {
  task_id: string;
  Question: string;
  Level: number | string;
  'Final answer': string;
  file_name?: string;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let input = path.join(os.homedir(), '.code-agent', 'gaia', 'metadata.jsonl');
  let out = path.join(os.homedir(), '.code-agent', 'gaia', 'test-cases');
  let level: string | undefined;
  let noFileOnly = false;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' && i + 1 < args.length) input = args[++i];
    else if (arg === '--out' && i + 1 < args.length) out = args[++i];
    else if (arg === '--level' && i + 1 < args.length) level = args[++i];
    else if (arg === '--no-file-only') noFileOnly = true;
    else if (arg === '--limit' && i + 1 < args.length) limit = parseInt(args[++i], 10);
  }
  return { input, out, level, noFileOnly, limit };
}

function main() {
  const { input, out, level, noFileOnly, limit } = parseArgs(process.argv);

  const resolvedInput = input.replace(/^~/, os.homedir());
  const resolvedOut = out.replace(/^~/, os.homedir());

  const rows: GaiaRow[] = fs
    .readFileSync(resolvedInput, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GaiaRow);

  let selected = rows;
  if (level) selected = selected.filter((r) => String(r.Level) === level);
  if (noFileOnly) selected = selected.filter((r) => !r.file_name);
  const skippedWithFiles = level && !noFileOnly
    ? 0
    : rows.filter((r) => (!level || String(r.Level) === level) && r.file_name).length;
  if (limit) selected = selected.slice(0, limit);

  const cases = selected.map((row) => ({
    id: `gaia-l${row.Level}-${row.task_id.slice(0, 8)}`,
    type: 'task',
    description: `GAIA validation L${row.Level} ${row.task_id}`,
    prompt: `${GAIA_ANSWER_CONVENTION}\n\nQuestion: ${row.Question}`,
    timeout: GAIA_CASE_TIMEOUT_MS,
    tags: ['gaia', `gaia-l${row.Level}`, 'external-benchmark'],
    expect: {
      final_answer: row['Final answer'],
    },
  }));

  const suite = {
    name: `gaia-validation${level ? `-l${level}` : ''}`,
    description: 'GAIA validation（本地数据，不进公开 git）— 外部锚点主基准',
    cases,
  };

  fs.mkdirSync(resolvedOut, { recursive: true });
  const outFile = path.join(resolvedOut, `gaia-validation${level ? `-l${level}` : ''}.yaml`);
  fs.writeFileSync(outFile, yaml.dump(suite, { lineWidth: -1 }), 'utf-8');

  console.log(`✅ ${cases.length} 题 → ${outFile}`);
  if (skippedWithFiles > 0) {
    console.log(`   （另有 ${skippedWithFiles} 题带附件被 --no-file-only 排除——附件题需要文件下载支持，二期）`);
  }
}

main();
