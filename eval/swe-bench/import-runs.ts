/**
 * Import existing eval/swe-bench/runs/* results into the product Experiment DB
 * so Eval Center can read them through the same LIST_EXPERIMENTS/LOAD_EXPERIMENT path.
 *
 * Usage:
 *   npx tsx eval/swe-bench/import-runs.ts
 *   npx tsx eval/swe-bench/import-runs.ts eval/swe-bench/runs/2026-04-28-django__django-16642-judge-v1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDatabase } from '../../src/main/services/core/databaseService';
import { persistSweBenchRun } from './persistence';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/swe-bench/runs');

function resolveRunDirs(argv: string[]): string[] {
  if (argv.length > 0) {
    return argv.map(arg => path.resolve(REPO_ROOT, arg));
  }

  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .map(entry => path.join(RUNS_DIR, entry))
    .filter(runDir => fs.statSync(runDir).isDirectory() && fs.existsSync(path.join(runDir, 'result.json')));
}

async function main() {
  const runDirs = resolveRunDirs(process.argv.slice(2));
  const db = await initDatabase();
  let imported = 0;

  for (const runDir of runDirs.sort()) {
    try {
      const experimentId = persistSweBenchRun(db, runDir);
      imported++;
      console.log(`[imported] ${path.basename(runDir)} -> ${experimentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[skip] ${path.basename(runDir)}: ${message}`);
    }
  }

  console.log(`[done] imported ${imported}/${runDirs.length} SWE-bench runs`);
  db.close();
}

main().catch(error => {
  console.error('FATAL:', error);
  process.exit(1);
});

