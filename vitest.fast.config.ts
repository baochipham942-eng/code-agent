import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { assertExactFiles, validateFiles } from './scripts/lib/gates-fast-contract.mjs';

// This manifest is produced from reviewed policy + explicit author regressions.
// No CLI positional filters, dependency graph, changed/related selection or retries.
const manifest = JSON.parse(fs.readFileSync(process.env.GATES_FAST_MANIFEST!, 'utf8'));
const files: string[] = manifest.files;
validateFiles(process.cwd(), files, manifest.maxFiles);

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: files,
    maxWorkers: 1,
    retry: 0,
    passWithNoTests: false,
    allowOnly: false,
    cache: false,
    reporters: [
      {
        onTestRunStart(specifications) {
          assertExactFiles(files, specifications.map((spec) => path.relative(process.cwd(), spec.moduleId).split(path.sep).join('/')), 'before execution');
        },
        onTestRunEnd(_modules, errors, reason) {
          if (errors.length || reason !== 'passed') throw new Error(`FAIL: fast Vitest ended ${reason}, unhandled errors=${errors.length}`);
        },
      },
      ['json', { outputFile: process.env.GATES_FAST_REPORT! }],
    ],
  },
});
