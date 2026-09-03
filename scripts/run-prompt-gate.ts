#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RELEASE_EVIDENCE_PRODUCERS } from './lib/releaseEvidenceRegistry.ts';
import { loadPromptChangePaths, resolveGitHead, resolvePromptVersion } from './lib/promptGateScope.ts';

const PROMPT_EVIDENCE = (() => {
  const entry = RELEASE_EVIDENCE_PRODUCERS.find((candidate) => candidate.shape === 'prompt-gate');
  if (!entry) throw new Error('prompt-gate evidence producer is not registered');
  return entry;
})();
const EVIDENCE_PATH = 'docs/eval/prompt-gate-latest.json';
if (PROMPT_EVIDENCE.evidence !== EVIDENCE_PATH) throw new Error('prompt-gate evidence registry path drifted');

const STEPS = [
  {
    name: 'staleScan',
    env: 'PROMPT_GATE_STALE_SCAN_COMMAND',
    command: 'npm run eval:prompt-stale-scan',
  },
  {
    name: 'replayEval',
    env: 'PROMPT_GATE_REPLAY_EVAL_COMMAND',
    command: 'npm run acceptance:real-agent-replay-eval -- --json',
  },
  {
    name: 'realSmoke',
    env: 'PROMPT_GATE_REAL_SMOKE_COMMAND',
    command: 'npm run eval:prompt-real-smoke',
  },
] as const;

function countFromOutput(name: typeof STEPS[number]['name'], output: string): number {
  const injected = output.match(/(?:^|\n)PROMPT_GATE_COUNT=(\d+)(?:\n|$)/)?.[1];
  if (injected !== undefined) return Number(injected);
  if (name === 'staleScan') {
    const count = output.match(/passed \((\d+) target groups\)/)?.[1];
    if (count !== undefined) return Number(count);
  }
  if (name === 'replayEval') {
    const statuses = output.match(/"status"\s*:\s*"passed"/g)?.length ?? 0;
    if (statuses > 0 && /"ok"\s*:\s*true/.test(output)) return statuses;
  }
  if (name === 'realSmoke') {
    const count = output.match(/Total:\s*(\d+)/)?.[1];
    if (count !== undefined) return Number(count);
  }
  throw new Error(`${name} passed but did not report a parseable count`);
}

function runStep(root: string, step: typeof STEPS[number]): number {
  const command = process.env[step.env] || step.command;
  console.log(`[prompt-gate] ${step.name}: ${command}`);
  const result = spawnSync(command, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${step.name} failed with exit ${result.status ?? 1}`);
  const count = countFromOutput(step.name, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (count < 1) throw new Error(`${step.name} passed but evaluated zero targets`);
  return count;
}

function parseArgs(argv: string[]): { root: string; output: string } {
  let root = process.cwd();
  let output = EVIDENCE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') root = path.resolve(argv[++index] ?? '');
    else if (argv[index] === '--output') output = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!output) throw new Error('--output requires a path');
  return { root, output };
}

function main(): void {
  const { root, output } = parseArgs(process.argv.slice(2));
  const counts = Object.fromEntries(STEPS.map((step) => [step.name, runStep(root, step)]));
  const scope = loadPromptChangePaths(root);
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitHead: resolveGitHead(root),
    promptVersion: resolvePromptVersion(root, scope.versionFile),
    passed: true,
    steps: Object.fromEntries(STEPS.map((step) => [step.name, {
      count: counts[step.name],
      passed: true,
    }])),
  };
  const outputPath = path.resolve(root, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
  }
  console.log(`[prompt-gate] evidence written: ${path.relative(root, outputPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`[prompt-gate] ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
