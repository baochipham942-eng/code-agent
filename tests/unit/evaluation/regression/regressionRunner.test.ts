// ============================================================================
// Regression Runner + Gate Decision Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  runRegression,
  decideGate,
} from '../../../../src/main/evaluation/regression/regressionRunner';
import type { CaseResult } from '../../../../src/main/evaluation/regression/regressionTypes';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

async function makeCaseDir(
  cases: Array<{ id: string; evalCommand: string }>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-runner-'));
  for (const c of cases) {
    await fs.writeFile(
      path.join(dir, `${c.id}.md`),
      `---
id: ${c.id}
source: test
tags: []
eval_command: "${c.evalCommand}"
---
## 场景
x
## 预期行为
y
`,
    );
  }
  return dir;
}

describe('regressionRunner', () => {
  it('runs all cases and reports pass/fail', async () => {
    const dir = await makeCaseDir([
      { id: 'reg-a', evalCommand: 'true' },
      { id: 'reg-b', evalCommand: 'false' },
      { id: 'reg-c', evalCommand: 'true' },
    ]);

    const report = await runRegression(dir);
    expect(report.totalCases).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(2 / 3, 2);

    const failed = report.results.find((r) => r.id === 'reg-b');
    expect(failed?.status).toBe('fail');

    await fs.rm(dir, { recursive: true });
  });

  it('marks case as error when command times out', async () => {
    const dir = await makeCaseDir([{ id: 'reg-slow', evalCommand: 'sleep 5' }]);
    const report = await runRegression(dir, { timeoutMs: 200 });
    expect(report.results[0].status).toBe('error');
    expect(report.results[0].errorMessage).toMatch(/timeout/i);
    await fs.rm(dir, { recursive: true });
  });

  it('decideGate blocks when pass rate drops more than threshold', () => {
    const results: CaseResult[] = [
      {
        id: 'reg-a',
        status: 'pass',
        durationMs: 1,
        stdout: '',
        stderr: '',
        exitCode: 0,
      },
      {
        id: 'reg-b',
        status: 'fail',
        durationMs: 1,
        stdout: '',
        stderr: '',
        exitCode: 1,
      },
    ];
    const decision = decideGate({
      current: { passRate: 0.8, passed: 8, totalCases: 10, results },
      baseline: {
        passRate: 0.9,
        passed: 9,
        totalCases: 10,
        capturedAt: '',
      },
      thresholdPct: 5,
    });
    expect(decision.decision).toBe('block');
    expect(decision.delta).toBeCloseTo(-0.1, 2);
    expect(decision.blockedCases).toContain('reg-b');
  });

  it('decideGate passes when no baseline exists yet', () => {
    const decision = decideGate({
      current: { passRate: 0.5, passed: 5, totalCases: 10, results: [] },
      baseline: null,
      thresholdPct: 5,
    });
    expect(decision.decision).toBe('pass');
    expect(decision.reason).toMatch(/no baseline/i);
  });

  it('decideGate passes when improvement exceeds threshold', () => {
    const decision = decideGate({
      current: { passRate: 0.95, passed: 19, totalCases: 20, results: [] },
      baseline: {
        passRate: 0.85,
        passed: 17,
        totalCases: 20,
        capturedAt: '',
      },
      thresholdPct: 5,
    });
    expect(decision.decision).toBe('pass');
    expect(decision.delta).toBeCloseTo(0.1, 2);
  });
});
