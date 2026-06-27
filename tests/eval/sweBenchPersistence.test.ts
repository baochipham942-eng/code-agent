import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSweBenchRun, persistSweBenchRun, toCanonicalSweBenchRun } from '../../benchmarks/swe-bench/persistence';

describe('SWE-bench Eval Center persistence bridge', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function writeRun(
    result: Record<string, unknown>,
    trace: Array<Record<string, unknown>> = [],
    runName = '2026-04-28-django__django-15987-single',
  ): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-bench-persist-'));
    const runDir = path.join(tempDir, runName);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
    fs.writeFileSync(path.join(runDir, 'agent.diff'), 'diff --git a/file b/file\n');
    fs.writeFileSync(path.join(runDir, 'standard.patch'), 'diff --git a/file b/file\n');
    return runDir;
  }

  it('maps SWE-bench gate output into the canonical experiment contract', () => {
    const runDir = writeRun({
      instance_id: 'django__django-15987',
      repo: 'django/django',
      model: 'mimo-v2.5-pro',
      rounds_used: 6,
      finished: true,
      passed: false,
      status: 'failed',
      failure_reasons: ['judge_below_threshold', 'judge_implementation_mismatch'],
      executable_validation: {
        status: 'passed',
        duration_ms: 524,
        reason: 'tests_passed',
      },
      judge: {
        semantic_match: 30,
        matches_intent: true,
        matches_implementation: false,
      },
      tokens: { input: 100, output: 20 },
    }, [
      { round: 1, tool: 'grep_search', args: { pattern: 'FIXTURE_DIRS' } },
      { round: 2, tool: 'edit_file', args: { path: 'django/core/management/commands/loaddata.py' } },
    ]);

    const canonical = toCanonicalSweBenchRun(loadSweBenchRun(runDir));

    expect(canonical).toMatchObject({
      runId: '2026-04-28-django__django-15987-single',
      source: 'swe-bench',
      aggregation: 'swe_bench_gates',
      environment: {
        model: 'mimo-v2.5-pro',
        provider: 'xiaomi',
      },
      totals: {
        total: 1,
        passed: 0,
        failed: 1,
        averageScore: 30,
      },
    });
    expect(canonical.cases[0]).toMatchObject({
      caseId: 'django__django-15987',
      status: 'failed',
      score: 30,
      failureStage: 'llm_scoring',
      failureReason: 'judge_below_threshold, judge_implementation_mismatch',
    });
    expect(canonical.cases[0].metadata?.toolTrace).toEqual([
      { round: 1, tool: 'grep_search', args: { pattern: 'FIXTURE_DIRS' } },
      { round: 2, tool: 'edit_file', args: { path: 'django/core/management/commands/loaddata.py' } },
    ]);
  });

  it('persists imported runs through the existing ExperimentAdapter path', () => {
    const runDir = writeRun({
      instance_id: 'django__django-16642',
      repo: 'django/django',
      model: 'mimo-v2.5-pro',
      finished: true,
      passed: true,
      status: 'passed',
      executable_validation: { status: 'passed', duration_ms: 400 },
      judge: { semantic_match: 95, matches_implementation: true },
    }, [], '2026-04-28-django__django-16642-judge-v1');
    const db = {
      insertExperiment: vi.fn(),
      insertExperimentCases: vi.fn(),
    };

    const experimentId = persistSweBenchRun(db as unknown as Parameters<typeof persistSweBenchRun>[0], runDir);

    expect(experimentId).toBe('2026-04-28-django__django-16642-judge-v1');
    expect(db.insertExperiment).toHaveBeenCalledWith(expect.objectContaining({
      id: '2026-04-28-django__django-16642-judge-v1',
      source: 'swe-bench',
      scope: 'swe-bench',
      model: 'mimo-v2.5-pro',
      provider: 'xiaomi',
    }));
    expect(db.insertExperimentCases).toHaveBeenCalledWith(
      '2026-04-28-django__django-16642-judge-v1',
      [expect.objectContaining({
        case_id: 'django__django-16642',
        status: 'passed',
        score: 100,
      })],
    );
  });
});
