// 演示稿配图：目标页选择 + 成本预估 + 提示词（纯逻辑；真出图付费不进单测）。
import { describe, expect, it } from 'vitest';
import {
  selectIllustrationTargets,
  buildIllustrationPrompt,
  estimateIllustrateCost,
} from '../../../../src/main/services/design/slidesIllustrator';
import type { SlideData } from '../../../../src/main/tools/media/ppt/types';

const deck = (): SlideData[] => [
  { title: '封面', points: [], isTitle: true },
  { title: '背景', points: ['a', 'b'] },
  { title: '方案', points: ['c'] },
  { title: '架构', points: ['d'] },
  { title: '', points: ['空标题不配图'] },
  { title: '谢谢', points: [], isEnd: true },
];

describe('selectIllustrationTargets', () => {
  it('只选内容页（跳过封面/结尾/空标题）', () => {
    expect(selectIllustrationTargets(deck(), 10)).toEqual([1, 2, 3]);
  });

  it('受 maxImages 上限约束', () => {
    expect(selectIllustrationTargets(deck(), 2)).toEqual([1, 2]);
  });

  it('无内容页时返回空', () => {
    expect(selectIllustrationTargets([{ title: 'x', points: [], isTitle: true }], 5)).toEqual([]);
  });
});

describe('buildIllustrationPrompt', () => {
  it('含标题、要点，且强制无文字', () => {
    const p = buildIllustrationPrompt({ title: '智能排班', points: ['降本', '增效'] });
    expect(p).toContain('智能排班');
    expect(p).toContain('降本');
    expect(p).toContain('不要出现任何文字');
  });
});

describe('estimateIllustrateCost', () => {
  it('count = 目标页数；成本随页数增长', () => {
    const full = estimateIllustrateCost(deck(), 'wanx-t2i', 10);
    const capped = estimateIllustrateCost(deck(), 'wanx-t2i', 1);
    expect(full.count).toBe(3);
    expect(capped.count).toBe(1);
    expect(full.costCny).toBeGreaterThanOrEqual(capped.costCny);
  });
});
