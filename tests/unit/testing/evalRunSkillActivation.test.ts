import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalRunEventStream, type EvalRunStartConfig } from '../../../scripts/lib/eval-run-event-stream';
import type { TestResult } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

const config: EvalRunStartConfig = {
  ...UNKNOWN_EVAL_RUN_STAMP,
  mode: 'mock',
  model: 'mock-model',
  provider: 'mock',
  scope: 'smoke',
  maxCases: 1,
  concurrency: 1,
  gitCommit: 'test-sha',
  testCaseDir: '/tmp/test-cases',
};

function result(): TestResult {
  return {
    testId: 'case-a',
    description: 'case A',
    status: 'passed',
    duration: 1,
    startTime: 1,
    endTime: 2,
    toolExecutions: [],
    responses: ['ok'],
    errors: [],
    turnCount: 1,
    score: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EvalRunEventStream skill activation accounting', () => {
  it('counts two skill_activated events by testId, attaches them to case_end, then clears the case map', () => {
    let ndjson = '';
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    const stream = new EvalRunEventStream('skill-run');

    stream.forward({ type: 'skill_activated', testId: 'case-a', name: 'x' }, config);
    stream.forward({ type: 'skill_activated', testId: 'case-a', name: 'x' }, config);
    const firstResult = result();
    stream.forward({ type: 'case_end', result: firstResult }, config);
    const secondResult = result();
    stream.forward({ type: 'case_end', result: secondResult }, config);
    stream.finish(0);

    const caseEnds = ndjson.trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'case_end');
    expect(firstResult.skillActivations).toEqual({ x: 2 });
    expect(secondResult.skillActivations).toEqual({});
    expect(caseEnds.map((event) => event.skillActivations)).toEqual([{ x: 2 }, {}]);
  });

  // 2026-08-30 监工代笔（Grok 变异席抓出的盲区）：原用例两次 skill_activated 与两次 case_end 都是同一题，
  // 把 Map 键改成单一当前槽仍绿。这里钉两题交错：A 的激活不能挂到 B 上，B 的 case_end 不能清掉 A 的槽。
  it('keeps skill activations isolated per testId when two cases interleave', () => {
    let ndjson = '';
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    const stream = new EvalRunEventStream('skill-run-interleaved');

    stream.forward({ type: 'skill_activated', testId: 'case-a', name: 'x' }, config);
    stream.forward({ type: 'skill_activated', testId: 'case-b', name: 'y' }, config);
    stream.forward({ type: 'skill_activated', testId: 'case-a', name: 'x' }, config);
    const resultB = { ...result(), testId: 'case-b', description: 'case B' };
    stream.forward({ type: 'case_end', result: resultB }, config);
    const resultA = result();
    stream.forward({ type: 'case_end', result: resultA }, config);
    stream.finish(0);

    const caseEnds = ndjson.trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'case_end');
    expect(resultB.skillActivations).toEqual({ y: 1 });
    expect(resultA.skillActivations).toEqual({ x: 2 });
    expect(caseEnds.map((event) => [event.testId, event.skillActivations])).toEqual([
      ['case-b', { y: 1 }],
      ['case-a', { x: 2 }],
    ]);
  });
});
