// ============================================================================
// DashboardVerifier dispatch smoke — Phase 4 Dashboard PR-B step 5.
//
// 4 case 覆盖 dispatch 路径：
//   1. 默认 subtype 'general' 跑通，passed=true、probes=[]
//   2. 显式传 'general' 同上
//   3. 未知 subtype 返回 passed=false 且 failures 含明确报错
//   4. listSubtypes() 暴露已注册 subtype 列表
//
// PR-B 不测 GeneralDashboardChecker 内部 evaluate（probes 占位空数组没东西可
// 测）。PR-C/D/E 加 probe 时再补 GeneralDashboardChecker.test.ts。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { DashboardVerifier } from '../../../../../src/main/agent/runtime/dashboard/DashboardVerifier';
import type { DashboardArtifactInput } from '../../../../../src/main/agent/runtime/dashboard/types';

const DUMMY_INPUT: DashboardArtifactInput = {
  filePath: '/tmp/dashboard-pr-b-placeholder.html',
};

describe('DashboardVerifier dispatch', () => {
  it('runs default subtype general and returns empty-probes passed result', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate(DUMMY_INPUT);
    expect(result.subtype).toBe('general');
    expect(result.passed).toBe(true);
    expect(result.probes).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('accepts explicit general subtype with same outcome', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate(DUMMY_INPUT, 'general');
    expect(result.subtype).toBe('general');
    expect(result.passed).toBe(true);
    expect(result.probes).toEqual([]);
  });

  it('returns failure result for unknown subtype without throwing', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate(DUMMY_INPUT, 'data-viz');
    expect(result.passed).toBe(false);
    expect(result.subtype).toBe('data-viz');
    expect(result.probes).toEqual([]);
    expect(result.failures).toEqual(['Unknown dashboard subtype: data-viz']);
  });

  it('listSubtypes exposes the registered subtype set', () => {
    const verifier = new DashboardVerifier();
    expect(verifier.listSubtypes()).toEqual(['general']);
  });
});
