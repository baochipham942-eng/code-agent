// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvasSidePanel —— 边栏归一面板（2026-08-01 工单①）：图层/历史双 tab 同面板。
// 覆盖：tab 条渲染与切换回调、图层 tab 内容（复用 DesignLayerPanel）、
// 历史 tab 内容（复用 DesignCostHistory，时间线/累计花费/免费档文案）。
// DesignCostHistory 读真 store，直接 setState 供数据。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { DesignCanvasSidePanel } from '../../../src/renderer/components/design/DesignCanvasSidePanel';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const imageNode = (
  id: string,
  costCny: number,
  createdAt: number,
  parentId?: string,
): CanvasImageNode => ({
  id,
  kind: 'image',
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  createdAt,
  createdBy: 'user',
  parentId,
  label: id,
  costCny,
});

const renderPanel = (
  tab: 'layers' | 'history',
  nodes: CanvasImageNode[],
  onTabChange: (t: 'layers' | 'history') => void = () => {},
) =>
  render(
    <DesignCanvasSidePanel
      tab={tab}
      onTabChange={onTabChange}
      nodes={nodes}
      selectedIds={[]}
      onSelect={() => {}}
      onRename={() => {}}
      onSetChosen={() => {}}
      onDiscard={() => {}}
      onDelete={() => {}}
      onFocus={() => {}}
    />,
  );

beforeEach(() => {
  useDesignCanvasStore.setState({ nodes: [] });
});

afterEach(() => {
  cleanup();
  useDesignCanvasStore.setState({ nodes: [] });
});

describe('DesignCanvasSidePanel（工单①：图层/历史归一双 tab）', () => {
  it('tab 条渲染图层/历史两个 tab，当前 tab aria-selected=true', () => {
    renderPanel('layers', [imageNode('初版', 0.14, 1)]);
    const layers = screen.getByTestId('design-canvas-sidepanel-tab-layers');
    const history = screen.getByTestId('design-canvas-sidepanel-tab-history');
    expect(layers.getAttribute('aria-selected')).toBe('true');
    expect(history.getAttribute('aria-selected')).toBe('false');
  });

  it('点历史 tab → onTabChange("history")', () => {
    const onTabChange = vi.fn();
    renderPanel('layers', [imageNode('初版', 0.14, 1)], onTabChange);
    fireEvent.click(screen.getByTestId('design-canvas-sidepanel-tab-history'));
    expect(onTabChange).toHaveBeenCalledWith('history');
  });

  it('图层 tab：渲染图层列表（复用 DesignLayerPanel）', () => {
    renderPanel('layers', [imageNode('初版', 0.14, 1), imageNode('高亮标题', 0.28, 2, '初版')]);
    expect(screen.getByText('初版')).toBeTruthy();
    expect(screen.getByText('高亮标题')).toBeTruthy();
  });

  it('图层 tab 空节点：给空态引导而非空白', () => {
    renderPanel('layers', []);
    expect(screen.getByText('还没有图层——生成或导入一张图后会出现在这里')).toBeTruthy();
  });

  it('历史 tab：渲染版本时间线与准确累计花费', () => {
    const nodes = [imageNode('初版', 0.14, 1), imageNode('高亮标题', 0.28, 2, '初版')];
    useDesignCanvasStore.setState({ nodes });
    renderPanel('history', nodes);

    expect(screen.getByTestId('design-cost-history-content').dataset.collapsed).toBe('false');
    expect(screen.getByText('初版')).toBeTruthy();
    expect(screen.getByText('高亮标题')).toBeTruthy();
    expect(screen.getByText('¥0.42')).toBeTruthy();
  });

  it('历史 tab：免费档节点显示「免费」而非 ¥0.00', () => {
    const nodes = [imageNode('免费版本', 0, 1)];
    useDesignCanvasStore.setState({ nodes });
    renderPanel('history', nodes);

    expect(screen.getAllByText('免费').length).toBeGreaterThan(0);
    expect(screen.queryByText('¥0.00')).toBeNull();
  });
});
