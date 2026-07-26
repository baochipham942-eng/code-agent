import { describe, expect, it } from 'vitest';

import {
  groupExperimentsByDataset,
  normalizeDatasetName,
} from '../../../src/renderer/components/features/evalCenter/evalDatasetName';
import type { EvalExperimentListItem } from '../../../src/shared/contract/evaluation';

const run = (id: string, name: string, timestamp: number, source = 'eval-harness'): EvalExperimentListItem => ({
  id,
  name,
  timestamp,
  model: null,
  provider: null,
  scope: 'full',
  source,
  gitCommit: null,
  summary: null,
});

describe('normalizeDatasetName', () => {
  it('剥掉 ISO 日期后缀（eval-harness / test-runner / regression 落盘格式）', () => {
    expect(normalizeDatasetName('eval-harness-2026-07-21')).toBe('eval-harness');
    expect(normalizeDatasetName('eval-2026-07-21')).toBe('eval');
    expect(normalizeDatasetName('regression-2026-07-21')).toBe('regression');
  });

  it('剥掉 harness 变体名的日期后缀，保留变体名', () => {
    expect(normalizeDatasetName('harness-claude-only-2026-07-21')).toBe('harness-claude-only');
  });

  it('剥掉带数据集名的新落盘格式，保留数据集名', () => {
    expect(normalizeDatasetName('eval-harness-smoke-suite-2026-07-21')).toBe('eval-harness-smoke-suite');
    expect(normalizeDatasetName('eval-smoke-suite-2026-07-21')).toBe('eval-smoke-suite');
    // 数据集名本身形如日期时被加 ds- 前缀，不会被误剥
    expect(normalizeDatasetName('eval-harness-ds-2026-07-21-2026-07-22')).toBe('eval-harness-ds-2026-07-21');
  });

  it('剥掉带时间的日期后缀', () => {
    expect(normalizeDatasetName('gsm8k-2026-07-21T153000')).toBe('gsm8k');
    expect(normalizeDatasetName('gsm8k-2026-07-21_15-30-00')).toBe('gsm8k');
  });

  it('剥掉日期前缀（swe-bench runDir 名）', () => {
    expect(normalizeDatasetName('2026-04-28-django__django-16642-judge-v1')).toBe('django__django-16642-judge-v1');
  });

  it('剥掉紧凑日期/时间戳与 epoch 毫秒后缀', () => {
    expect(normalizeDatasetName('gsm8k-20260721')).toBe('gsm8k');
    expect(normalizeDatasetName('gsm8k-20260721-153000')).toBe('gsm8k');
    expect(normalizeDatasetName('exp-1719931200000')).toBe('exp');
  });

  it('不带日期的 name 原样返回', () => {
    expect(normalizeDatasetName('gsm8k')).toBe('gsm8k');
    expect(normalizeDatasetName('django__django-16642-judge-v1')).toBe('django__django-16642-judge-v1');
  });

  it('name 本身就是日期时返回原始 name（分组 key 稳定）', () => {
    expect(normalizeDatasetName('2026-07-21')).toBe('2026-07-21');
  });
});

describe('groupExperimentsByDataset', () => {
  it('同一数据集不同日期的运行归到一组，组内按时间倒序', () => {
    const groups = groupExperimentsByDataset([
      run('old', 'gsm8k-2026-07-19', 1000),
      run('new', 'gsm8k-2026-07-21', 3000),
      run('mid', 'gsm8k-2026-07-20', 2000),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].dataset).toBe('gsm8k');
    expect(groups[0].runs.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('跨数据集不合并，组间按最新运行时间倒序', () => {
    const groups = groupExperimentsByDataset([
      run('gsm8k', 'gsm8k-2026-07-19', 1000),
      run('math', 'math-2026-07-20', 2000),
    ]);
    expect(groups.map((g) => g.dataset)).toEqual(['math', 'gsm8k']);
  });

  it('同名数据集跨 source 不合并', () => {
    const groups = groupExperimentsByDataset([
      run('a', 'gsm8k-2026-07-21', 2000, 'eval-harness'),
      run('b', 'gsm8k-2026-07-21', 1000, 'test-runner'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(['eval-harness::gsm8k', 'test-runner::gsm8k']);
  });
});
