import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EvalRunEventStream, type EvalRunStartConfig } from '@internal-evaluation-scripts/lib/eval-run-event-stream';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import type { TestResult } from '../../../src/host/testing/types';

describe('EvalRunEventStream AI 评审透传', () => {
  it('T4：TestResult.aiReview 原样进入 case_end.aiReview', () => {
    let ndjson = '';
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    const stream = new EvalRunEventStream('ai-review-run');
    const config: EvalRunStartConfig = {
      ...UNKNOWN_EVAL_RUN_STAMP,
      mode: 'real',
      model: 'tested-model',
      provider: 'provider',
      scope: 'smoke',
      maxCases: 1,
      concurrency: 1,
      gitCommit: 'test-sha',
      testCaseDir: '/cases',
    };
    const result: TestResult = {
      testId: 'case-1',
      description: '任务',
      prompt: '输入',
      status: 'passed',
      score: 1,
      duration: 1,
      startTime: 0,
      endTime: 1,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 1,
      invalid: { reason: 'usage_unavailable' },
      aiReview: {
        task_completed: {
          verdict: 'no',
          reasoning: '缺少产物',
          judgeModel: 'provider/judge',
          promptHash: 'sha256',
        },
      },
      expectationResults: [{
        expectation: { type: 'no_crash', description: '没有崩溃', params: {} },
        passed: true,
        evidence: { expected: true, actual: true },
        duration: 1,
      }],
    };

    try {
      stream.forward({ type: 'case_end', result }, config);
      stream.finish(0);
    } finally {
      writeSpy.mockRestore();
    }

    const events = ndjson.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === 'case_end')).toMatchObject({
      testId: 'case-1',
      invalid: { reason: 'usage_unavailable' },
      aiReview: {
        task_completed: {
          verdict: 'no',
          reasoning: '缺少产物',
        },
      },
      evidence: { prompt: '输入', checks: [{ type: 'no_crash', passed: true }] },
    });
  });
});
