// DesignCostHistoryView 渲染回归：成本透明 + undo/redo 信任 UI 的关键元素必须出现。
// 用 renderToStaticMarkup（node 环境，无 jsdom）渲染真展示组件，i18n 取 appStore 默认语言(zh)。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignCostHistoryView } from '../../../src/renderer/components/design/DesignCostHistory';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const N = (o: Partial<CanvasImageNode> & { id: string }): CanvasImageNode => ({
  src: `assets/${o.id}.png`, x: 0, y: 0, width: 100, height: 100, createdAt: o.createdAt ?? 1, ...o,
});

// generate(A) → edit(B) → edit(C)，主版定在中间版 B（chosen）→ 可 undo 到 A、redo 到 C。
const nodes: CanvasImageNode[] = [
  N({ id: 'node-A', createdAt: 100, prompt: '深色 SaaS 定价页', label: '定价页骨架', costCny: 0.14 }),
  N({ id: 'node-B', createdAt: 200, parentId: 'node-A', label: '三档套餐 v1', chosen: true, costCny: 0.14 }),
  N({ id: 'node-C', createdAt: 300, parentId: 'node-A', prompt: '顶部加月/年切换', costCny: 0.14 }),
];

const render = (ns: CanvasImageNode[]): string =>
  renderToStaticMarkup(
    React.createElement(DesignCostHistoryView, { nodes: ns, onSetChosen: () => {}, onRename: () => {} }),
  );

describe('DesignCostHistoryView', () => {
  it('展示每步命名、op、单次成本与累计花费（含已淘汰的真实花费）', () => {
    const html = render(nodes);
    expect(html).toContain('定价页骨架');
    expect(html).toContain('三档套餐 v1');
    expect(html).toContain('顶部加月/年切换'); // 无 label 回退到 prompt
    expect(html).toContain('累计花费');
    expect(html).toContain('¥0.42'); // 3 × 0.14
    expect(html).toContain('¥0.14');
  });

  it('回滚态：主版=中间版 B → 标「当前」，并给出 undo/redo 入口', () => {
    const html = render(nodes);
    expect(html).toContain('当前');
    expect(html).toContain('回滚到前一版');
    expect(html).toContain('前进到后一版');
  });

  it('免费模型(costCny=0)单步显示「免费」而非 ¥0.00（审计 LOW）', () => {
    // 混合：一个付费(0.14)+一个免费(0)，确保「免费」是单步展示而非累计 header 的 ¥0.00。
    const mixed: CanvasImageNode[] = [
      N({ id: 'p1', createdAt: 1, label: '付费出图', costCny: 0.14 }),
      N({ id: 'f1', createdAt: 2, label: '免费出图', costCny: 0 }),
    ];
    const html = render(mixed);
    expect(html).toContain('免费'); // 免费步
    expect(html).toContain('¥0.14'); // 付费步仍显示金额
    expect(html).toContain('¥0.14'); // 累计=0.14（免费步不加钱）
  });

  it('空画布显示空态提示，不渲染步骤', () => {
    const html = render([]);
    expect(html).toContain('每一步会作为可命名、可回滚的版本');
    expect(html).not.toContain('当前');
  });

  it('已淘汰版本不进时间线，但其花费仍计入累计（钱已真实花掉）', () => {
    const withDiscarded: CanvasImageNode[] = [
      N({ id: 'd1', createdAt: 100, label: '废弃方案', discarded: true, costCny: 0.14 }),
      N({ id: 'd2', createdAt: 200, label: '保留方案', costCny: 0.14 }),
    ];
    const html = render(withDiscarded);
    expect(html).not.toContain('废弃方案'); // 淘汰版不在时间线
    expect(html).toContain('保留方案');
    expect(html).toContain('¥0.28'); // 2 × 0.14，淘汰版花费仍计入
  });
});
