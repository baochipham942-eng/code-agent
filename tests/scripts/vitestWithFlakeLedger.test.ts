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

function fixtureRunner(dir: string, diagnostics: object, options: {
  report?: object;
  reportText?: string;
  status?: number;
  writeReport?: boolean;
} = {}) {
  const file = join(dir, 'reporter-fixture.mjs');
  const reportText = options.reportText ?? JSON.stringify(options.report ?? { testResults: [] });
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs';",
    "const output = process.argv.find((arg) => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);",
    ...(options.writeReport === false ? [] : [`writeFileSync(output, ${JSON.stringify(reportText)});`]),
    `writeFileSync(process.env.VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE, ${JSON.stringify(JSON.stringify(diagnostics))});`,
    `process.exit(${options.status ?? 0});`,
  ].join('\n'));
  return file;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vitest flake ledger wrapper', () => {
  it('writes retryCount entries from testDiagnostics[] and keeps zero retries visible', () => {
    const dir = root();
    const ledger = join(dir, 'ledger.jsonl');
    const flaky = fixtureRunner(dir, {
      testDiagnostics: [{ file: 'tests/example.test.ts', test: 'suite retries once', retryCount: 1, flaky: true }],
    });
    const flakyResult = run(['--job', 'fixture retry', '--ledger', ledger, '--', process.execPath, flaky]);
    expect(flakyResult.status, flakyResult.stderr).toBe(0);
    expect(flakyResult.stdout).toContain('tests/example.test.ts:suite retries once:1 (flaky=true)');
    expect(readFileSync(ledger, 'utf8')).toContain('"retryCount":1');

    const zeroLedger = join(dir, 'zero-ledger.jsonl');
    const zero = fixtureRunner(dir, {
      testDiagnostics: [{ file: 'tests/zero.test.ts', test: 'suite stays green', retryCount: 0, flaky: false }],
    });
    const zeroResult = run(['--job', 'fixture zero', '--ledger', zeroLedger, '--', process.execPath, zero]);
    expect(zeroResult.status, zeroResult.stderr).toBe(0);
    expect(zeroResult.stdout).toContain('retryCount>0: 0');
    expect(() => readFileSync(zeroLedger, 'utf8')).toThrow();
  });

  it('fails loud when the Vitest JSON report is missing', () => {
    const dir = root();
    const runner = fixtureRunner(dir, { testDiagnostics: [] }, { writeReport: false });
    const result = run(['--job', 'missing report', '--ledger', join(dir, 'ledger.jsonl'), '--', process.execPath, runner]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('JSON reporter did not create');
  });

  it('fails loud when the Vitest JSON report cannot be parsed', () => {
    const dir = root();
    const runner = fixtureRunner(dir, { testDiagnostics: [] }, { reportText: '{not-json' });
    const result = run(['--job', 'invalid report', '--ledger', join(dir, 'ledger.jsonl'), '--', process.execPath, runner]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot parse JSON reporter output');
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
    for (const anchor of [
      'tests/scripts --retry=1',
      'tests/renderer "${ROOT_UNIT_TESTS[@]}" tests/unit/web/agentRunControllerBroadcast.test.ts --retry=1',
      "--exclude 'tests/unit/tools/modules/network/webSearch.test.ts'",
      "--exclude 'tests/unit/agent/goalVerifyGate.test.ts'",
      'tests/unit/mcp tests/integration/mcp --retry=1',
      'npm run test:swarm:smoke -- --retry=1',
    ]) expect(swarm).toContain(anchor);
    expect(full).toContain('npx vitest run --retry=1');
  });

  it('keeps all three local retry mirrors behind the wrapper', () => {
    const local = readFileSync('scripts/gates-local.mjs', 'utf8');
    const retryOffsets = [...local.matchAll(/'--retry=1'/g)].map((match) => match.index ?? -1);
    expect(retryOffsets).toHaveLength(3);
    for (const offset of retryOffsets) {
      const objectStart = local.lastIndexOf('\n  {', offset);
      expect(local.slice(objectStart, offset)).toContain('scripts/ci/vitest-with-flake-ledger.mjs');
    }
  });
});
