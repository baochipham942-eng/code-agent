import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/coverage-ratchet.mjs');
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coverage-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'coverage'), { recursive: true });
  const baseline = {
    schemaVersion: 1,
    statements: 40,
    branches: 35,
    functions: 38,
    lines: 41,
    measuredAt: '2026-08-31T00:00:00Z',
    source: 'fixture',
  };
  writeFileSync(join(root, 'scripts/coverage-ratchet-baseline.json'), JSON.stringify(baseline));
  writeFileSync(join(root, 'coverage/coverage-summary.json'), JSON.stringify({
    total: Object.fromEntries(Object.entries(baseline)
      .filter(([key]) => ['statements', 'branches', 'functions', 'lines'].includes(key))
      .map(([key, pct]) => [key, { pct }])),
  }));
  return { root, baseline };
}

function run(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--repo-root', root, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coverage-ratchet', () => {
  it('四项实测值持平时通过，任一项低于基线时报红', () => {
    const { root, baseline } = fixture();
    const green = run(root);
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout).toContain('四项覆盖率均与基线持平');

    writeFileSync(join(root, 'scripts/coverage-ratchet-baseline.json'), JSON.stringify({ ...baseline, lines: 42 }));
    const red = run(root);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('lines 低于基线 1.00 个百分点');
  });

  it('产物缺失、JSON 无法解析、四项字段缺失都 fail loud', () => {
    const { root } = fixture();
    rmSync(join(root, 'coverage/coverage-summary.json'));
    expect(run(root).stderr).toContain('无法读取 coverage-summary');

    writeFileSync(join(root, 'coverage/coverage-summary.json'), '{bad-json');
    expect(run(root).stderr).toContain('coverage-summary JSON 无法解析');

    writeFileSync(join(root, 'coverage/coverage-summary.json'), JSON.stringify({ total: { statements: { pct: 40 } } }));
    expect(run(root).stderr).toContain('缺少有效的 branches.pct');
  });

  it('基线只许升不许降', () => {
    const { root, baseline } = fixture();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });

    writeFileSync(join(root, 'scripts/coverage-ratchet-baseline.json'), JSON.stringify({ ...baseline, branches: 34 }));
    const result = run(root, ['--baseline-only', '--compare-baseline', 'HEAD']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('branches 基线被放宽：35.00% -> 34.00%');
    expect(result.stderr).toContain('只许升不许降');
  });

  it('改动行报表只计可执行行，并列出未执行行', () => {
    const { root } = fixture();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    mkdirSync(join(root, 'src'), { recursive: true });
    const source = join(root, 'src/example.ts');
    writeFileSync(source, 'export const covered = 1;\nexport const uncovered = 2;\n// non-executable\n');
    execFileSync('git', ['add', 'src/example.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add source'], { cwd: root });
    writeFileSync(join(root, 'coverage/coverage-final.json'), JSON.stringify({
      [source]: {
        path: source,
        statementMap: {
          0: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
          1: { start: { line: 1, column: 26 }, end: { line: 1, column: 27 } },
          2: { start: { line: 2, column: 0 }, end: { line: 2, column: 27 } },
        },
        // Istanbul marks line 1 executed because one statement ran; line 2 is
        // an executable but uncovered changed line.
        s: { 0: 1, 1: 0, 2: 0 },
      },
    }));

    const result = run(root, ['--changed-lines', '--diff-base', base, '--diff-head', 'HEAD']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Changed source lines: 3; executable changed lines: 2; executed: 1; rate: 50.00%');
    expect(result.stdout).toContain('| `src/example.ts` | 3 | 2 | 1 | 50.00% | 2 |');
  });

  it('全量 coverage 只挂合后主门，PR 仅检查基线方向', () => {
    const mainFullGate = readFileSync('.github/workflows/main-full-gate.yml', 'utf8');
    const swarmCi = readFileSync('.github/workflows/swarm-ci.yml', 'utf8');
    const vitestConfig = readFileSync('vitest.config.ts', 'utf8');

    expect(mainFullGate).toContain('npx vitest run --retry=1 --coverage');
    expect(mainFullGate).toContain('node scripts/coverage-ratchet.mjs --compare-baseline');
    expect(mainFullGate).toContain('Changed-line execution report (non-blocking)');
    expect(mainFullGate).toContain('continue-on-error: true');
    expect(swarmCi).toContain("'scripts/coverage-ratchet-baseline.json'");
    expect(swarmCi).toContain('--baseline-only --compare-baseline origin/main');
    expect(swarmCi).not.toMatch(/vitest[^\n]*--coverage/);
    expect(vitestConfig).not.toContain('thresholds:');
  });
});
