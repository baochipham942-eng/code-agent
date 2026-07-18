// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvasTab —— 把 konva 画布从全屏覆盖层挪进 workbench 预览 tab（R2）。
// 覆盖两件事：
//  1) WorkbenchTabId 接受 'design-canvas' 成员（经 appStore.openWorkbenchTab 验证）；
//  2) DesignCanvasTab 挂载时复刻 DesignWorkspace 的画布恢复 effect——runDir 非空且
//     nodes 为空 → 调 loadCanvasDoc(runDir)；runDir 为空 → 不调。
// konva 在 jsdom 下不可渲染，故 mock 掉 ./DesignCanvas，测试只聚焦容器 + effect。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

// ---- mock konva 画布本体（jsdom 下 Stage 渲染会炸），用占位替换 -------------
vi.mock('../../../src/renderer/components/design/DesignCanvas', () => ({
  DesignCanvas: () => React.createElement('div', { 'data-testid': 'design-canvas-stub' }),
}));

// ---- mock 持久化模块：拦 loadCanvasDoc 断言被调，并返回一个空 doc ----------
const loadCanvasDoc = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('../../../src/renderer/components/design/designCanvasPersistence', () => ({
  loadCanvasDoc: (...args: unknown[]) => loadCanvasDoc(...args),
}));

// ---- mock canvas store：受控 runDir / nodes / loadDoc -----------------------
const storeState = vi.hoisted(() => ({
  runDir: null as string | null,
  nodes: [] as unknown[],
  loadDoc: vi.fn(),
}));
vi.mock('../../../src/renderer/components/design/designCanvasStore', () => {
  const useDesignCanvasStore = Object.assign(
    () => storeState,
    { getState: () => storeState },
  );
  return { useDesignCanvasStore };
});

import { DesignCanvasTab } from '../../../src/renderer/components/design/DesignCanvasTab';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  loadCanvasDoc.mockClear();
  storeState.loadDoc.mockClear();
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
    storeState.nodes = [{ id: 'n1' }];
    render(<DesignCanvasTab />);
    expect(loadCanvasDoc).not.toHaveBeenCalled();
  });

  it('渲染 DesignCanvas（容器薄壳）', () => {
    const { getByTestId } = render(<DesignCanvasTab />);
    expect(getByTestId('design-canvas-stub')).toBeTruthy();
  });
});
