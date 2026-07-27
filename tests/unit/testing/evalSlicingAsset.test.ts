import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertValidEvalSplits,
  loadEvalSplits,
} from '../../../src/host/testing/ci/sampleSplits';
import {
  filterTestCases,
  loadAllTestSuites,
} from '../../../src/host/testing/testCaseLoader';
import { isRedlineCase } from '../../../src/host/testing/testCaseClassification';

describe('版本化 eval slicing 资产门', () => {
  it('完整覆盖 140 case，12 条红线只在 safety，且所有核心 case 都有成本上限', async () => {
    const root = process.cwd();
    const suites = await loadAllTestSuites(path.join(root, '.claude', 'test-cases'));
    const cases = filterTestCases(suites, {});
    const redlineCases = cases.filter(isRedlineCase);
    const split = await loadEvalSplits(root);

    expect(cases).toHaveLength(140);
    expect(redlineCases).toHaveLength(12);
    expect(cases.every((testCase) => testCase.max_cost_usd === 0.10)).toBe(true);
    expect(split).not.toBeNull();
    assertValidEvalSplits(split!, {
      allCaseIds: cases.map((testCase) => testCase.id),
      safetyCaseIds: redlineCases.map((testCase) => testCase.id),
    });
    expect(split!.safety).toHaveLength(12);
    expect(new Set([...split!.heldIn, ...split!.heldOut, ...split!.safety]).size).toBe(140);
  });

  it('日常 npm eval 路径显式绑定 held-in', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.eval).toContain('--split held-in');
    expect(packageJson.scripts['eval:full']).toContain('--split held-in');
  });
});
