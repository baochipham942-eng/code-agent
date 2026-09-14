import { describe, expect, it } from 'vitest';
import { resolveHumanGoldLabels } from '../../../src/host/testing/calibration/humanGold';
import type { AnnotationRow } from '../../../src/host/services/core/repositories/AnnotationRepository';

function row(overrides: Partial<AnnotationRow>): AnnotationRow {
  return {
    id: 'a', experiment_id: 'run-1', case_id: 'case-1', reviewer_id: 'r1', overall: null, note: null,
    dims_json: JSON.stringify({ task_completed: 'yes' }), consent_scope: 'metadata', calibration_split: 'gold',
    supersedes_id: null, created_at: 1, ...overrides,
  };
}

describe('resolveHumanGoldLabels · 人标金标', () => {
  it('每个 reviewer 只取最新一条：改判后以新的为准', () => {
    const { labels } = resolveHumanGoldLabels([
      row({ id: 'old', created_at: 1, dims_json: JSON.stringify({ task_completed: 'yes' }) }),
      row({ id: 'new', created_at: 2, dims_json: JSON.stringify({ task_completed: 'no' }) }),
    ], 'task_completed');
    expect(labels.get('case-1')).toBe('fail');
  });

  it('多人分歧的题整题跳过并点名，不做多数表决', () => {
    const resolution = resolveHumanGoldLabels([
      row({ id: 'a', reviewer_id: 'r1', dims_json: JSON.stringify({ task_completed: 'yes' }) }),
      row({ id: 'b', reviewer_id: 'r2', dims_json: JSON.stringify({ task_completed: 'no' }) }),
      row({ id: 'c', reviewer_id: 'r3', dims_json: JSON.stringify({ task_completed: 'no' }) }),
    ], 'task_completed');
    expect(resolution.labels.has('case-1')).toBe(false);
    expect(resolution.contested).toEqual(['case-1']);
  });

  it('勾了金标但没标本维 → unlabeled；标了别的维不算', () => {
    const resolution = resolveHumanGoldLabels([
      row({ dims_json: JSON.stringify({ tool_choice: 'no' }) }),
    ], 'task_completed');
    expect(resolution.labels.size).toBe(0);
    expect(resolution.unlabeled).toEqual(['case-1']);
  });

  it('两人一致 → 一条金标；坏 JSON 当没标', () => {
    const resolution = resolveHumanGoldLabels([
      row({ id: 'a', reviewer_id: 'r1' }),
      row({ id: 'b', reviewer_id: 'r2' }),
      row({ id: 'c', case_id: 'case-2', dims_json: '{not json' }),
    ], 'task_completed');
    expect(resolution.labels.get('case-1')).toBe('pass');
    expect(resolution.unlabeled).toEqual(['case-2']);
  });
});
