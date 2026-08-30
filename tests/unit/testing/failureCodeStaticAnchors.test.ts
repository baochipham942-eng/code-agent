import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('失败原因分类静态接线锚点', () => {
  it('TestRunner 只在统一 case_end 前分类一次', () => {
    const testRunner = source('src/host/testing/testRunner.ts');
    expect(testRunner.match(/classifyTestResultFailure\(/g)).toHaveLength(1);
    const classifyAt = testRunner.indexOf('result.failure = classifyTestResultFailure(');
    const caseEndAt = testRunner.indexOf("this.emit({ type: 'case_end', result });", classifyAt);
    expect(classifyAt).toBeGreaterThan(0);
    expect(caseEndAt).toBeGreaterThan(classifyAt);
  });

  it('NDJSON、事件落库和 TestRun 落库都携带同一 failure 字段', () => {
    expect(source('packages/internal/evaluation-center/scripts/lib/eval-run-event-stream.ts'))
      .toContain('failure: event.result.failure');
    const adapter = source('packages/internal/evaluation-center/src/host/evaluation/experimentAdapter.ts');
    expect(adapter).toContain('failure: event.failure');
    expect(adapter).toContain('failure: r.failure');
    expect(adapter).toContain('failure: c.failure');
  });

  it('summary 与 run_end 原始行都携带 failureDistribution', () => {
    expect(source('src/host/testing/testRunner.ts')).toContain('failureDistribution: results.reduce');
    expect(source('packages/internal/evaluation-center/scripts/lib/eval-run-event-stream.ts'))
      .toContain('failureDistribution: summary.failureDistribution');
  });

  it('码本回退来源进入 summary、run_end 与报告头', () => {
    expect(source('src/host/testing/testRunner.ts'))
      .toContain('failureCodebookSource: this.failureCodebookSource');
    expect(source('packages/internal/evaluation-center/scripts/lib/eval-run-event-stream.ts'))
      .toContain('failureCodebookSource: summary.failureCodebookSource');
    expect(source('src/host/testing/reportGenerator.ts')).toContain('失败原因码本：');
  });
});
