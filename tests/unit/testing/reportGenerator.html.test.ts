import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  generateHtmlReport,
  saveReport,
} from '../../../src/host/testing/reportGenerator';
import type { BaselineDelta, TestResult, TestRunSummary, Trajectory } from '../../../src/host/testing/types';

function makeResult(overrides: Partial<TestResult>): TestResult {
  return {
    testId: 'case-a',
    description: 'desc',
    status: 'passed',
    duration: 100,
    startTime: 0,
    endTime: 100,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    score: 1,
    scoreAuthority: 'deterministic_assertion',
    ...overrides,
  };
}

function makeSummary(results: TestResult[]): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    partial: results.filter((r) => r.status === 'partial').length,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    averageScore: 0.67,
    results,
    environment: { model: 'mock-model', provider: 'mock-provider', workingDirectory: '/tmp/work' },
    performance: { avgResponseTime: 12, maxResponseTime: 34, totalToolCalls: 2, totalTurns: 3 },
  };
}

function makeDelta(overrides: Partial<BaselineDelta> = {}): BaselineDelta {
  return {
    isFirstRun: false,
    passRateDelta: -0.1,
    scoreDelta: 0.05,
    newFailures: [{ testId: 'case-fail', previousStatus: 'passed', currentStatus: 'failed', reason: 'regressed' }],
    newPasses: [{ testId: 'case-pass' }],
    isRegression: true,
    regressionDetails: ['1 new failure'],
    ...overrides,
  };
}

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: 'traj-case',
    sessionId: 'session-case',
    startTime: 0,
    endTime: 100,
    steps: [
      {
        index: 0,
        timestamp: 0,
        type: 'tool_call',
        toolCall: {
          name: 'Read',
          args: { file_path: 'package.json' },
          success: true,
          duration: 20,
        },
      },
      {
        index: 1,
        timestamp: 30,
        type: 'tool_call',
        toolCall: {
          name: 'Read',
          args: { file_path: 'package.json' },
          success: false,
          duration: 30,
        },
      },
    ],
    deviations: [],
    recoveryPatterns: [],
    efficiency: {
      totalSteps: 2,
      effectiveSteps: 0,
      redundantSteps: 2,
      backtrackCount: 1,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 50,
      tokensPerEffectiveStep: 0,
      efficiency: 0,
    },
    summary: {
      intent: 'Read package.json',
      outcome: 'partial',
      criticalPath: [0],
    },
    ...overrides,
  };
}

describe('generateHtmlReport', () => {
  it('emits a self-contained HTML document without external links or assets', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({ testId: 'case-a' }),
    ]));

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(html).not.toMatch(/\b(?:href|src)=["']https?:\/\//i);
  });

  it('escapes case text, prompt text, responses, errors, and failure details', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({
        testId: '<case&1>',
        description: 'desc <img src=x onerror=alert(1)>',
        status: 'failed',
        prompt: 'make <script>alert(1)</script> & continue',
        followUpPrompts: ['follow "quoted" <b>bold</b>'],
        responses: ['raw <svg onload=alert(1)>'],
        errors: ['boom <x>'],
        failureReason: 'expected <ok>',
        failureDetails: {
          expected: { value: '<safe>' },
          actual: { value: '<unsafe>' },
          assertion: 'response_contains <ok>',
        },
        score: 0,
      }),
    ]));

    expect(html).toContain('&lt;case&amp;1&gt;');
    expect(html).toContain('make &lt;script&gt;alert(1)&lt;/script&gt; &amp; continue');
    expect(html).toContain('follow &quot;quoted&quot; &lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&lt;safe&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('onerror=alert');
  });

  it('uses a capability denominator that excludes skipped and infra_excluded results', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({ testId: 'pass-1', status: 'passed', score: 1 }),
      makeResult({ testId: 'pass-2', status: 'passed', score: 1 }),
      makeResult({ testId: 'fail-1', status: 'failed', score: 0 }),
      makeResult({ testId: 'skip-1', status: 'skipped', score: 0 }),
      makeResult({ testId: 'infra-1', status: 'infra_excluded', score: 0, failureReason: '429' }),
    ]));

    expect(html).toContain('data-testid="capability-denominator">3</span>');
    expect(html).toContain('data-testid="pass-rate">66.7%</span>');
    expect(html).toContain('data-testid="infra-excluded-count">1</span>');
  });

  it('colors the pass, partial, and fail buckets while keeping infra_excluded separate', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({ testId: 'pass-1', status: 'passed', score: 1 }),
      makeResult({ testId: 'partial-1', status: 'partial', score: 0.5 }),
      makeResult({ testId: 'fail-1', status: 'failed', score: 0 }),
      makeResult({ testId: 'infra-1', status: 'infra_excluded', score: 0 }),
    ]));

    expect(html).toContain('class="metric-card bucket-pass"');
    expect(html).toContain('class="metric-card bucket-partial"');
    expect(html).toContain('class="metric-card bucket-fail"');
    expect(html).toContain('class="metric-card bucket-infra"');
    expect(html).toContain('基础设施排除');
  });

  it('renders drill-down details for prompts, follow-ups, responses, tools, and failure diffs', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({
        testId: 'case-fail',
        description: 'needs details',
        status: 'failed',
        prompt: 'first prompt',
        followUpPrompts: ['second prompt'],
        responses: ['agent response'],
        toolExecutions: [{
          tool: 'shell',
          input: { cmd: 'npm test' },
          output: 'failed output',
          success: false,
          error: 'exit 1',
          duration: 42,
          timestamp: 7,
        }],
        errors: ['runtime error'],
        failureReason: 'wrong answer',
        failureDetails: {
          expected: 'expected answer',
          actual: 'actual answer',
          assertion: 'response_contains',
        },
        score: 0,
      }),
    ]));

    expect(html).toContain('<details id="case-case-fail"');
    expect(html).toContain('first prompt');
    expect(html).toContain('second prompt');
    expect(html).toContain('agent response');
    expect(html).toContain('shell');
    expect(html).toContain('class="failure-diff"');
    expect(html).toContain('expected answer');
    expect(html).toContain('actual answer');
  });

  it('renders trajectory efficiency triage as non-capability evidence without changing stats', () => {
    const html = generateHtmlReport(makeSummary([
      makeResult({
        testId: 'case-efficiency',
        status: 'passed',
        score: 1,
        trajectory: makeTrajectory(),
      }),
      makeResult({
        testId: 'case-fail',
        status: 'failed',
        score: 0,
      }),
      makeResult({
        testId: 'case-infra',
        status: 'infra_excluded',
        score: 0,
        failureReason: '429',
      }),
    ]));

    expect(html).toContain('data-testid="capability-denominator">2</span>');
    expect(html).toContain('data-testid="pass-rate">50.0%</span>');
    expect(html).toContain('data-testid="efficiency-triage"');
    expect(html).toContain('Efficiency triage');
    expect(html).toContain('非能力证据，不进统计');
    expect(html).toContain('case-efficiency');
    expect(html).toContain('0.0%');
    expect(html).toContain('2 redundant / 1 backtrack');
    expect(html).toContain('1');
  });

  it('renders the baseline section only when a baseline delta is provided', () => {
    const summary = makeSummary([makeResult({ testId: 'case-a' })]);

    expect(generateHtmlReport(summary)).not.toContain('Baseline Delta');

    const html = generateHtmlReport(summary, makeDelta());
    expect(html).toContain('Baseline Delta');
    expect(html).toContain('case-fail');
    expect(html).toContain('case-pass');
    expect(html).toContain('1 new failure');
  });
});

describe('saveReport html support', () => {
  it('writes timestamped html and latest-report.html with the optional baseline delta', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-html-report-'));
    const saved = await saveReport(
      makeSummary([makeResult({ testId: 'case-a' })]),
      outputDir,
      ['html'],
      makeDelta({ newFailures: [], regressionDetails: [] }),
    );

    const entries = await readdir(outputDir);
    expect(saved).toHaveLength(1);
    expect(path.basename(saved[0])).toMatch(/^report-\d+T?\d*\.html$/);
    expect(entries).toContain('latest-report.html');

    const latest = await readFile(path.join(outputDir, 'latest-report.html'), 'utf8');
    expect(latest).toContain('Baseline Delta');
  });
});

describe('html report content caps (Codex audit R1 MED)', () => {
  it('caps oversized responses/tool output/prompt blocks with a truncation notice', () => {
    const huge = 'x'.repeat(80_000);
    const summary = makeSummary([
      makeResult({
        testId: 'case-huge',
        prompt: huge,
        responses: [huge],
        errors: [huge],
        toolExecutions: [{
          tool: 'bash',
          input: { cmd: huge },
          output: huge,
          success: true,
          duration: 5,
          timestamp: 0,
        }],
        failureReason: 'boom',
        failureDetails: { assertion: 'a', expected: huge, actual: huge },
      }),
    ]);

    const html = generateHtmlReport(summary);
    expect(html).toContain('已截断');
    // 每个注入点都被截断：整页体积远小于未截断时的 ~480k
    expect(html.length).toBeLessThan(200_000);
    expect(html).not.toContain('x'.repeat(30_000));
  });

  it('keeps small content intact without truncation notice', () => {
    const summary = makeSummary([makeResult({ testId: 'case-small', responses: ['hello world'] })]);
    const html = generateHtmlReport(summary);
    expect(html).toContain('hello world');
    expect(html).not.toContain('已截断');
  });
});

describe('html score authority caveat (parity with markdown WP1-1)', () => {
  it('renders the non-capability-evidence caveat under the authority table', () => {
    const summary = makeSummary([makeResult({ testId: 'case-a', scoreAuthority: 'self_check' })]);
    const html = generateHtmlReport(summary);
    expect(html).toContain('不作能力证据');
  });
});

describe('html report caps outside case drilldown (Codex audit R2, symmetric application)', () => {
  it('caps baseline delta failure reasons and regression details', () => {
    const huge = 'y'.repeat(80_000);
    const summary = makeSummary([makeResult({ testId: 'case-a' })]);
    const html = generateHtmlReport(summary, makeDelta({
      newFailures: [{ testId: 'case-fail', previousStatus: 'passed', currentStatus: 'failed', reason: huge }],
      regressionDetails: [huge],
    }));
    expect(html).toContain('已截断');
    expect(html).not.toContain('y'.repeat(30_000));
  });

  it('caps infra section reasons', () => {
    const huge = 'z'.repeat(80_000);
    const summary = makeSummary([
      makeResult({ testId: 'case-infra', status: 'infra_excluded', failureReason: huge }),
    ]);
    const html = generateHtmlReport(summary);
    expect(html).toContain('已截断');
    expect(html).not.toContain('z'.repeat(30_000));
  });
});
