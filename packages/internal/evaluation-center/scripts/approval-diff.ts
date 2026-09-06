#!/usr/bin/env npx tsx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffApprovalReports,
  formatApprovalDiff,
  parseApprovalEvalReport,
} from './lib/approval-diff';

function parseArgs(argv: string[]): { baseline: string; candidate: string; out?: string } {
  let baseline: string | undefined;
  let candidate: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline' && argv[i + 1]) baseline = argv[++i];
    else if (argv[i] === '--candidate' && argv[i + 1]) candidate = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!baseline || !candidate) throw new Error('usage: approval-diff.ts --baseline <report.json> --candidate <report.json> [--out <diff.json>]');
  return { baseline, candidate, out };
}

function readReport(file: string) {
  const absolute = path.resolve(file);
  return parseApprovalEvalReport(JSON.parse(fs.readFileSync(absolute, 'utf8')), absolute);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = diffApprovalReports(readReport(args.baseline), readReport(args.candidate));
  console.log(formatApprovalDiff(result));
  if (args.out) {
    const outFile = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`report: ${outFile}`);
  }
  process.exit(result.ok ? 0 : 1);
}

const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
