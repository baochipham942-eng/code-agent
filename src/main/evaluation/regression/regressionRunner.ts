import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadAllCases } from './caseLoader';
import type {
  Baseline,
  CaseResult,
  GateDecision,
  RegressionCase,
  RegressionReport,
} from './regressionTypes';

export interface RunOptions {
  timeoutMs?: number;
  /** 只运行 categories 与此集合有交集的 case；为空则运行全部 */
  filterCategories?: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runRegression(
  casesDir: string,
  opts: RunOptions = {},
): Promise<RegressionReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allCases = await loadAllCases(casesDir);
  const cases = filterCasesByCategory(allCases, opts.filterCategories);
  const startedAt = Date.now();

  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runOne(c, timeoutMs));
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const errored = results.filter((r) => r.status === 'error').length;

  return {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    totalCases: cases.length,
    passed,
    failed,
    errored,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    results,
    durationMs: Date.now() - startedAt,
  };
}

/** 按 categories 过滤：case.categories 与 filter 有交集则保留；无 filter 保留全部 */
export function filterCasesByCategory(
  cases: RegressionCase[],
  filterCategories?: string[],
): RegressionCase[] {
  if (!filterCategories || filterCategories.length === 0) return cases;
  const filterSet = new Set(filterCategories.map((c) => c.toLowerCase()));
  return cases.filter((c) => {
    if (!c.categories || c.categories.length === 0) return false;
    return c.categories.some((cat) => filterSet.has(cat.toLowerCase()));
  });
}

export async function runOne(c: RegressionCase, timeoutMs: number): Promise<CaseResult> {
  const startedAt = Date.now();
  return new Promise<CaseResult>((resolve) => {
    const child = execFile(
      'bash',
      ['-c', c.evalCommand],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const stdoutStr = String(stdout ?? '');
        const stderrStr = String(stderr ?? '');

        // execFile's timeout kills the child with SIGTERM; detect via killed flag.
        const killedByTimeout =
          err !== null &&
          typeof err === 'object' &&
          ('killed' in err ? (err as { killed?: boolean }).killed === true : false);

        if (killedByTimeout) {
          resolve({
            id: c.id,
            status: 'error',
            durationMs,
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: -1,
            errorMessage: `timeout after ${timeoutMs}ms`,
          });
          return;
        }

        // execFile: err is null on exit 0, otherwise err.code holds the exit code (number) or signal name (string).
        let exitCode = 0;
        if (err) {
          const codeField = (err as { code?: unknown }).code;
          exitCode = typeof codeField === 'number' ? codeField : 1;
        }

        resolve({
          id: c.id,
          status: exitCode === 0 ? 'pass' : 'fail',
          durationMs,
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode,
        });
      },
    );
    child.on('error', (e) => {
      resolve({
        id: c.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        exitCode: -1,
        errorMessage: e.message,
      });
    });
  });
}

interface DecideGateInput {
  current: {
    passRate: number;
    passed: number;
    totalCases: number;
    results: CaseResult[];
  };
  baseline: Baseline | null;
  thresholdPct: number;
}

export function decideGate(input: DecideGateInput): GateDecision {
  const { current, baseline, thresholdPct } = input;
  if (!baseline) {
    return {
      decision: 'pass',
      currentPassRate: current.passRate,
      baselinePassRate: 0,
      delta: 0,
      blockedCases: [],
      reason: 'no baseline yet — current run will be used as baseline',
    };
  }
  const delta = current.passRate - baseline.passRate;
  const threshold = -thresholdPct / 100;
  if (delta < threshold) {
    const blockedCases = current.results
      .filter((r) => r.status === 'fail' || r.status === 'error')
      .map((r) => r.id);
    return {
      decision: 'block',
      currentPassRate: current.passRate,
      baselinePassRate: baseline.passRate,
      delta,
      blockedCases,
      reason: `pass rate dropped ${(delta * 100).toFixed(1)}pp (threshold ${thresholdPct}pp)`,
    };
  }
  return {
    decision: 'pass',
    currentPassRate: current.passRate,
    baselinePassRate: baseline.passRate,
    delta,
    blockedCases: [],
    reason:
      delta >= 0
        ? `pass rate maintained or improved (+${(delta * 100).toFixed(1)}pp)`
        : `pass rate dropped ${(delta * 100).toFixed(1)}pp but within threshold`,
  };
}
