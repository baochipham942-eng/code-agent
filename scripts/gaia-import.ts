#!/usr/bin/env npx tsx
// ============================================================================
// gaia-import.ts — GAIA validation metadata.jsonl → TestRunner YAML case（CLI 薄壳）
// ============================================================================
//
// GAIA 数据集是 gated（防污染 + 许可），题目/答案/附件只落本地目录，
// 不进公开 git —— 本脚本只做本地转换，转换逻辑在 src/host/testing/gaiaImporter.ts
// （tsconfig 覆盖范围内，scripts/ 本身 tsc 抓不到）。
//
// Usage:
//   npx tsx scripts/gaia-import.ts \
//     --input ~/.code-agent/gaia/metadata.jsonl \
//     --out ~/.code-agent/gaia/test-cases \
//     --files-dir ~/.code-agent/gaia/files \
//     --level 1 --limit 25
//
// 附件题（38/165）生成 files 字段，testRunner 跑前注入沙箱工作目录；
// 附件文件缺失时导入直接报错（不静默生成会假阴性的 case）。
//
// 生成的 case 走 expect.final_answer（GAIA quasi-exact match，
// deterministic_assertion 桶），跑法：
//   npx tsx scripts/eval-ci.ts --real --case-dir ~/.code-agent/gaia/test-cases \
//     --model LongCat-2.0 --provider longcat --concurrency 1

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildGaiaSuite, type GaiaRow } from '../src/host/testing/gaiaImporter';

const HELP = `gaia-import — GAIA metadata.jsonl → TestRunner YAML case

Options:
  --input <file>      metadata.jsonl 路径（默认 ~/.code-agent/gaia/metadata.jsonl）
  --out <dir>         输出目录（默认 ~/.code-agent/gaia/test-cases）
  --files-dir <dir>   附件目录（默认 ~/.code-agent/gaia/files）
  --level <1|2|3>     只转换指定 Level
  --limit <n>         截断前 N 题
  --help              显示本帮助`;

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let input = path.join(os.homedir(), '.code-agent', 'gaia', 'metadata.jsonl');
  let out = path.join(os.homedir(), '.code-agent', 'gaia', 'test-cases');
  let filesDir = path.join(os.homedir(), '.code-agent', 'gaia', 'files');
  let level: string | undefined;
  let limit: number | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' && i + 1 < args.length) input = args[++i];
    else if (arg === '--out' && i + 1 < args.length) out = args[++i];
    else if (arg === '--files-dir' && i + 1 < args.length) filesDir = args[++i];
    else if (arg === '--level' && i + 1 < args.length) level = args[++i];
    else if (arg === '--limit' && i + 1 < args.length) limit = parseInt(args[++i], 10);
    else if (arg === '--help' || arg === '-h') help = true;
  }
  return { input: expandHome(input), out: expandHome(out), filesDir: expandHome(filesDir), level, limit, help };
}

function main() {
  const { input, out, filesDir, level, limit, help } = parseArgs(process.argv);

  if (help) {
    console.log(HELP);
    return;
  }

  const rows: GaiaRow[] = fs
    .readFileSync(input, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GaiaRow);

  const suite = buildGaiaSuite(rows, { filesDir, level, limit });

  // 附件存在性校验：缺附件的 case 会退化成"没有附件也硬答"的假阴性，导入期就拦下
  const missing = suite.cases
    .flatMap((c) => c.files ?? [])
    .filter((f) => !fs.existsSync(f.source))
    .map((f) => f.source);
  if (missing.length > 0) {
    console.error(`❌ ${missing.length} 个附件缺失（先补齐 ${filesDir}）：`);
    for (const m of missing) console.error(`   ${m}`);
    process.exit(1);
  }

  fs.mkdirSync(out, { recursive: true });
  const outFile = path.join(out, `gaia-validation${level ? `-l${level}` : ''}.yaml`);
  fs.writeFileSync(outFile, yaml.dump(suite, { lineWidth: -1 }), 'utf-8');

  const withFiles = suite.cases.filter((c) => c.files?.length).length;
  console.log(`✅ ${suite.cases.length} 题 → ${outFile}（其中 ${withFiles} 题带附件）`);
}

main();
