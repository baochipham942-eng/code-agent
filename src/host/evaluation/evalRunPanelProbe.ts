import fs from 'node:fs';
import path from 'node:path';
import type { EvalRunPanelProbe } from '../../shared/contract/evaluation';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { inspectEvalEnvironment } from './evalEnvironment';
import { estimateEvalCostPerCase, PRICING_TABLE_VERSION } from './evalRunCostEstimate';

const FALLBACK_SPLIT_COUNTS: EvalRunPanelProbe['splitCounts'] = {
  'held-in': 76,
  'held-out': 52,
  safety: 12,
};

function readSplitCounts(repositoryRoot?: string): EvalRunPanelProbe['splitCounts'] {
  if (!repositoryRoot) return FALLBACK_SPLIT_COUNTS;
  try {
    const parsed = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, '.claude', 'eval-splits.json'),
      'utf8',
    )) as Record<string, unknown>;
    const count = (key: 'heldIn' | 'heldOut' | 'safety', fallback: number): number => (
      Array.isArray(parsed[key]) ? parsed[key].length : fallback
    );
    return {
      'held-in': count('heldIn', FALLBACK_SPLIT_COUNTS['held-in']),
      'held-out': count('heldOut', FALLBACK_SPLIT_COUNTS['held-out']),
      safety: count('safety', FALLBACK_SPLIT_COUNTS.safety),
    };
  } catch {
    return FALLBACK_SPLIT_COUNTS;
  }
}

export function inspectEvalRunPanel(): EvalRunPanelProbe {
  const environment = inspectEvalEnvironment();
  const model = resolveSessionDefaultModelConfig();
  return {
    environment: {
      available: environment.available,
      message: environment.message,
      packaged: environment.packaged,
      platform: environment.platform,
      osJail: environment.osJail,
    },
    model: model.model,
    provider: model.provider,
    priceTableVersion: PRICING_TABLE_VERSION,
    estimatedCostPerCaseUsd: estimateEvalCostPerCase(model.model),
    splitCounts: readSplitCounts(environment.repositoryRoot),
    // 「快速检查」是 core-path 标签下最多取 12 题，不创建第四个评测集桶。
    quickCheck: { tags: ['core-path'], maxCases: 12 },
  };
}
