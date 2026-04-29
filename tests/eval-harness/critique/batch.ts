import {
  CRITIQUE_DIMENSIONS,
  runCritique,
} from '../../../src/design/critique';
import type {
  CritiqueCaller,
  CritiqueDimension,
  CritiqueInput,
  CritiqueResult,
} from '../../../src/design/critique';

export interface BatchCase extends CritiqueInput {
  id: string;
  expectedDirection?: string;
  expectedMin?: number;
}

export interface BatchJudgeRun {
  judge: string;
  result?: CritiqueResult;
  error?: string;
}

export interface BatchCaseResult {
  id: string;
  expectedDirection?: string;
  expectedMin?: number;
  primary: BatchJudgeRun;
  secondary?: BatchJudgeRun;
  agreement?: BatchAgreement;
  expectedMet?: boolean;
}

export interface BatchAgreement {
  perDimension: Record<CritiqueDimension, number>;
  meanAbsDiff: number;
}

export interface BatchSummary {
  caseCount: number;
  primaryAvgOverall: number;
  secondaryAvgOverall?: number;
  meanAbsDiff?: number;
  expectedMetRate?: number;
}

export interface BatchReport {
  generatedAt: string;
  summary: BatchSummary;
  cases: BatchCaseResult[];
}

export interface BatchOptions {
  primary: { judge: string; caller: CritiqueCaller };
  secondary?: { judge: string; caller: CritiqueCaller };
  now?: () => Date;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

function computeAgreement(a: CritiqueResult, b: CritiqueResult): BatchAgreement {
  const aMap = new Map(a.scores.map((s) => [s.dimension, s.score]));
  const bMap = new Map(b.scores.map((s) => [s.dimension, s.score]));
  const perDimension = {} as Record<CritiqueDimension, number>;
  const diffs: number[] = [];
  for (const dim of CRITIQUE_DIMENSIONS) {
    const av = aMap.get(dim) ?? 0;
    const bv = bMap.get(dim) ?? 0;
    const diff = Math.abs(av - bv);
    perDimension[dim] = diff;
    diffs.push(diff);
  }
  return { perDimension, meanAbsDiff: average(diffs) };
}

async function judgeOnce(
  judge: string,
  caller: CritiqueCaller,
  input: CritiqueInput,
): Promise<BatchJudgeRun> {
  try {
    const result = await runCritique(input, { caller });
    return { judge, result };
  } catch (err) {
    return { judge, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBatch(cases: BatchCase[], options: BatchOptions): Promise<BatchReport> {
  const results: BatchCaseResult[] = [];

  for (const c of cases) {
    const input: CritiqueInput = { brief: c.brief, artifact: c.artifact };
    const primary = await judgeOnce(options.primary.judge, options.primary.caller, input);
    const secondary = options.secondary
      ? await judgeOnce(options.secondary.judge, options.secondary.caller, input)
      : undefined;

    let agreement: BatchAgreement | undefined;
    if (primary.result && secondary?.result) {
      agreement = computeAgreement(primary.result, secondary.result);
    }

    let expectedMet: boolean | undefined;
    if (primary.result && typeof c.expectedMin === 'number') {
      expectedMet = primary.result.overall >= c.expectedMin;
    }

    results.push({
      id: c.id,
      expectedDirection: c.expectedDirection,
      expectedMin: c.expectedMin,
      primary,
      secondary,
      agreement,
      expectedMet,
    });
  }

  const primaryOveralls = results
    .map((r) => r.primary.result?.overall)
    .filter((v): v is number => typeof v === 'number');
  const secondaryOveralls = results
    .map((r) => r.secondary?.result?.overall)
    .filter((v): v is number => typeof v === 'number');
  const diffs = results
    .map((r) => r.agreement?.meanAbsDiff)
    .filter((v): v is number => typeof v === 'number');
  const expectedMetRuns = results.filter((r) => typeof r.expectedMet === 'boolean');

  const summary: BatchSummary = {
    caseCount: cases.length,
    primaryAvgOverall: average(primaryOveralls),
  };
  if (secondaryOveralls.length > 0) summary.secondaryAvgOverall = average(secondaryOveralls);
  if (diffs.length > 0) summary.meanAbsDiff = average(diffs);
  if (expectedMetRuns.length > 0) {
    const passed = expectedMetRuns.filter((r) => r.expectedMet).length;
    summary.expectedMetRate = Math.round((passed / expectedMetRuns.length) * 100) / 100;
  }

  const now = options.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    summary,
    cases: results,
  };
}

export function renderBatchMarkdown(report: BatchReport): string {
  const lines: string[] = [];
  lines.push(`# Critique Batch Report`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- caseCount: ${report.summary.caseCount}`);
  lines.push(`- primary avg overall: ${report.summary.primaryAvgOverall}`);
  if (typeof report.summary.secondaryAvgOverall === 'number') {
    lines.push(`- secondary avg overall: ${report.summary.secondaryAvgOverall}`);
  }
  if (typeof report.summary.meanAbsDiff === 'number') {
    lines.push(`- mean abs diff (5-dim): ${report.summary.meanAbsDiff}`);
  }
  if (typeof report.summary.expectedMetRate === 'number') {
    lines.push(`- expectedMetRate: ${report.summary.expectedMetRate}`);
  }
  lines.push('');
  lines.push(`## Cases`);
  lines.push('');
  for (const c of report.cases) {
    lines.push(`### ${c.id}`);
    if (c.expectedDirection) lines.push(`- expectedDirection: ${c.expectedDirection}`);
    if (typeof c.expectedMin === 'number') lines.push(`- expectedMin: ${c.expectedMin}`);
    if (c.primary.result) {
      lines.push(`- primary (${c.primary.judge}): overall=${c.primary.result.overall}`);
      for (const s of c.primary.result.scores) {
        lines.push(`  - ${s.dimension}: ${s.score} — ${s.reason}`);
      }
      lines.push(`  - summary: ${c.primary.result.summary}`);
    } else {
      lines.push(`- primary (${c.primary.judge}): ERROR ${c.primary.error}`);
    }
    if (c.secondary) {
      if (c.secondary.result) {
        lines.push(`- secondary (${c.secondary.judge}): overall=${c.secondary.result.overall}`);
      } else {
        lines.push(`- secondary (${c.secondary.judge}): ERROR ${c.secondary.error}`);
      }
    }
    if (c.agreement) {
      lines.push(`- agreement meanAbsDiff: ${c.agreement.meanAbsDiff}`);
    }
    if (typeof c.expectedMet === 'boolean') {
      lines.push(`- expectedMet: ${c.expectedMet ? 'YES' : 'NO'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
