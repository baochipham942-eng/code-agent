// ============================================================================
// Harness Comparison — 固定模型、变 harness 配置的对照实验（GAP-017）
// 课程 H2："同一模型在不同 Harness 中的差距 > 不同模型在同一 Harness 中的差距"。
// 每个 harness 变体跑一遍同一组 test case，各自作为独立 experiment 落 DB
// （config_json.harness 记录维度），供跨实验对比。
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { HarnessVariantConfig, TestRunSummary } from './types';
import { TestRunner, createDefaultConfig } from './testRunner';
import { StandaloneAgentAdapter } from './agentAdapter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('HarnessComparison');

export interface HarnessComparisonRequest {
  /** 固定的模型（对照实验只变 harness，不变模型） */
  model: string;
  provider: string;
  apiKey?: string;
  /** 要对比的 harness 变体（≥2 个才构成对照） */
  variants: HarnessVariantConfig[];
  workingDirectory: string;
  /** 测试用例目录（默认 createDefaultConfig 解析） */
  testCaseDir?: string;
  resultsDir?: string;
  filterTags?: string[];
  filterIds?: string[];
  maxIterations?: number;
  defaultTimeout?: number;
}

export interface HarnessVariantRunResult {
  variant: HarnessVariantConfig;
  runId: string;
  total: number;
  passed: number;
  failed: number;
  partial: number;
  averageScore: number;
  durationMs: number;
}

export interface HarnessComparisonResult {
  comparisonId: string;
  model: string;
  provider: string;
  variants: HarnessVariantRunResult[];
}

/** 预生成每个变体的 runId（调用方可先拿到 id 再异步等结果，避免双写） */
export function buildVariantRunIds(variants: HarnessVariantConfig[]): Map<string, string> {
  return new Map(variants.map((variant) => [variant.name, `harness-${variant.name}-${uuidv4()}`]));
}

/**
 * 串行跑每个 harness 变体（固定模型）。每个变体一条 experiment 记录
 * （TestRunner.runAll 内部走 ExperimentAdapter.persistTestRun 落 DB）。
 */
export async function runHarnessComparison(
  request: HarnessComparisonRequest,
  precomputedRunIds?: Map<string, string>,
): Promise<HarnessComparisonResult> {
  if (request.variants.length < 2) {
    throw new Error(`Harness comparison needs >= 2 variants, got ${request.variants.length}`);
  }

  const runIds = precomputedRunIds ?? buildVariantRunIds(request.variants);
  const comparisonId = uuidv4();
  const results: HarnessVariantRunResult[] = [];

  logger.info('Harness comparison started', {
    comparisonId,
    model: request.model,
    provider: request.provider,
    variants: request.variants.map((variant) => variant.name),
  });

  for (const variant of request.variants) {
    const runId = runIds.get(variant.name) ?? `harness-${variant.name}-${uuidv4()}`;

    const runnerConfig = createDefaultConfig(request.workingDirectory, {
      runId,
      ...(request.testCaseDir ? { testCaseDir: request.testCaseDir } : {}),
      ...(request.resultsDir ? { resultsDir: request.resultsDir } : {}),
      ...(request.defaultTimeout ? { defaultTimeout: request.defaultTimeout } : {}),
      filterTags: request.filterTags,
      filterIds: request.filterIds,
      harness: variant,
    });

    const agent = new StandaloneAgentAdapter({
      workingDirectory: request.workingDirectory,
      modelConfig: {
        provider: request.provider,
        model: request.model,
        apiKey: request.apiKey,
      },
      maxIterations: request.maxIterations,
      harness: variant,
    });

    const runner = new TestRunner(runnerConfig, agent);
    logger.info('Harness variant run started', { variant: variant.name, runId });
    const summary: TestRunSummary = await runner.runAll();

    results.push({
      variant,
      runId: summary.runId,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      partial: summary.partial,
      averageScore: summary.averageScore,
      durationMs: summary.duration,
    });
    logger.info('Harness variant run finished', {
      variant: variant.name,
      runId: summary.runId,
      passed: summary.passed,
      total: summary.total,
      averageScore: summary.averageScore,
    });
  }

  logger.info('Harness comparison finished', {
    comparisonId,
    results: results.map((entry) => ({
      variant: entry.variant.name,
      passed: entry.passed,
      total: entry.total,
      averageScore: entry.averageScore,
    })),
  });

  return {
    comparisonId,
    model: request.model,
    provider: request.provider,
    variants: results,
  };
}
