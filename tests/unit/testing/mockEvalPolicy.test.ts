import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../../../src/host/testing/agentAdapter';
import {
  assertMockPolicyCoverage,
  getMockCasePolicy,
} from '../../../src/host/testing/mockEvalPolicy';
import { TestRunner, createDefaultConfig } from '../../../src/host/testing/testRunner';
import type { TestCase } from '../../../src/host/testing/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('mock eval policy', () => {
  it('遇到未分类或过期 case 时 fail-loud', () => {
    expect(() => assertMockPolicyCoverage(['new-unclassified-case'])).toThrow(/missing=.*new-unclassified-case.*stale=/);
  });

  it('五个诊断样本的 A/B 裁决固定下来', () => {
    expect(getMockCasePolicy('write-file-new')?.kind).toBe('fixture');
    expect(getMockCasePolicy('git-status')?.kind).toBe('fixture');
    expect(getMockCasePolicy('prompt-smoke-write-file')?.kind).toBe('fixture');
    expect(getMockCasePolicy('prompt-smoke-toolsearch-json-arguments')?.kind).toBe('fixture');
    expect(getMockCasePolicy('prompt-smoke-read-package')).toMatchObject({
      kind: 'real-only',
      reason: expect.stringMatching(/真实|real|0\.16/i),
    });
  });

  it('fixture adapter 真的产生文件副作用与工具调用记录', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mock-eval-policy-'));
    roots.push(root);
    const adapter = new MockAgentAdapter();
    adapter.enableMockEvalPolicy();

    adapter.configureMockCase('write-file-new', root);
    const writeResult = await adapter.sendMessage('irrelevant prompt wording');
    expect(await readFile(path.join(root, 'test-write-temp.txt'), 'utf8')).toContain('Test content 123');
    expect(writeResult.toolExecutions.some((execution) => /write/i.test(execution.tool))).toBe(true);

    adapter.configureMockCase('git-status', root);
    const gitResult = await adapter.sendMessage('irrelevant prompt wording');
    expect(gitResult.toolExecutions).toEqual([
      expect.objectContaining({ tool: 'bash', success: true, output: expect.stringContaining('branch') }),
    ]);
  });

  it('real-only case 在 mock run 中显式列为 mockExcluded，不执行 setup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mock-eval-excluded-'));
    roots.push(root);
    const adapter = new MockAgentAdapter();
    adapter.enableMockEvalPolicy();
    const runner = new TestRunner(
      createDefaultConfig(root, { workingDirectory: root, enableEvalCritic: false }),
      adapter,
    );
    const testCase: TestCase = {
      id: 'prompt-smoke-read-package',
      type: 'tool',
      description: 'real only',
      prompt: 'read package',
      expect: {},
      setup: ['touch should-not-run'],
    };

    const result = await runner.runSingleTest(testCase);

    expect(result.status).toBe('skipped');
    expect(result.mockExcluded).toEqual({ reason: expect.any(String) });
    await expect(readFile(path.join(root, 'should-not-run'))).rejects.toThrow();
  });

  it('未知 case 在 mock run fail-loud，禁止自动跳过', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mock-eval-unknown-'));
    roots.push(root);
    const adapter = new MockAgentAdapter();
    adapter.enableMockEvalPolicy();
    const runner = new TestRunner(
      createDefaultConfig(root, { workingDirectory: root, enableEvalCritic: false }),
      adapter,
    );
    const testCase: TestCase = {
      id: 'new-unclassified-case',
      type: 'task',
      description: 'unknown',
      prompt: 'unknown',
      expect: {},
    };

    const result = await runner.runSingleTest(testCase);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/mock policy|未分类/i);
  });
});
