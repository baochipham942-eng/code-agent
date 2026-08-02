// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvasTab —— 把 konva 画布从全屏覆盖层挪进 workbench 预览 tab（R2）。
// 覆盖三件事：
//  1) WorkbenchTabId 接受 'design-canvas' 成员（经 appStore.openWorkbenchTab 验证）；
//  2) DesignCanvasTab 挂载时执行画布恢复 effect——runDir 非空且
//     nodes 为空 → 调 loadCanvasDoc(runDir)；runDir 为空 → 不调。
//  3) 边栏归一（2026-08-01 工单①）：图层/设计历史合并成一个面板（面板内双 tab），
//     右缘细边栏只剩一个图标；点图标浮出，再点图标 / 点画布空白收回。
// konva 在 jsdom 下不可渲染，故 mock 掉 ./DesignCanvas，测试只聚焦容器 + effect。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import React from 'react';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

// ---- mock konva 画布本体（jsdom 下 Stage 渲染会炸），用占位替换 -------------
// 占位捕获 props：sidePanelOpen / sidePanelTab（细边栏图标 ↔ 画布归一面板的接线）与
// onCanvasBlankPointerDown（点画布空白收回面板），点击占位即视为「点画布空白」。
const designCanvasProps = vi.hoisted(() => ({
  current: null as {
    sidePanelOpen?: boolean;
    sidePanelTab?: 'layers' | 'history';
    onSidePanelTabChange?: (tab: 'layers' | 'history') => void;
    onCanvasBlankPointerDown?: () => void;
  } | null,
}));
vi.mock('../../../src/renderer/components/design/DesignCanvas', () => ({
  DesignCanvas: (props: {
    sidePanelOpen?: boolean;
    sidePanelTab?: 'layers' | 'history';
    onSidePanelTabChange?: (tab: 'layers' | 'history') => void;
    onCanvasBlankPointerDown?: () => void;
  }) => {
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

describe('DesignCanvasTab 面板细边栏（工单①：图层/历史归一成单图标单面板双 tab）', () => {
  it('默认收起：无浮出面板，右缘细边栏只剩一个图标（收起态）', () => {
    storeState.nodes = [
      imageNode('初版', 0.14, 1),
      imageNode('高亮标题', 0.28, 2, '初版'),
    ];

    render(<DesignCanvasTab />);

    expect(screen.getByTestId('design-canvas-panel-rail')).toBeTruthy();
    const toggle = screen.getByTestId('design-canvas-sidepanel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 旧的两个独立图标已归一，不复存在
    expect(screen.queryByTestId('design-canvas-layers-toggle')).toBeNull();
    expect(screen.queryByTestId('design-canvas-history-toggle')).toBeNull();
    // 归一面板默认不浮出
    expect(designCanvasProps.current?.sidePanelOpen).toBe(false);
  });

  it('无节点时归一图标仍在（历史 tab 空画布也可达）', () => {
    storeState.nodes = [];
    render(<DesignCanvasTab />);
    expect(screen.getByTestId('design-canvas-sidepanel-toggle')).toBeTruthy();
  });

  it('点图标浮出面板（有节点默认图层 tab）；再点图标 / 点画布空白收回', () => {
    storeState.nodes = [imageNode('初版', 0.14, 1)];

    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开画布面板' }));
    expect(designCanvasProps.current?.sidePanelOpen).toBe(true);
    expect(designCanvasProps.current?.sidePanelTab).toBe('layers');

    fireEvent.click(screen.getByRole('button', { name: '收起画布面板' }));
    expect(designCanvasProps.current?.sidePanelOpen).toBe(false);

    // 再打开，点画布空白（stub 点击）→ 收回
    fireEvent.click(screen.getByRole('button', { name: '展开画布面板' }));
    expect(designCanvasProps.current?.sidePanelOpen).toBe(true);
    fireEvent.click(screen.getByTestId('design-canvas-stub'));
    expect(designCanvasProps.current?.sidePanelOpen).toBe(false);
  });

  it('空画布打开面板默认落「历史」tab（没有图层可言）', () => {
    storeState.nodes = [];
    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开画布面板' }));
    expect(designCanvasProps.current?.sidePanelOpen).toBe(true);
    expect(designCanvasProps.current?.sidePanelTab).toBe('history');
  });

  it('面板内 tab 切换经 onSidePanelTabChange 回流（记住用户最后看的 tab）', () => {
    storeState.nodes = [imageNode('初版', 0.14, 1)];
    render(<DesignCanvasTab />);
    fireEvent.click(screen.getByRole('button', { name: '展开画布面板' }));
    act(() => designCanvasProps.current?.onSidePanelTabChange?.('history'));
    expect(designCanvasProps.current?.sidePanelTab).toBe('history');
    // 收回再开，保持历史 tab（不强制跳回图层）
    fireEvent.click(screen.getByRole('button', { name: '收起画布面板' }));
    fireEvent.click(screen.getByRole('button', { name: '展开画布面板' }));
    expect(designCanvasProps.current?.sidePanelTab).toBe('history');
  });
});
