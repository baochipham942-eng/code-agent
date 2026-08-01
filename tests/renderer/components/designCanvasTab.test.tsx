// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvasTab —— 把 konva 画布从全屏覆盖层挪进 workbench 预览 tab（R2）。
// 覆盖三件事：
//  1) WorkbenchTabId 接受 'design-canvas' 成员（经 appStore.openWorkbenchTab 验证）；
//  2) DesignCanvasTab 挂载时执行画布恢复 effect——runDir 非空且
//     nodes 为空 → 调 loadCanvasDoc(runDir)；runDir 为空 → 不调。
//  3) 图层面板 + 设计历史默认收起成右缘图标细边栏（2026-08-01 工单②）：
//     常态只剩图 + 顶部条；点图标浮出（互斥），再点图标 / 点画布空白收回。
// konva 在 jsdom 下不可渲染，故 mock 掉 ./DesignCanvas，测试只聚焦容器 + effect。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

// ---- mock konva 画布本体（jsdom 下 Stage 渲染会炸），用占位替换 -------------
// 占位捕获 props：layerPanelOpen（细边栏图层图标 ↔ 画布面板开关的接线）与
// onCanvasBlankPointerDown（点画布空白收回面板），点击占位即视为「点画布空白」。
const designCanvasProps = vi.hoisted(() => ({
  current: null as { layerPanelOpen?: boolean; onCanvasBlankPointerDown?: () => void } | null,
}));
vi.mock('../../../src/renderer/components/design/DesignCanvas', () => ({
  DesignCanvas: (props: { layerPanelOpen?: boolean; onCanvasBlankPointerDown?: () => void }) => {
    designCanvasProps.current = props;
    return React.createElement('div', {
      'data-testid': 'design-canvas-stub',
      onClick: () => props.onCanvasBlankPointerDown?.(),
    });
  },
}));

// ---- mock 持久化模块：拦 loadCanvasDoc 断言被调，并返回一个空 doc ----------
const loadCanvasDoc = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('../../../src/renderer/components/design/designCanvasPersistence', () => ({
  loadCanvasDoc: (...args: unknown[]) => loadCanvasDoc(...args),
}));

// ---- mock canvas store：受控 runDir / nodes / loadDoc -----------------------
const storeState = vi.hoisted(() => ({
  runDir: null as string | null,
  nodes: [] as CanvasImageNode[],
  loadDoc: vi.fn(),
  setChosen: vi.fn(),
  renameNode: vi.fn(),
}));
vi.mock('../../../src/renderer/components/design/designCanvasStore', () => {
  const useDesignCanvasStore = Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState },
  );
  return { useDesignCanvasStore };
});

import { DesignCanvasTab } from '../../../src/renderer/components/design/DesignCanvasTab';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  loadCanvasDoc.mockClear();
  storeState.loadDoc.mockClear();
  storeState.setChosen.mockClear();
  storeState.renameNode.mockClear();
  storeState.runDir = null;
  storeState.nodes = [];
});

afterEach(() => {
  cleanup();
});

describe('WorkbenchTabId design-canvas 成员', () => {
  it('openWorkbenchTab("design-canvas") 后 activeWorkbenchTab 切到 design-canvas', () => {
    useAppStore.getState().openWorkbenchTab('design-canvas');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('design-canvas');
  });
});

describe('DesignCanvasTab 画布恢复 effect', () => {
  it('runDir 非空且 nodes 为空 → 挂载时调 loadCanvasDoc(runDir)', () => {
    storeState.runDir = '/tmp/run-1';
    storeState.nodes = [];
    render(<DesignCanvasTab />);
    expect(loadCanvasDoc).toHaveBeenCalledWith('/tmp/run-1');
  });

  it('runDir 为空 → 不调 loadCanvasDoc', () => {
    storeState.runDir = null;
    render(<DesignCanvasTab />);
    expect(loadCanvasDoc).not.toHaveBeenCalled();
  });

  it('nodes 非空（已有内容）→ 不重复加载', () => {
    storeState.runDir = '/tmp/run-1';
    storeState.nodes = [{
      id: 'n1',
      kind: 'image',
      src: 'assets/n1.png',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      createdAt: 1,
    }];
    render(<DesignCanvasTab />);
    expect(loadCanvasDoc).not.toHaveBeenCalled();
  });

  it('渲染 DesignCanvas（容器薄壳）', () => {
    const { getByTestId } = render(<DesignCanvasTab />);
    expect(getByTestId('design-canvas-stub')).toBeTruthy();
  });
});

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
  parentId,
  label: id,
  costCny,
});

describe('DesignCanvasTab 面板细边栏（工单②：图层/设计历史默认收起）', () => {
  it('默认全部收起：无历史面板、无时间线、无累计花费，只剩右缘图标细边栏', () => {
    storeState.nodes = [
      imageNode('初版', 0.14, 1),
      imageNode('高亮标题', 0.28, 2, '初版'),
    ];

    render(<DesignCanvasTab />);

    expect(screen.queryByTestId('design-cost-history-dock')).toBeNull();
    expect(screen.queryByText('初版')).toBeNull();
    expect(screen.queryByText('¥0.42')).toBeNull();
    // 细边栏两个图标都在（有节点 → 图层图标也在），且都是收起态
    expect(screen.getByTestId('design-canvas-panel-rail')).toBeTruthy();
    expect(screen.getByTestId('design-canvas-layers-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('design-canvas-history-toggle').getAttribute('aria-expanded')).toBe('false');
    // 图层面板默认不浮出
    expect(designCanvasProps.current?.layerPanelOpen).toBe(false);
  });

  it('无节点时图层图标不出现（面板本身也是空态不渲染），历史图标仍在', () => {
    storeState.nodes = [];
    render(<DesignCanvasTab />);
    expect(screen.queryByTestId('design-canvas-layers-toggle')).toBeNull();
    expect(screen.getByTestId('design-canvas-history-toggle')).toBeTruthy();
  });

  it('点历史图标浮出面板：渲染版本时间线与准确累计花费；再点图标收回', () => {
    storeState.nodes = [
      imageNode('初版', 0.14, 1),
      imageNode('高亮标题', 0.28, 2, '初版'),
    ];

    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开设计历史' }));

    expect(screen.getByTestId('design-cost-history-content').dataset.collapsed).toBe('false');
    expect(screen.getByText('初版')).toBeTruthy();
    expect(screen.getByText('高亮标题')).toBeTruthy();
    expect(screen.getByText('¥0.42')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起设计历史' }));
    expect(screen.queryByTestId('design-cost-history-dock')).toBeNull();
  });

  it('点图层图标 → DesignCanvas 收到 layerPanelOpen=true；点画布空白收回两块面板', () => {
    storeState.nodes = [imageNode('初版', 0.14, 1)];

    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开图层面板' }));
    expect(designCanvasProps.current?.layerPanelOpen).toBe(true);

    // 两面板互斥：图层浮出时点历史图标，图层收、历史开
    fireEvent.click(screen.getByRole('button', { name: '展开设计历史' }));
    expect(designCanvasProps.current?.layerPanelOpen).toBe(false);
    expect(screen.getByTestId('design-cost-history-dock')).toBeTruthy();

    // 点画布空白（stub 点击）→ 浮出面板收回
    fireEvent.click(screen.getByTestId('design-canvas-stub'));
    expect(screen.queryByTestId('design-cost-history-dock')).toBeNull();
  });

  it('免费档节点在浮出的历史面板显示「免费」而非 ¥0.00', () => {
    storeState.nodes = [imageNode('免费版本', 0, 1)];

    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开设计历史' }));

    expect(screen.getAllByText('免费').length).toBeGreaterThan(0);
    expect(screen.queryByText('¥0.00')).toBeNull();
  });
});
