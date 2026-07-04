// ============================================================================
// WP1b 样本工程 — held-in/held-out 切分
// ============================================================================
// 每次迭代都对着同一个 45 子集调 prompt，分数会"学会考卷"。切分后：
// held-in 供日常迭代，held-out 只在里程碑检查（过拟合探测器），
// GAIA 为天然 held-out 外部锚点（--case-dir 独立入口，不进本地 split）。
// 切分必须确定性（seed 固定即结果固定），否则两次生成两套卷子。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  splitHeldInOut,
  applySplitFilter,
  saveEvalSplits,
  loadEvalSplits,
  type EvalSplitFile,
} from '../../../src/host/testing/ci/sampleSplits';

const IDS = Array.from({ length: 45 }, (_, i) => `case-${String(i).padStart(2, '0')}`);

describe('splitHeldInOut', () => {
  it('确定性：同 seed 两次切分结果完全一致', () => {
    const a = splitHeldInOut(IDS, { seed: 'wp1b-2026-07' });
    const b = splitHeldInOut(IDS, { seed: 'wp1b-2026-07' });
    expect(a).toEqual(b);
  });

  it('换 seed 得到不同切分（不是按输入顺序硬切）', () => {
    const a = splitHeldInOut(IDS, { seed: 'seed-a' });
    const b = splitHeldInOut(IDS, { seed: 'seed-b' });
    expect(a.heldOut).not.toEqual(b.heldOut);
  });

  it('两半互斥且并集为全集', () => {
    const { heldIn, heldOut } = splitHeldInOut(IDS, { seed: 's' });
    expect(heldIn.length + heldOut.length).toBe(IDS.length);
    const union = new Set([...heldIn, ...heldOut]);
    expect(union.size).toBe(IDS.length);
  });

  it('heldOutRatio 控制份额（默认 0.4，45 → 18）', () => {
    expect(splitHeldInOut(IDS, { seed: 's' }).heldOut).toHaveLength(18);
    expect(splitHeldInOut(IDS, { seed: 's', heldOutRatio: 0.2 }).heldOut).toHaveLength(9);
  });

  it('输入顺序无关：乱序输入切出同一套 held-out', () => {
    const shuffled = [...IDS].reverse();
    const a = splitHeldInOut(IDS, { seed: 's' });
    const b = splitHeldInOut(shuffled, { seed: 's' });
    expect(new Set(a.heldOut)).toEqual(new Set(b.heldOut));
  });
});

function splitFile(): EvalSplitFile {
  return {
    version: 1,
    seed: 'wp1b',
    createdAt: '2026-07-03T00:00:00.000Z',
    heldIn: ['a', 'b', 'c'],
    heldOut: ['d', 'e'],
    control: ['a', 'b'],
    note: 'GAIA 为天然 held-out',
  };
}

describe('applySplitFilter', () => {
  it('无显式 ids → 返回该桶全量', () => {
    expect(applySplitFilter(undefined, splitFile(), 'held-in')).toEqual(['a', 'b', 'c']);
    expect(applySplitFilter(undefined, splitFile(), 'held-out')).toEqual(['d', 'e']);
    expect(applySplitFilter(undefined, splitFile(), 'control')).toEqual(['a', 'b']);
  });

  it('显式 ids 与桶取交集（挡住把 held-out 混进日常迭代）', () => {
    expect(applySplitFilter(['a', 'd'], splitFile(), 'held-in')).toEqual(['a']);
  });
});

describe('splits 文件落盘', () => {
  it('save → load 往返一致；缺文件 → null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'splits-'));
    expect(await loadEvalSplits(dir)).toBeNull();
    await saveEvalSplits(dir, splitFile());
    expect(await loadEvalSplits(dir)).toEqual(splitFile());
  });
});
