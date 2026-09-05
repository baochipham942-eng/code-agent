import { describe, expect, it } from 'vitest';
import { buildCaseEvidence } from '@internal-evaluation-scripts/lib/eval-case-evidence';
import type { TestResult } from '../../src/host/testing/types';

function result(): TestResult {
  return {
    testId: 'case-evidence', description: 'evidence budget', prompt: 'do the work',
    status: 'failed', score: 0, duration: 42, startTime: 0, endTime: 42,
    toolExecutions: Array.from({ length: 200 }, (_, index) => ({
      tool: `tool-${index}`, input: { path: `/tmp/${index}`, content: 'x'.repeat(300) },
      output: 'output must not be persisted', success: index % 2 === 0,
      ...(index % 2 === 0 ? {} : { error: `error-${index}` }), duration: index, timestamp: index,
    })),
    responses: ['r'.repeat(10_000)], errors: [], turnCount: 1,
    expectationResults: Array.from({ length: 30 }, (_, index) => ({
      expectation: { type: 'content_contains', description: `check-${index}`, params: {} },
      passed: index % 2 === 0,
      evidence: { expected: { value: `expected-${index}` }, actual: { value: `actual-${index}` } },
      duration: index,
    })),
  };
}

describe('buildCaseEvidence', () => {
  it('T1：工具和回复按预算截断，判定依据全量保留', () => {
    const evidence = buildCaseEvidence(result());
    expect(evidence.toolCalls).toHaveLength(60);
    expect(evidence.toolCallsTruncated).toBe(140);
    expect(evidence.responseExcerpt).toHaveLength(2_000);
    expect(evidence.checks).toHaveLength(30);
    expect(Buffer.byteLength(JSON.stringify(evidence), 'utf8')).toBeLessThanOrEqual(64 * 1_024);
    expect(JSON.stringify(evidence)).not.toContain('output must not be persisted');
  });

  it('保留最后一段回复并记录代表试次的逐次状态', () => {
    const input = result();
    input.responses = [`HEAD-${'x'.repeat(2_100)}-TAIL`];
    input.trials = [
      { status: 'failed', score: 0, duration_ms: 10, failureReason: 'missing' },
      { status: 'passed', score: 1, duration_ms: 20 },
    ];
    const evidence = buildCaseEvidence(input);
    expect(evidence.responseExcerpt.endsWith('-TAIL')).toBe(true);
    expect(evidence.responseExcerpt).not.toContain('HEAD-');
    expect(evidence.trialDetails).toEqual([
      { index: 1, status: 'failed', score: 0, failureReason: 'missing', durationMs: 10 },
      { index: 2, status: 'passed', score: 1, durationMs: 20 },
    ]);
  });

  it('64KB 超限时先移除工具，再从回复开头缩短，判定始终全量保留', () => {
    const input = result();
    input.expectationResults = Array.from({ length: 75 }, (_, index) => ({
      expectation: { type: 'content_contains', description: `check-${index}`, params: {} },
      passed: false,
      evidence: { expected: 'e'.repeat(300), actual: 'a'.repeat(300), details: 'd'.repeat(100) },
      duration: 1,
    }));
    input.toolExecutions = [{
      tool: 'large-error', input: {}, output: '', success: false, error: 'x'.repeat(10_000), duration: 1, timestamp: 1,
    }];
    const afterTools = buildCaseEvidence(input);
    expect(afterTools.checks).toHaveLength(75);
    expect(afterTools.toolCalls).toHaveLength(0);
    expect(afterTools.toolCallsTruncated).toBe(1);
    expect(afterTools.responseExcerpt).toHaveLength(2_000);

    input.expectationResults.push(...Array.from({ length: 5 }, (_, index) => ({
      expectation: { type: 'content_contains' as const, description: `extra-${index}`, params: {} },
      passed: false,
      evidence: { expected: 'e'.repeat(300), actual: 'a'.repeat(300), details: 'd'.repeat(100) },
      duration: 1,
    })));
    input.toolExecutions = [];
    const afterExcerpt = buildCaseEvidence(input);
    expect(afterExcerpt.checks).toHaveLength(80);
    expect(afterExcerpt.responseExcerpt.length).toBeLessThan(2_000);
    expect(Buffer.byteLength(JSON.stringify(afterExcerpt), 'utf8')).toBeLessThanOrEqual(64 * 1_024);
  });

  it('判定依据自身超过 64KB 时也不砍、不抛（监工代笔 · Grok 盲区①）', () => {
    const input = result();
    input.toolExecutions = [];
    input.responses = ['short'];
    input.expectationResults = Array.from({ length: 200 }, (_, index) => ({
      expectation: { type: 'content_contains', description: `check-${index}`, params: {} },
      passed: index % 3 === 0,
      evidence: { expected: 'e'.repeat(2_000), actual: 'a'.repeat(2_000), details: 'd'.repeat(2_000) },
      duration: 1,
    }));

    const evidence = buildCaseEvidence(input);

    expect(evidence.checks).toHaveLength(200);
    expect(evidence.checks.every((check) => check.expected.length <= 500 && check.actual.length <= 500)).toBe(true);
    // 软预算允许被判定依据单独撑破：这是工单明定的「永不砍 checks」优先级
    expect(Buffer.byteLength(JSON.stringify(evidence), 'utf8')).toBeGreaterThan(64 * 1_024);
    expect(evidence.toolCalls).toEqual([]);
  });

  it('N-EVAL-EVIDENCE-JSON-ESCAPE：字符串型期望/实际原样落盘，非字符串仍是 JSON', () => {
    const input = result();
    input.toolExecutions = [];
    input.responses = ['short'];
    input.expectationResults = [
      {
        expectation: { type: 'approval_requested', description: 'approval', params: {} },
        passed: false,
        evidence: { expected: 'at least one matching approval request', actual: 'no matching approval request' },
        duration: 1,
      },
      {
        expectation: { type: 'content_contains', description: 'array', params: {} },
        passed: true,
        evidence: { expected: ['v3'], actual: { value: 3 } },
        duration: 1,
      },
      {
        expectation: { type: 'content_contains', description: 'long', params: {} },
        passed: false,
        evidence: { expected: 'x'.repeat(600), actual: 42 },
        duration: 1,
      },
    ];

    const evidence = buildCaseEvidence(input);

    // 抽屉「判定表」直接渲染这两列，不能再包一层引号和转义
    expect(evidence.checks[0].expected).toBe('at least one matching approval request');
    expect(evidence.checks[0].actual).toBe('no matching approval request');
    expect(evidence.checks[1].expected).toBe('["v3"]');
    expect(evidence.checks[1].actual).toBe('{"value":3}');
    // 字符串免了 JSON，但没免截断
    expect(evidence.checks[2].expected).toBe('x'.repeat(500));
    expect(evidence.checks[2].actual).toBe('42');
    // 工具入参是对象，保持 JSON
    expect(buildCaseEvidence(result()).toolCalls[0].inputSummary.startsWith('{"path":')).toBe(true);
  });
});
