import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAllTestSuites, loadTestSuite } from '../../../src/host/testing/testCaseLoader';

function suite(id: string, extra: string[] = []): string {
  return [
    `name: ${id}-suite`,
    'cases:',
    `  - id: ${id}`,
    '    type: task',
    `    prompt: ${id} prompt`,
    ...extra,
    '',
  ].join('\n');
}

describe('test case loader criteria gate', () => {
  it('T2：单题缺判定标准或仍待确认时按原因拒收', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-loader-gate-'));
    const missing = path.join(dir, 'missing.yaml');
    const pending = path.join(dir, 'pending.yaml');
    await fs.writeFile(missing, suite('missing-case'));
    await fs.writeFile(pending, suite('pending-case', [
      '    reviewStatus: pending',
      '    expect:',
      '      response_contains: [ok]',
    ]));

    await expect(loadTestSuite(missing)).rejects.toThrow(/missing-case.*no_expectations/);
    await expect(loadTestSuite(pending)).rejects.toThrow(/pending-case.*review_pending/);
  });

  it('T2：目录加载跳过坏题文件并在 stderr 留下文件名与原因', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-loader-directory-gate-'));
    const good = path.join(dir, 'good.yaml');
    const bad = path.join(dir, 'bad.yaml');
    await fs.writeFile(good, suite('good-case', [
      '    expect:',
      '      response_contains: [ok]',
    ]));
    await fs.writeFile(bad, suite('bad-case'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const loaded = await loadAllTestSuites(dir);

    expect(loaded.flatMap((item) => item.cases).map((item) => item.id)).toEqual(['good-case']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain(`Failed to load test suite ${bad}`);
    expect(error.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      message: expect.stringMatching(/bad-case.*no_expectations/),
    }));
    error.mockRestore();
  });

  it('T3：真实默认集与三个专项集共 153 题，门开启后零拒收', async () => {
    const root = path.join(process.cwd(), '.claude', 'test-cases');
    const roots = [root, 'artifact-runnable', 'goal-contract', 'user-simulator']
      .map((item) => path.isAbsolute(item) ? item : path.join(root, item));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const suites = (await Promise.all(roots.map((item) => loadAllTestSuites(item)))).flat();

    expect(suites.flatMap((item) => item.cases)).toHaveLength(153);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
