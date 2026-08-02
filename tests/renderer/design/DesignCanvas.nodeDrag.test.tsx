// @vitest-environment jsdom
// 画布节点拖动（用户侧）组件层钉板：
//  1) onDragEnd → updateNode 落新坐标 + 必须调 saveCanvasDoc 落盘（漏了拖完刷新回原位，变异①）；
//  2) onDragStart → markNodeUserTouched 打戳（无 undo 帧），agent 后续 moveNode 走 user-touched 审批（变异②）；
//  3) canDrag 只闸空格 pan 修饰键。
// konva 在 jsdom 下不可渲染：react-konva 整体打桩（Stage/Layer 直渲染子级），
// DesignCanvasNodes mock 成 props 捕获器，直接调 drag 回调断言宿主接线。
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  imageProps: null as null | {
    canDrag: boolean;
    onDragStart: () => void;
    onDragEnd: (pos: { x: number; y: number }) => void;
  },
  saveCanvasDoc: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('react-konva', () => ({
  Stage: ({ children }: { children?: React.ReactNode }) => <div data-testid="konva-stage">{children}</div>,
  Layer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Rect: () => null,
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasNodes', () => ({
  CanvasImage: (props: NonNullable<typeof captured.imageProps>) => {
    captured.imageProps = props;
    return null;
  },
  KonvaVideoNode: () => null,
}));

vi.mock('../../../src/renderer/components/design/designCanvasPersistence', () => ({
  saveCanvasDoc: (...args: unknown[]) => captured.saveCanvasDoc(...args),
  loadCanvasDoc: vi.fn(async () => null),
}));

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
    editByAnnotation: vi.fn(),
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
  useAutonomyEnvelopeReview: () => ({ pendingRequest: null, grant: vi.fn(), decline: vi.fn() }),
}));

vi.mock('../../../src/renderer/components/design/useCanvasVideoRequest', () => ({
  useCanvasVideoRequest: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/DesignImageEditPanel', () => ({
  DesignImageEditPanel: () => null,
}));

vi.mock('../../../src/renderer/components/design/DesignLayerPanel', () => ({
  DesignLayerPanel: () => null,
}));

vi.mock('../../../src/renderer/components/design/AnnotationLayer', () => ({
  AnnotationLayer: () => null,
  reduceAnnot: () => [],
}));

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
import { hasUserTouch } from '../../../src/renderer/components/design/canvasActor';
import { splitCanvasProposalOps } from '../../../src/renderer/components/design/canvasProposalApproval';
import type { CanvasImageNode, DesignCanvasDoc } from '../../../src/renderer/components/design/designCanvasTypes';

const RUN_DIR = '/tmp/design-drag-run';

const agentNode = (): CanvasImageNode => ({
  id: 'img-1',
  kind: 'image',
  src: 'assets/img-1.png',
  x: 10,
  y: 20,
  width: 320,
  height: 180,
  createdAt: 1,
  createdBy: 'agent',
});

function seed(): void {
  const doc: DesignCanvasDoc = { version: 1, nodes: [agentNode()], camera: { x: 0, y: 0, scale: 1 } };
  useDesignCanvasStore.getState().loadDoc(RUN_DIR, doc);
}

const get = () => useDesignCanvasStore.getState();

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  // jsdom 的 clientWidth/Height 恒 0，DesignCanvas 尺寸为 0 不渲染 Stage；钉一个固定视口。
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  captured.imageProps = null;
  captured.saveCanvasDoc.mockClear();
  seed();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DesignCanvas 节点拖动接线', () => {
  it('onDragEnd：落新坐标进 store 并调 saveCanvasDoc 持久化（一步 undo 可回）', () => {
    render(<DesignCanvasTab />);
    expect(captured.imageProps).not.toBeNull();

    act(() => captured.imageProps!.onDragEnd({ x: 123, y: 45 }));

    const node = get().nodes.find((n) => n.id === 'img-1')!;
    expect({ x: node.x, y: node.y }).toEqual({ x: 123, y: 45 });
    // 落盘是调用点驱动：dragEnd 必须触发 saveCanvasDoc，且写出的 doc 带新坐标。
    expect(captured.saveCanvasDoc).toHaveBeenCalledTimes(1);
    const [runDir, doc] = captured.saveCanvasDoc.mock.calls[0] as [string, DesignCanvasDoc];
    expect(runDir).toBe(RUN_DIR);
    expect(doc.nodes.find((n) => n.id === 'img-1')).toMatchObject({ x: 123, y: 45 });
    // 一次拖动 = 一帧 undo。
    expect(get().editHistory.past).toHaveLength(1);
    act(() => get().undoEdit());
    expect(get().nodes.find((n) => n.id === 'img-1')).toMatchObject({ x: 10, y: 20 });
  });

  it('onDragStart：打 user 戳（无 undo 帧），agent 后续 moveNode 走 user-touched 审批', () => {
    render(<DesignCanvasTab />);
    const moveOp = { kind: 'moveNode', nodeId: 'img-1', x: 5, y: 6 } as const;
    // 打戳前：agent 自建未碰节点免批直落。
    expect(splitCanvasProposalOps([moveOp], get().nodes).approvalOps).toHaveLength(0);

    act(() => captured.imageProps!.onDragStart());

    const node = get().nodes.find((n) => n.id === 'img-1')!;
    expect(hasUserTouch(node)).toBe(true);
    expect(get().editHistory.past).toHaveLength(0); // 打戳不产生空撤销帧
    const split = splitCanvasProposalOps([moveOp], get().nodes);
    expect(split.approvalOps).toHaveLength(1);
    expect(split.approvalReason).toBe('user-touched');
  });

  it('canDrag 默认 true，按住空格 pan 修饰键时置 false', () => {
    render(<DesignCanvasTab />);
    expect(captured.imageProps!.canDrag).toBe(true);

    fireEvent.keyDown(window, { code: 'Space' });
    expect(captured.imageProps!.canDrag).toBe(false);

    fireEvent.keyUp(window, { code: 'Space' });
    expect(captured.imageProps!.canDrag).toBe(true);
  });
});
