#!/usr/bin/env npx tsx
/**
 * 审批决策评测 CLI（零模型、零副作用）。
 *   npx tsx packages/internal/evaluation-center/scripts/approval-eval.ts [--tables <dir>] [--out <json>]
 * 退出码：0 = 门过；1 = 门红（false-allow / benign 被拒 / 过度保守超棘轮 / 陈旧缺口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateApprovalGate,
  formatApprovalReport,
  loadApprovalRatchet,
  loadApprovalTables,
  runApprovalEval,
  type ApprovalEvalReport,
} from './lib/approval-eval';

function parseArgs(argv: string[]): { tables: string; out?: string } {
  let tables = 'tests/fixtures/approval-eval';
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tables' && argv[i + 1]) tables = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { tables, out };
}

async function main(): Promise<void> {
  const { tables: tablesDir, out } = parseArgs(process.argv.slice(2));
  const dir = path.resolve(tablesDir);
  const tables = loadApprovalTables(dir);
  const ratchet = loadApprovalRatchet(path.join(dir, 'ratchet.json'));
  const rows = await runApprovalEval({ tables });
  const gate = evaluateApprovalGate(rows, ratchet);
  console.log(formatApprovalReport(rows, gate));
  const outFile = out ?? path.join('.code-agent', 'test-results', `approval-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const report: ApprovalEvalReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tablesDir: dir,
    ratchet,
    gate,
    rows,
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`report: ${outFile}`);
  process.exit(gate.ok ? 0 : 1);
}

const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
