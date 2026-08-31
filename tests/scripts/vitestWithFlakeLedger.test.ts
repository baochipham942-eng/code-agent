import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const wrapper = resolve('scripts/ci/vitest-with-flake-ledger.mjs');
const roots: string[] = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), 'vitest-flake-ledger-'));
  roots.push(value);
  return value;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function fixtureRunner(dir: string, report: object, status = 0) {
  const file = join(dir, 'reporter-fixture.mjs');
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs';",
    "const output = process.argv.find((arg) => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);",
    `writeFileSync(output, ${JSON.stringify(JSON.stringify(report))});`,
    "writeFileSync(process.env.VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE, JSON.stringify({ testDiagnostics: [] }));",
    `process.exit(${status});`,
  ].join('\n'));
  return file;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vitest flake ledger wrapper', () => {
  it('writes retryCount entries from the real Vitest JSON path and keeps zero retries visible', () => {
    const dir = root();
    const ledger = join(dir, 'ledger.jsonl');
    const flaky = fixtureRunner(dir, {
      testResults: [{ name: 'tests/example.test.ts', assertionResults: [{
        fullName: 'suite retries once', retryCount: 1, flaky: true,
      }] }],
    });
    const flakyResult = run(['--job', 'fixture retry', '--ledger', ledger, '--', process.execPath, flaky]);
    expect(flakyResult.status, flakyResult.stderr).toBe(0);
    expect(flakyResult.stdout).toContain('tests/example.test.ts:suite retries once:1 (flaky=true)');
    expect(readFileSync(ledger, 'utf8')).toContain('"retryCount":1');

    const zeroLedger = join(dir, 'zero-ledger.jsonl');
    const zero = fixtureRunner(dir, {
      testResults: [{ name: 'tests/zero.test.ts', assertionResults: [{ fullName: 'suite stays green', retryCount: 0 }] }],
    });
    const zeroResult = run(['--job', 'fixture zero', '--ledger', zeroLedger, '--', process.execPath, zero]);
    expect(zeroResult.status, zeroResult.stderr).toBe(0);
    expect(zeroResult.stdout).toContain('retryCount>0: 0');
    expect(() => readFileSync(zeroLedger, 'utf8')).toThrow();
  });

  it('records a genuine first-red second-green Vitest retry without changing its green exit code', () => {
    const dir = root();
    const ledger = join(dir, 'mutation-ledger.jsonl');
    const marker = join(dir, 'first-attempt.marker');
    const result = run([
      '--job', 'mutation retry', '--ledger', ledger, '--', 'npx', 'vitest', 'run',
      'tests/scripts/vitestFlakeLedgerRetry.fixture.test.ts', '--retry=1',
    ], { N_FLAKE_LEDGER_RETRY_FILE: marker });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('vitestFlakeLedgerRetry.fixture.test.ts:is stable until the ledger mutation asks for one retry:1');
    expect(readFileSync(ledger, 'utf8')).toContain('"retryCount":1');
  });

  it('passes through a genuine failing Vitest exit code', () => {
    const dir = root();
    const result = run([
      '--job', 'failing retry', '--ledger', join(dir, 'failing-ledger.jsonl'), '--', 'npx', 'vitest', 'run',
      'tests/scripts/vitestFlakeLedgerRetry.fixture.test.ts', '--retry=1',
    ], { N_FLAKE_LEDGER_ALWAYS_FAIL: '1' });
    expect(result.status).toBe(1);
  });

  it('keeps every retrying CI execution point behind the wrapper', () => {
    const swarm = readFileSync('.github/workflows/swarm-ci.yml', 'utf8');
    const full = readFileSync('.github/workflows/main-full-gate.yml', 'utf8');
    for (const step of [
      'Script gates (vitest tests/scripts)',
      'Main-chain vitest subset (agent / tools / ipc / services / design / renderer)',
      'MCP protocol compatibility (unit + integration)',
      'Run swarm smoke suite',
      'Run smoke suite',
    ]) {
      const start = swarm.indexOf(`- name: ${step}`);
      expect(start, step).toBeGreaterThan(-1);
      expect(swarm.slice(start, swarm.indexOf('\n      - name:', start + 1))).toContain('scripts/ci/vitest-with-flake-ledger.mjs');
    }
    expect(full.slice(full.indexOf('- name: Full vitest'))).toContain('scripts/ci/vitest-with-flake-ledger.mjs');
  });
});
