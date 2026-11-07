import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../scripts/acceptance/delegate-k2-eval.ts');

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, STEPFUN_API_KEY: '', ZHIPU_CODING_API_KEY: '' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('delegate-k2-eval --seed', () => {
  it('self-check reports the default seed when --seed is absent', () => {
    const out = run(['--self-check']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('self-check ok (seed=20261029)');
  });

  it('self-check honours an explicit --seed', () => {
    const out = run(['--self-check', '--seed', '20261102']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('self-check ok (seed=20261102)');
  });

  it('rejects a non-integer seed loudly', () => {
    const out = run(['--self-check', '--seed', 'abc']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('--seed');
  });
});
