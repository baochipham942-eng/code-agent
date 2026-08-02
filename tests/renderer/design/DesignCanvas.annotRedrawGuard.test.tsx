// @vitest-environment jsdom
// 标注重绘「先校验、后付费确认」守卫（2026-08-02 收口工单任务三）。
// 旧顺序：先弹「要花 ¥x 吗」的 window.confirm，点确定后才在 editByAnnotation 深处被告知
// 「请先圈出区域」。新顺序：onAnnotRedraw 在弹 confirm 之前先用
// hasMaskArea(annotShapesToMaskGeometry(annotShapes)) 拦下纯文字标注。
//
// 探针纪律（本测试必须能自证不失明）：
// - 自定义 react-konva Stage mock 显式转发 ref（getPointerPosition 回传最后一次指针事件的
//   clientX/Y），并把 DOM 鼠标事件包成 KonvaEventObject 形状递给 DesignCanvas 的真实处理器——
//   标注形状是从真实事件链路产出的，不是直接塞 state。
// - 正对照：圈了 rect 区域时 confirm 必须真被调用、editByAnnotation 必须真走到——
//   若 Stage mock 失明（形状根本没进去），正对照会先红，不会误判。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const generation = vi.hoisted(() => ({ editByAnnotation: vi.fn() }));
const toolbarProps = vi.hoisted(() => ({ current: null as Record<string, any> | null }));

// 自定义 react-konva mock（vitest.config 的 alias stub 不转发 ref、不接事件，驱动不了标注链路）。
vi.mock('react-konva', async () => {
  const ReactActual = await import('react');
  const Stage = ReactActual.forwardRef<
    { getPointerPosition: () => { x: number; y: number } },
    Record<string, any>
  >((props, ref) => {
    const lastPointer = ReactActual.useRef({ x: 0, y: 0 });
    ReactActual.useImperativeHandle(ref, () => ({
      getPointerPosition: () => lastPointer.current,
    }));
    const wrapHandler =
      (fn?: (e: { evt: Record<string, unknown>; target: unknown }) => void) =>
      (e: React.MouseEvent): void => {
        lastPointer.current = { x: e.clientX, y: e.clientY };
        fn?.({ evt: e.nativeEvent as unknown as Record<string, unknown>, target: null });
      };
    return ReactActual.createElement(
      'div',
      {
        'data-testid': 'konva-stage',
        onMouseDown: wrapHandler(props.onMouseDown),
        onMouseMove: wrapHandler(props.onMouseMove),
        onMouseUp: wrapHandler(props.onMouseUp),
      },
      props.children,
    );
  });
  Stage.displayName = 'Stage';
  return {
    Stage,
    Layer: (props: Record<string, any>) =>
      ReactActual.createElement(ReactActual.Fragment, null, props.children),
    Rect: () => null,
  };
});

vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  readWorkspaceImageAsDataUrl: vi.fn(),
  exportImagePdf: vi.fn(),
  exportCanvasPptx: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/useRestoreCanvasFromDisk', () => ({
  useRestoreCanvasFromDisk: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/useDesignCanvasGeneration', () => ({
  useDesignCanvasGeneration: () => ({
    editRegion: vi.fn(),
    expand: vi.fn(),
    removeWatermark: vi.fn(),
    editByAnnotation: generation.editByAnnotation,
    generateVideo: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/components/design/useDesignCanvasImport', () => ({
  useDesignCanvasImport: () => ({ importFiles: vi.fn() }),
}));

vi.mock('../../../src/renderer/components/design/useCanvasProposalReview', () => ({
  useCanvasProposalReview: () => ({ pending: null, apply: vi.fn(), reject: vi.fn() }),
}));

vi.mock('../../../src/renderer/components/design/useAutonomyEnvelopeReview', () => ({
  useAutonomyEnvelopeReview: () => ({
    pendingRequest: null,
    grant: vi.fn(),
    decline: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/components/design/useCanvasVideoRequest', () => ({
  useCanvasVideoRequest: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasNodes', () => ({
  CanvasImage: () => null,
  KonvaVideoNode: () => null,
}));

vi.mock('../../../src/renderer/components/design/DesignImageToolbar', () => ({
  DesignImageToolbar: (props: Record<string, any>) => {
    toolbarProps.current = props;
    return null;
  },
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasSidePanel', () => ({
  DesignCanvasSidePanel: () => null,
}));

// 只替换视觉层；reduceAnnot 保留真实现——标注形状走真实 reducer 产出。
vi.mock('../../../src/renderer/components/design/AnnotationLayer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, AnnotationLayer: () => null };
});

vi.mock('../../../src/renderer/components/design/DiagramLayer', () => ({
  DiagramLayer: () => null,
}));

vi.mock('../../../src/renderer/components/design/CanvasProposalGhostLayer', () => ({
  CanvasProposalGhostLayer: () => null,
}));

vi.mock('../../../src/renderer/components/design/CanvasProposalReviewBar', () => ({
  CanvasProposalReviewBar: () => null,
}));

vi.mock('../../../src/renderer/components/design/CanvasAutonomyReviewBar', () => ({
  CanvasAutonomyReviewBar: () => null,
}));

vi.mock('../../../src/renderer/components/design/DiscardedNodesTray', () => ({
  DiscardedNodesTray: () => null,
}));

vi.mock('../../../src/renderer/components/design/DiagramToolbar', () => ({
  DiagramToolbar: () => null,
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasOverlays', () => ({
  VideoPlayOverlay: () => null,
  DiffEvidenceOverlay: () => null,
}));

import { DesignCanvasTab } from '../../../src/renderer/components/design/DesignCanvasTab';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import { useDesignStore } from '../../../src/renderer/components/design/designStore';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const originalSetError = useDesignCanvasStore.getState().setError;

const imageNode = (src: string): CanvasImageNode => ({
  id: 'image-1',
  kind: 'image',
  src,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  createdAt: 1,
  createdBy: 'user',
});

function setCanvas(): void {
  const node = imageNode('data:image/png;base64,AAAA');
  useDesignCanvasStore.setState({
    runDir: '/tmp/design-run',
    nodes: [node],
    connectors: [],
    shapes: [],
    camera: { x: 0, y: 0, scale: 1 },
    selectedIds: [node.id],
    selectedDiagram: null,
    generating: false,
    error: null,
    setError: originalSetError,
  });
}

// Stage 需要 size > 0 才挂载（jsdom clientWidth=0）：补尺寸后手动触发 ResizeObserver 回调。
const roCallbacks: Array<() => void> = [];

function mountCanvasWithStage(): ReturnType<typeof render> {
  const view = render(<DesignCanvasTab />);
  const wrap = screen.getByTestId('design-canvas');
  Object.defineProperty(wrap, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(wrap, 'clientHeight', { value: 600, configurable: true });
  act(() => {
    roCallbacks.forEach((cb) => cb());
  });
  return view;
}

function enterAnnotMode(tool: 'text' | 'rect'): void {
  act(() => {
    toolbarProps.current?.setAnnotMode(true);
    toolbarProps.current?.setAnnotTool(tool);
  });
  act(() => {
    useDesignStore.setState({ annotInstruction: '把这里改成蓝色' });
  });
}

beforeEach(() => {
  roCallbacks.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  setCanvas();
  generation.editByAnnotation.mockReset();
  generation.editByAnnotation.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCanvas();
  useDesignStore.setState({ annotInstruction: '' });
});

describe('标注重绘：先校验圈区，后付费确认（2026-08-02 收口工单）', () => {
  it('只画了文字标签：不弹 window.confirm、不发起付费调用，直接提示「请先圈出区域」', async () => {
    mountCanvasWithStage();
    enterAnnotMode('text');

    // 真实事件链路：点画布落文字标注 → 输入 → Enter 提交（产出的是 text 形状，只有 label 没有面积）。
    fireEvent.mouseDown(screen.getByTestId('konva-stage'), { button: 0, clientX: 50, clientY: 60 });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '改成蓝色' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      await toolbarProps.current?.onAnnotRedraw();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(generation.editByAnnotation).not.toHaveBeenCalled();
    expect(useDesignCanvasStore.getState().error).toContain('圈出要修改的区域');
  });

  it('正对照：圈了 rect 区域时 confirm 真被弹、确认后 editByAnnotation 真被调用（防探针失明）', async () => {
    mountCanvasWithStage();
    enterAnnotMode('rect');

    // 拖一个 rect：down → move → up，产出有面积的标注形状。
    fireEvent.mouseDown(screen.getByTestId('konva-stage'), { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(screen.getByTestId('konva-stage'), { clientX: 120, clientY: 100 });
    fireEvent.mouseUp(screen.getByTestId('konva-stage'), { clientX: 120, clientY: 100 });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      await toolbarProps.current?.onAnnotRedraw();
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(generation.editByAnnotation).toHaveBeenCalledTimes(1);
    expect(useDesignCanvasStore.getState().error).toBeNull();
  });
});
