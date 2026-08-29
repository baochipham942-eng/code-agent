import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertFailureDispositionConsistency,
  classifyFailure,
  loadFailureCodebook,
  loadProjectFailureCodebookWithSource,
  type FailureCodebook,
} from '../../../src/host/testing/failureCodes';

const codebookDir = path.resolve('.claude');

describe('失败原因两轴分类', () => {
  const codebook = loadFailureCodebook(codebookDir);

  it.each([
    ['crash', { failureReason: 'fatal error: worker crashed' }],
    ['timeout', { failureStage: 'timeout', failureReason: 'Test timeout after 1000ms' }],
    ['max_steps', { failureReason: 'maximum steps exceeded' }],
    ['loop_suspect', { failureReason: 'reasoning loop detected' }],
    ['tool_error_storm', { failureReason: 'tool calls failed with 9 errors' }],
    ['missing_artifact', { failureReason: 'missing artifact: summary.html' }],
    ['wrong_output', { failureReason: 'expected hello but actual goodbye' }],
  ])('把构造用例裁定为 %s', (expected, input) => {
    expect(classifyFailure(input, codebook).primaryFailureCode).toBe(expected);
  });

  it('同时命中时取高优先级唯一表现码，并保留全部症状', () => {
    const result = classifyFailure({
      failureStage: 'timeout',
      failureReason: 'Test timeout after 1000ms; reasoning loop detected',
      status: 'failed',
    }, codebook);
    expect(result.primaryFailureCode).toBe('timeout');
    expect(result.matched).toEqual(expect.arrayContaining(['timeout', 'loop_suspect']));

    const mutated: FailureCodebook = {
      version: 1,
      codes: codebook.codes.map((definition) => ({
        ...definition,
        priority: definition.code === 'loop_suspect'
          ? 601
          : definition.code === 'timeout'
            ? 399
            : definition.priority,
      })),
    };
    expect(classifyFailure({
      failureStage: 'timeout',
      failureReason: 'Test timeout after 1000ms; reasoning loop detected',
    }, mutated).primaryFailureCode).toBe('loop_suspect');
  });

  it('全不命中时明确进入 unknown 兜底桶', () => {
    expect(classifyFailure({ failureReason: 'something novel happened', status: 'failed' }, codebook))
      .toMatchObject({ primaryFailureCode: 'unknown', matched: [] });
  });

  it('只靠 stderr 尾部也能命中崩溃码', () => {
    expect(classifyFailure({
      failureReason: 'worker stopped unexpectedly',
      failureStage: 'evaluation',
      status: 'failed',
      stderr: ['diagnostic without known symptoms', 'fatal signal: SIGSEGV'],
    }, codebook)).toMatchObject({
      primaryFailureCode: 'crash',
      matched: ['crash'],
    });
  });

  it('stderr 只读取最后 20 行', () => {
    const neutralTail = Array.from({ length: 24 }, (_, index) => `diagnostic line ${index + 1}`);
    expect(classifyFailure({
      status: 'failed',
      stderr: [...neutralTail, 'fatal signal: SIGSEGV'],
    }, codebook).primaryFailureCode).toBe('crash');
    expect(classifyFailure({
      status: 'failed',
      stderr: ['fatal signal: SIGSEGV', ...neutralTail],
    }, codebook)).toMatchObject({ primaryFailureCode: 'unknown', matched: [] });
  });

  it('临时码本新增代码后无需改分类器即可命中，并展开已知问题链接', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'eval-failcodes-'));
    await writeFile(path.join(dir, 'eval-failcodes.yaml'), `
version: 1
codes:
  - code: custom_failure
    label: 自定义失败
    priority: 10
    match:
      failureReason: ['custom sentinel']
    dispositions: [needs_human]
    issue: https://example.com/issues/42
`);
    const loaded = loadFailureCodebook(dir);
    expect(classifyFailure({ failureReason: 'custom sentinel' }, loaded)).toEqual({
      primaryFailureCode: 'custom_failure',
      dispositions: ['known_issue:https://example.com/issues/42', 'needs_human'],
      matched: ['custom_failure'],
    });
  });

  it('坏正则、重复代码和重复优先级都用人话拒绝加载', async () => {
    const cases = [
      {
        yaml: `version: 1\ncodes:\n  - { code: bad, label: 坏正则, priority: 1, match: { failureReason: ['['] }, dispositions: [] }\n`,
        message: /正则.*无法编译/,
      },
      {
        yaml: `version: 1\ncodes:\n  - { code: same, label: 一, priority: 2, match: { status: [failed] }, dispositions: [] }\n  - { code: same, label: 二, priority: 1, match: { status: [partial] }, dispositions: [] }\n`,
        message: /code.*重复/,
      },
      {
        yaml: `version: 1\ncodes:\n  - { code: one, label: 一, priority: 1, match: { status: [failed] }, dispositions: [] }\n  - { code: two, label: 二, priority: 1, match: { status: [partial] }, dispositions: [] }\n`,
        message: /priority 1 重复/,
      },
    ];
    for (const fixture of cases) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'eval-failcodes-invalid-'));
      await writeFile(path.join(dir, 'eval-failcodes.yaml'), fixture.yaml);
      expect(() => loadFailureCodebook(dir)).toThrow(fixture.message);
    }
  });

  it('项目码本缺失时明确警告并标记为内置来源', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'eval-failcodes-missing-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loaded = loadProjectFailureCodebookWithSource(projectDir);
      expect(loaded.source).toBe('bundled');
      expect(loaded.codebook.codes).toHaveLength(7);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/未找到项目失败原因码本.*使用内置码本/));
    } finally {
      warn.mockRestore();
    }
  });

  it('网络超时进入 timeout 且可重试、不计入通过率；harness 总时限仍是能力失败', () => {
    const infra = classifyFailure({
      failureReason: 'request timeout after 3000ms',
      failureStage: 'infra',
      status: 'infra_excluded',
    }, codebook);
    expect(infra.primaryFailureCode).toBe('timeout');
    expect(infra.dispositions).toEqual(expect.arrayContaining(['retryable', 'not_in_denominator']));
    expect(() => assertFailureDispositionConsistency('infra_excluded', infra.dispositions)).not.toThrow();

    const harness = classifyFailure({
      failureReason: 'Test timeout after 3000ms',
      failureStage: 'timeout',
      status: 'failed',
    }, codebook);
    expect(harness.primaryFailureCode).toBe('timeout');
    expect(harness.dispositions).not.toContain('not_in_denominator');
    expect(() => assertFailureDispositionConsistency('failed', harness.dispositions)).not.toThrow();
  });

  it('not_in_denominator 与统计状态必须双向一致', () => {
    expect(() => assertFailureDispositionConsistency('infra_excluded', []))
      .toThrow(/失败处置与统计状态不一致/);
    expect(() => assertFailureDispositionConsistency('failed', ['not_in_denominator']))
      .toThrow(/失败处置与统计状态不一致/);
  });
});
