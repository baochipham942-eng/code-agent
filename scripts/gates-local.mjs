#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const npmCache = process.env.npm_config_cache || path.join(os.tmpdir(), 'code-agent-npm-cache');
const childEnv = {
  ...process.env,
  npm_config_cache: npmCache,
};

const localExclusions = [
  {
    ci: 'all PR workflows / Checkout, Setup Node.js and dependency cache steps',
    reason: 'GitHub runner provisioning, not repository assertions. Local gates assume the root dependencies already exist.',
  },
  {
    ci: 'swarm-ci / smoke + full / Linux Rollup and better-sqlite3 setup',
    reason: 'Linux runner dependency repair. The local command uses the current platform dependencies and fails at the consuming gate if they are unusable.',
  },
  {
    ci: 'swarm-ci / full / Build node-pty native binding',
    reason: 'Linux-only native binding preparation; the macOS artifact and loader path are different.',
  },
  {
    ci: 'swarm-ci / smoke + full / Install Playwright browsers --with-deps',
    reason: 'Installs Ubuntu system packages. The local e2e gate still runs and reports a missing local browser explicitly.',
  },
  {
    ci: 'swarm-ci / failure artifact uploads and full-job result bookkeeping',
    reason: 'GitHub Actions reporting side effects with no source assertion to reproduce locally.',
  },
];

const gates = [
  {
    ci: 'provider-symmetry / symmetry / Run provider symmetry check',
    command: 'bash',
    args: ['scripts/check-provider-symmetry.sh'],
  },
  {
    ci: 'capability-evidence / evidence / Run capability evidence gate',
    command: 'npx',
    args: ['--yes', 'tsx', 'scripts/check-capability-evidence.ts'],
  },
  {
    ci: 'capability-evidence / evidence / Run provider/runtime static release evidence gate',
    command: 'npx',
    args: ['--yes', 'tsx', 'scripts/check-provider-runtime-release-evidence.ts', '--mode', 'static'],
  },
  {
    ci: 'repository-structure / repository-structure / Check repository structure',
    command: 'node',
    args: ['scripts/ci/check-repository-structure.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Typecheck (src only) + eval-harness / harness / Typecheck',
    command: 'npm',
    args: ['run', 'typecheck'],
  },
  {
    ci: 'swarm-ci / smoke / Typecheck ratchet (tests + scripts)',
    command: 'node',
    args: ['scripts/tsc-tests-ratchet.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Install Vercel control-plane dependencies',
    command: 'npm',
    args: ['ci', '--prefix', 'vercel-api', '--ignore-scripts'],
  },
  {
    ci: 'swarm-ci / smoke / Typecheck Vercel control-plane',
    command: 'npm',
    args: ['--prefix', 'vercel-api', 'run', 'typecheck'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / console-scan',
    command: 'node',
    args: ['scripts/console-scan.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / a11y-scan',
    command: 'node',
    args: ['scripts/a11y-scan.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / stale-dist-scan',
    command: 'node',
    args: ['scripts/stale-dist-scan.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / design-system',
    command: 'node',
    args: ['scripts/check-design-system.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / token-integrity',
    command: 'node',
    args: ['scripts/check-token-integrity.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Static gates / copy',
    command: 'node',
    args: ['scripts/check-copy.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Host Chinese error literal ratchet',
    command: 'node',
    args: ['scripts/host-chinese-error-ratchet.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Host ESM/CJS static gate',
    command: 'node',
    args: ['scripts/ci/host-esm-cjs-lint.mjs'],
  },
  {
    ci: '本工单新增，local-only（未接入 CI workflow，见 2026-08-01 脚本报错路径先失明 REPORT 遗留项）',
    command: 'node',
    args: ['scripts/shell-fail-loud-lint.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Script gates (vitest tests/scripts)',
    command: 'npx',
    args: ['vitest', 'run', 'tests/scripts', '--retry=1'],
  },
  {
    ci: 'swarm-ci / smoke / Knip dead-export ratchet',
    command: 'node',
    args: ['scripts/knip-ratchet.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / Knip production dead-export ratchet',
    command: 'node',
    args: ['scripts/knip-ratchet.mjs', '--profile', 'production'],
  },
  {
    ci: 'swarm-ci / smoke / Knip production-reachability ratchet',
    command: 'node',
    args: ['scripts/knip-production-ratchet.mjs'],
  },
  {
    ci: 'swarm-ci / smoke / ESLint error-warning ratchet',
    command: 'node',
    args: ['scripts/eslint-ratchet.mjs'],
  },
  {
    ci: 'eval-harness / harness / Eval harness unit tests',
    command: 'npx',
    args: [
      'vitest',
      'run',
      'tests/unit/testing',
      'tests/unit/evaluation',
      'tests/eval',
      'tests/eval-harness',
    ],
  },
  {
    ci: 'swarm-ci / smoke / Main-chain vitest subset',
    command: 'npx',
    args: [
      'vitest',
      'run',
      'tests/unit/agent',
      'tests/unit/design',
      'tests/unit/ipc',
      'tests/unit/tools',
      'tests/unit/services',
      'tests/renderer',
      '--retry=1',
      '--exclude',
      'tests/unit/tools/modules/network/webSearch.test.ts',
      '--exclude',
      'tests/unit/agent/goalVerifyGate.test.ts',
    ],
  },
  {
    ci: 'swarm-ci / smoke + full / Run swarm smoke suite',
    command: 'npm',
    args: ['run', 'test:swarm:smoke', '--', '--retry=1'],
  },
  {
    ci: 'webserver-boot / boot-gate / Build webServer bundle',
    command: 'npm',
    args: ['run', 'build:web'],
  },
  {
    ci: 'webserver-boot / boot-gate / WebServer boot gate',
    command: 'npm',
    args: ['run', 'verify:webserver-boot'],
  },
  {
    ci: 'renderer-bundle / renderer-capability-diff / Compare renderer shell capabilities',
    run: runRendererCapabilityDiff,
  },
  {
    ci: 'renderer-bundle / renderer-bundle-dry-run / Build renderer bundle',
    command: 'npm',
    args: [
      'run',
      'release:renderer-bundle',
      '--',
      '--version',
      readPackageVersion(),
      '--bundle-base-url',
      'https://dry-run.invalid/renderer',
      '--dry-run',
    ],
  },
  {
    ci: 'renderer-bundle / renderer-hot-update-smoke / Smoke renderer hot-update serving',
    command: 'npm',
    args: ['run', 'acceptance:renderer-hot-update'],
  },
  {
    ci: 'swarm-ci / full / Run swarm e2e suite',
    command: 'npm',
    args: ['run', 'test:swarm:e2e'],
    env: {
      CODE_AGENT_E2E: '1',
      CI: '1',
    },
  },
];

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return packageJson.version;
}

function spawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...childEnv,
      ...options.env,
    },
    stdio: options.stdio || 'inherit',
    encoding: options.encoding,
    input: options.input,
    maxBuffer: options.maxBuffer || 512 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} exited with ${result.status ?? 'no status'}${result.signal ? ` (${result.signal})` : ''}`);
  }
}

function runRendererCapabilityDiff() {
  const requestedBaseRef = process.env.GATES_LOCAL_BASE_REF || 'origin/main';
  const mergeBase = spawn('git', ['merge-base', 'HEAD', requestedBaseRef], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  requireSuccess(mergeBase, `git merge-base HEAD ${requestedBaseRef}`);
  const baseSha = mergeBase.stdout.trim();
  if (!baseSha) {
    throw new Error(`git merge-base HEAD ${requestedBaseRef} returned an empty SHA`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-gates-renderer-base-'));
  const baseDir = path.join(tempRoot, 'base');
  fs.mkdirSync(baseDir);

  try {
    const archive = spawn('git', ['archive', '--format=tar', baseSha], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    requireSuccess(archive, `git archive ${baseSha}`);

    const extract = spawn('tar', ['-x', '-C', baseDir], {
      input: archive.stdout,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    requireSuccess(extract, 'extract renderer capability base');

    const comparison = spawn('npm', [
      'run',
      'renderer:capability-diff',
      '--',
      '--base-renderer-dir',
      path.join(baseDir, 'src/renderer'),
      '--base-domains-path',
      path.join(baseDir, 'src/shared/ipc/domains.ts'),
      '--base-repo-root',
      baseDir,
      '--head-renderer-dir',
      'src/renderer',
      '--head-domains-path',
      'src/shared/ipc/domains.ts',
      '--head-repo-root',
      '.',
      '--fail-on-unsupported',
    ]);
    requireSuccess(comparison, 'renderer capability diff');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log('gates:local CI mapping');
console.log('Local exclusions (explicit; no silent skips):');
for (const exclusion of localExclusions) {
  console.log(`  - ${exclusion.ci}`);
  console.log(`    ${exclusion.reason}`);
}

for (const [index, gate] of gates.entries()) {
  const label = `[gates:local ${index + 1}/${gates.length}] ${gate.ci}`;
  console.log(`\n▶ ${label}`);
  const startedAt = Date.now();

  try {
    if (gate.run) {
      gate.run();
    } else {
      const result = spawn(gate.command, gate.args, { env: gate.env });
      requireSuccess(result, `${gate.command} ${gate.args.join(' ')}`);
    }
  } catch (error) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`\n✗ FAILED at ${label} (${elapsed}s)`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✓ PASSED ${label} (${elapsed}s)`);
}

console.log(`\n✓ gates:local passed all ${gates.length} locally reproducible PR gates.`);
