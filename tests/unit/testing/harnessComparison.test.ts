// ============================================================================
// Harness Comparison Tests (GAP-017)
// 测试固定模型、变 harness 配置的对照实验编排
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestRunSummary, HarnessVariantConfig } from '../../../src/main/testing/types';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// 捕获 TestRunner / StandaloneAgentAdapter 收到的配置
const captured = vi.hoisted(() => ({
  runnerConfigs: [] as Array<Record<string, unknown>>,
  adapterConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/main/testing/testRunner', () => ({
  createDefaultConfig: vi.fn((workingDirectory: string, overrides: Record<string, unknown>) => ({
    testCaseDir: '/tmp/test-cases',
    resultsDir: '/tmp/results',
    workingDirectory,
    defaultTimeout: 60000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    ...overrides,
  })),
  TestRunner: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    captured.runnerConfigs.push(config);
    return {
      runAll: vi.fn(async (): Promise<Partial<TestRunSummary>> => ({
        runId: config.runId as string,
        total: 2,
        passed: 1,
        failed: 1,
        partial: 0,
        averageScore: 0.5,
        duration: 1000,
      })),
    };
  }),
}));

vi.mock('../../../src/main/testing/agentAdapter', () => ({
  StandaloneAgentAdapter: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    captured.adapterConfigs.push(config);
    return {};
  }),
}));

import {
  runHarnessComparison,
  buildVariantRunIds,
} from '../../../src/main/testing/harnessComparison';

const VARIANTS: HarnessVariantConfig[] = [
  { name: 'baseline', contextCompression: true, hooksEnabled: false, toolMode: 'deferred' },
  { name: 'compression-off', contextCompression: false, hooksEnabled: false, toolMode: 'deferred' },
  { name: 'hooks-on', contextCompression: true, hooksEnabled: true, toolMode: 'deferred' },
];

describe('buildVariantRunIds', () => {
  it('should pre-generate a unique runId per variant', () => {
    const runIds = buildVariantRunIds(VARIANTS);
    expect(runIds.size).toBe(3);
    expect(runIds.get('baseline')).toMatch(/^harness-baseline-/);
    expect(new Set(runIds.values()).size).toBe(3);
  });
});

describe('runHarnessComparison', () => {
  beforeEach(() => {
    captured.runnerConfigs.length = 0;
    captured.adapterConfigs.length = 0;
  });

  it('should reject fewer than 2 variants', async () => {
    await expect(
      runHarnessComparison({
        model: 'glm-5',
        provider: 'zhipu',
        variants: [VARIANTS[0]],
        workingDirectory: '/tmp/project',
      }),
    ).rejects.toThrow('>= 2 variants');
  });

  it('should run each variant with fixed model and its own harness config', async () => {
    const result = await runHarnessComparison({
      model: 'glm-5',
      provider: 'zhipu',
      variants: VARIANTS,
      workingDirectory: '/tmp/project',
    });

    // 每个变体一个 runner + 一个 adapter
    expect(captured.runnerConfigs).toHaveLength(3);
    expect(captured.adapterConfigs).toHaveLength(3);

    // 模型固定，harness 变
    for (const adapterConfig of captured.adapterConfigs) {
      expect((adapterConfig.modelConfig as { model: string }).model).toBe('glm-5');
      expect((adapterConfig.modelConfig as { provider: string }).provider).toBe('zhipu');
    }
    expect(captured.adapterConfigs.map((config) => (config.harness as HarnessVariantConfig).name))
      .toEqual(['baseline', 'compression-off', 'hooks-on']);

    // runner config 带 harness（落 DB config_json 的来源）
    expect(captured.runnerConfigs.map((config) => (config.harness as HarnessVariantConfig).name))
      .toEqual(['baseline', 'compression-off', 'hooks-on']);

    // 结果聚合
    expect(result.variants).toHaveLength(3);
    expect(result.model).toBe('glm-5');
    expect(result.variants[0]).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      averageScore: 0.5,
    });
  });

  it('should use precomputed runIds so caller can poll DB before completion', async () => {
    const runIds = buildVariantRunIds(VARIANTS.slice(0, 2));
    const result = await runHarnessComparison(
      {
        model: 'glm-5',
        provider: 'zhipu',
        variants: VARIANTS.slice(0, 2),
        workingDirectory: '/tmp/project',
      },
      runIds,
    );

    expect(result.variants.map((entry) => entry.runId)).toEqual([
      runIds.get('baseline'),
      runIds.get('compression-off'),
    ]);
  });
});
