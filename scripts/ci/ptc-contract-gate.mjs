#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const gates = {
  'sdk-determinism': {
    targets: [
      {
        file: 'tests/unit/agent/scriptRuntime/toolsSdk.test.ts',
        marker: /describe\(['"]renderToolsSdk · 确定性/,
      },
    ],
  },
  'transport-name-reservation': {
    targets: [
      {
        file: 'tests/unit/agent/scriptRuntime/ptcSdkProjection.test.ts',
        marker: /工具表里排除 workflow 自身/,
      },
    ],
  },
};

const gateName = process.argv[2];
const gate = gates[gateName];
if (!gate) {
  console.error(`[ptc-contract] unknown gate "${gateName ?? ''}"; expected ${Object.keys(gates).join(' or ')}`);
  process.exit(2);
}

const matchedFiles = [];
let targetCount = 0;
for (const target of gate.targets) {
  const absolute = path.join(repoRoot, target.file);
  if (!fs.existsSync(absolute)) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  const matches = source.match(target.marker);
  if (!matches) continue;
  targetCount += matches.length;
  matchedFiles.push(target.file);
}

if (targetCount === 0 || matchedFiles.length === 0) {
  console.error(`[ptc-contract] ${gateName} scanned ${gate.targets.length} candidates but found 0 targets; gate is blind`);
  process.exit(1);
}

console.log(`[ptc-contract] ${gateName}: ${targetCount} target(s) across ${matchedFiles.length} file(s)`);
const result = spawnSync('npx', ['vitest', 'run', ...matchedFiles], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
