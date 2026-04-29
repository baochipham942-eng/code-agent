import { describe, expect, it } from 'vitest';
import { runBatch, renderBatchMarkdown } from '../batch';
import type { BatchCase } from '../batch';
import { directionTokens } from '../../../../src/design/direction-tokens';
import type { CritiqueCaller } from '../../../../src/design/critique';

function makeCase(id: string, expectedMin?: number): BatchCase {
  return {
    id,
    expectedDirection: 'editorial',
    expectedMin,
    brief: {
      direction: 'editorial',
      directionTokens: directionTokens.editorial,
      surface: 'landing_page',
    },
    artifact: { kind: 'html', content: '<section><h1>x</h1></section>' },
  };
}

function jsonResponse(palette: number, typography: number, posture: number, surface: number, constraint: number) {
  return JSON.stringify({
    scores: [
      { dimension: 'palette', score: palette, reason: 'p' },
      { dimension: 'typography', score: typography, reason: 't' },
      { dimension: 'posture', score: posture, reason: 'po' },
      { dimension: 'surface', score: surface, reason: 's' },
      { dimension: 'constraint', score: constraint, reason: 'c' },
    ],
    summary: 'ok',
  });
}

function fixedCaller(response: string): CritiqueCaller {
  return async () => response;
}

function rotatingCaller(responses: string[]): CritiqueCaller {
  let i = 0;
  return async () => {
    const r = responses[i % responses.length];
    i += 1;
    return r;
  };
}

describe('runBatch', () => {
  it('aggregates primary judge averages without secondary', async () => {
    const cases = [makeCase('case-1'), makeCase('case-2')];
    const report = await runBatch(cases, {
      primary: { judge: 'kimi', caller: fixedCaller(jsonResponse(4, 4, 4, 4, 4)) },
      now: () => new Date('2026-04-29T00:00:00Z'),
    });

    expect(report.summary.caseCount).toBe(2);
    expect(report.summary.primaryAvgOverall).toBe(4);
    expect(report.summary.secondaryAvgOverall).toBeUndefined();
    expect(report.summary.meanAbsDiff).toBeUndefined();
    expect(report.cases).toHaveLength(2);
    expect(report.cases[0].primary.result?.overall).toBe(4);
    expect(report.generatedAt).toBe('2026-04-29T00:00:00.000Z');
  });

  it('computes per-dimension agreement and mean abs diff with secondary judge', async () => {
    const cases = [makeCase('case-1')];
    const report = await runBatch(cases, {
      primary: { judge: 'kimi', caller: fixedCaller(jsonResponse(5, 5, 5, 5, 5)) },
      secondary: { judge: 'deepseek', caller: fixedCaller(jsonResponse(3, 5, 4, 5, 1)) },
    });

    const c = report.cases[0];
    expect(c.agreement).toBeDefined();
    expect(c.agreement!.perDimension.palette).toBe(2);
    expect(c.agreement!.perDimension.typography).toBe(0);
    expect(c.agreement!.perDimension.posture).toBe(1);
    expect(c.agreement!.perDimension.surface).toBe(0);
    expect(c.agreement!.perDimension.constraint).toBe(4);
    expect(c.agreement!.meanAbsDiff).toBeCloseTo(1.4, 2);
    expect(report.summary.meanAbsDiff).toBeCloseTo(1.4, 2);
  });

  it('marks expectedMet when primary overall meets expectedMin', async () => {
    const cases = [
      makeCase('pass', 3.5),
      makeCase('fail', 4.5),
    ];
    const report = await runBatch(cases, {
      primary: { judge: 'kimi', caller: fixedCaller(jsonResponse(4, 4, 4, 4, 4)) },
    });

    const byId = new Map(report.cases.map((c) => [c.id, c]));
    expect(byId.get('pass')!.expectedMet).toBe(true);
    expect(byId.get('fail')!.expectedMet).toBe(false);
    expect(report.summary.expectedMetRate).toBe(0.5);
  });

  it('captures caller errors per case without aborting batch', async () => {
    const cases = [makeCase('ok'), makeCase('boom')];
    let i = 0;
    const caller: CritiqueCaller = async () => {
      i += 1;
      if (i === 2) throw new Error('network');
      return jsonResponse(4, 4, 4, 4, 4);
    };
    const report = await runBatch(cases, { primary: { judge: 'kimi', caller } });

    expect(report.cases[0].primary.result).toBeDefined();
    expect(report.cases[1].primary.result).toBeUndefined();
    expect(report.cases[1].primary.error).toContain('network');
  });

  it('rotating caller per judge stays isolated', async () => {
    const cases = [makeCase('case-1'), makeCase('case-2')];
    const primary = rotatingCaller([jsonResponse(5, 5, 5, 5, 5), jsonResponse(3, 3, 3, 3, 3)]);
    const secondary = rotatingCaller([jsonResponse(4, 4, 4, 4, 4), jsonResponse(2, 2, 2, 2, 2)]);
    const report = await runBatch(cases, {
      primary: { judge: 'kimi', caller: primary },
      secondary: { judge: 'deepseek', caller: secondary },
    });
    expect(report.cases[0].primary.result?.overall).toBe(5);
    expect(report.cases[1].primary.result?.overall).toBe(3);
    expect(report.cases[0].secondary?.result?.overall).toBe(4);
    expect(report.cases[1].secondary?.result?.overall).toBe(2);
  });
});

describe('renderBatchMarkdown', () => {
  it('produces a readable markdown report', async () => {
    const report = await runBatch([makeCase('case-1', 3)], {
      primary: { judge: 'kimi', caller: fixedCaller(jsonResponse(4, 4, 4, 4, 4)) },
      secondary: { judge: 'deepseek', caller: fixedCaller(jsonResponse(3, 4, 4, 4, 4)) },
    });
    const md = renderBatchMarkdown(report);
    expect(md).toContain('# Critique Batch Report');
    expect(md).toContain('case-1');
    expect(md).toContain('primary (kimi)');
    expect(md).toContain('secondary (deepseek)');
    expect(md).toContain('expectedMet: YES');
    expect(md).toContain('agreement meanAbsDiff:');
  });
});
