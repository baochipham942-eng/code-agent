import fs from 'node:fs';
import path from 'node:path';
import { BaselineManager } from '@host/testing/ci/baselineManager';
import type { SplitBucket } from '@host/testing/ci/sampleSplits';

interface EvalBaselineManagerOptions {
  kind: 'agent' | 'mock-harness';
  grouped: boolean;
  split?: SplitBucket;
  repeat: number;
  caseDir?: string;
}

export function createEvalBaselineManager(
  workingDir: string,
  options: EvalBaselineManagerOptions,
): BaselineManager {
  if (!options.grouped || options.kind === 'mock-harness') {
    return new BaselineManager(workingDir, { kind: options.kind });
  }
  const split = options.caseDir ? 'all' : options.split ?? 'held-in';
  if (split === 'control') {
    throw new Error('control 评审校准集不能设为对比基准');
  }
  return new BaselineManager(workingDir, {
    kind: 'agent',
    group: { split, k: options.repeat },
  });
}

export function hasLegacyEvalBaseline(workingDir: string): boolean {
  return fs.existsSync(path.join(workingDir, '.code-agent', 'eval-baseline.json'));
}
