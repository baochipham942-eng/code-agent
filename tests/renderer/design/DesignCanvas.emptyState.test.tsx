// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvas 空态（2026-08-01 工单③ + K2 返工）：画布刚打开时主推「AI 生成图 → 精修」主线——
// 一句话 + 两条主线入口（对话描述 / 拖入粘贴图）。K2：删掉「绘图」单向门（那个只能置 true 的开关已不存在），
// 空态引导与画布级图解工具条共存；有内容后引导消失、工具条照常。mock 集与 DesignCanvas.error.test 同源。
// ---------------------------------------------------------------------------
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

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
  DesignImageToolbar: () => null,
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasSidePanel', () => ({
  DesignCanvasSidePanel: () => null,
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
  // 画布级工具条占位：留 testid 标记者在场；exportPptx 槽按 props 渲染（工单②接线）。
  DiagramToolbar: (props: { exportPptx?: { exporting: boolean; onExport: () => void } }) => (
    <div data-testid="diagram-toolbar-mock">
      {props.exportPptx ? (
        <button type="button" data-testid="design-canvas-export-pptx" onClick={props.exportPptx.onExport}>
          导出 PPTX
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../../../src/renderer/components/design/DesignCanvasOverlays', () => ({
  VideoPlayOverlay: () => null,
  DiffEvidenceOverlay: () => null,
}));

import { DesignCanvasTab } from '../../../src/renderer/components/design/DesignCanvasTab';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const imageNode = (id: string): CanvasImageNode => ({
  id,
  kind: 'image',
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  createdAt: 1,
  createdBy: 'user',
});

function setCanvas(nodes: CanvasImageNode[] = []): void {
  useDesignCanvasStore.setState({
    runDir: nodes.length > 0 ? '/tmp/design-run' : null,
    nodes,
    connectors: [],
    shapes: [],
    camera: { x: 0, y: 0, scale: 1 },
    selectedIds: [],
    selectedDiagram: null,
    generating: false,
    error: null,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  setCanvas();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCanvas();
});

describe('DesignCanvas 空态（工单③ + K2 共存返工）', () => {
  it('空画布：空态引导与画布级图解工具条同时可见，「绘图」入口已不存在', () => {
    render(<DesignCanvasTab />);

    expect(screen.getByTestId('design-canvas-empty-guide')).toBeTruthy();
    expect(screen.getByText('在左边对话里描述你想要的设计')).toBeTruthy();
    expect(screen.getByText('拖入 / 粘贴一张图')).toBeTruthy();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();
    expect(screen.queryByTestId('design-canvas-drawing-entry')).toBeNull();
    // K2：空画布不渲染缩放控件（没内容可缩放，适配视口无意义）
    expect(screen.queryByTestId('design-canvas-zoom-controls')).toBeNull();
  });

  it('加图后引导消失、工具条还在；删光后引导回来（不再是单向门）', () => {
    render(<DesignCanvasTab />);
    expect(screen.getByTestId('design-canvas-empty-guide')).toBeTruthy();

    act(() => setCanvas([imageNode('初版')]));
    expect(screen.queryByTestId('design-canvas-empty-guide')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();

    act(() => setCanvas([]));
    expect(screen.getByTestId('design-canvas-empty-guide')).toBeTruthy();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();
  });

  it('有内容后：工具条（含导出 PPTX 槽）在场，空态引导不出现，缩放控件在场', () => {
    setCanvas([imageNode('初版')]);
    render(<DesignCanvasTab />);

    expect(screen.queryByTestId('design-canvas-empty-guide')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();
    expect(screen.getByTestId('design-canvas-export-pptx')).toBeTruthy();
    expect(screen.getByTestId('design-canvas-zoom-controls')).toBeTruthy();
  });
});
