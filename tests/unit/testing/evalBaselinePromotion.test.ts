import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaselineManager,
  BaselinePromotionError,
} from '../../../src/host/testing/ci/baselineManager';
import type { TestRunSummary } from '../../../src/host/testing/types';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'eval-promote-'));
  roots.push(value);
  return value;
}

function summary(ids: string[], resultIds = ids, invalidId?: string): TestRunSummary {
  return {
    runId: `run-${ids.join('-')}`,
    startTime: 1,
    endTime: 2,
    duration: 1,
    total: ids.length,
    plannedCaseIds: ids,
    completed: true,
    passed: resultIds.length,
    failed: 0,
    skipped: 0,
    partial: 0,
    notRun: 0,
    invalidCases: invalidId ? 1 : 0,
    averageScore: 1,
    results: resultIds.map((testId) => ({
      testId,
      status: 'passed',
      score: 1,
      startTime: 1,
      endTime: 2,
      duration: 1,
      ...(testId === invalidId ? { invalid: { reason: 'usage_unavailable' } } : {}),
    })),
    environment: { model: 'model', provider: 'provider', workingDirectory: '/tmp' },
    stamp: {
      caseBankSha: 'bank-sha',
      shape: { skills: [], plugins: [], memory: false, swarm: false, harness: null },
      divergesFromProduction: [],
    },
    aggregationRule: 'pass_rate_k1',
    aggregationRuleVersion: 4,
    performance: { avgResponseTime: 0, maxResponseTime: 0, totalToolCalls: 0, totalTurns: 0 },
  } as unknown as TestRunSummary;
}

afterEach(async () => {
  const fs = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('分组对比基准写层硬门', () => {
  it('T1：分组路径写入 .claude，旧调用仍写 .code-agent，非法 split 拒绝', async () => {
    const workingDir = await root();
    const grouped = new BaselineManager(workingDir, { group: { split: 'held-in', k: 3 } });
    await grouped.promote(summary(['a']), 'sha', 'real', ['a']);
    expect(JSON.parse(await readFile(
      path.join(workingDir, '.claude', 'eval-baseline.held-in.k3.json'),
      'utf8',
    ))).toMatchObject({ caseBankSha: 'bank-sha', excludedCaseIds: [], knownIssues: [] });

    const legacy = new BaselineManager(workingDir);
    await legacy.promote(summary(['b']), 'sha', 'real', ['b']);
    expect(await readFile(path.join(workingDir, '.code-agent', 'eval-baseline.json'), 'utf8'))
      .toContain('"plannedCaseIds"');
    expect(() => new BaselineManager(workingDir, {
      group: { split: 'bad-split' as never, k: 1 },
    })).toThrow(/Unsupported evaluation baseline split/);
  });

  it('T2：计划五题但结果只有四题，写层返回 baseline_incomplete', async () => {
    const manager = new BaselineManager(await root(), { group: { split: 'all', k: 1 } });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    await expect(manager.promote(summary(ids, ids.slice(0, 4)), 'sha', 'real', ids))
      .rejects.toMatchObject({ code: 'baseline_incomplete' } satisfies Partial<BaselinePromotionError>);
  });

  it('T3：任一题 invalid 时写层返回 baseline_invalid_run', async () => {
    const manager = new BaselineManager(await root(), { group: { split: 'safety', k: 1 } });
    await expect(manager.promote(summary(['a', 'b'], ['a', 'b'], 'b'), 'sha', 'real', ['a', 'b']))
      .rejects.toMatchObject({ code: 'baseline_invalid_run' } satisfies Partial<BaselinePromotionError>);
  });

  it('连续设置保留最近十条操作记录，最新记录在前', async () => {
    const manager = new BaselineManager(await root(), { group: { split: 'held-out', k: 2 } });
    await manager.promote(summary(['a']), 'sha-1', 'real', ['a'], {
      experimentId: 'experiment-1', updatedBy: 'user-1',
    });
    await manager.promote(summary(['a']), 'sha-2', 'real', ['a'], {
      experimentId: 'experiment-2', updatedBy: 'user-2',
    });
    expect((await manager.load())?.history).toMatchObject([
      { experimentId: 'experiment-2', updatedBy: 'user-2' },
      { experimentId: 'experiment-1', updatedBy: 'user-1' },
    ]);
  });
});
