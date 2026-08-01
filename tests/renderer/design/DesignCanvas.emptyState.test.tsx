// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvas 空态（2026-08-01 工单③）：画布刚打开时主推「AI 生成图 → 精修」主线——
// 一句话 + 两条主线入口（对话描述 / 拖入粘贴图），画图工具收进「绘图」入口，
// 点开才展开画布级工具条；有内容后回到原行为。mock 集与 DesignCanvas.error.test 同源。
// ---------------------------------------------------------------------------
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

describe('DesignCanvas 空态（工单③）', () => {
  it('空画布：主线引导在场（两条入口 + 绘图入口），画布级工具条不铺开', () => {
    render(<DesignCanvasTab />);

    expect(screen.getByTestId('design-canvas-empty-guide')).toBeTruthy();
    expect(screen.getByText('在左边对话里描述你想要的设计')).toBeTruthy();
    expect(screen.getByText('拖入 / 粘贴一张图')).toBeTruthy();
    expect(screen.getByTestId('design-canvas-drawing-entry')).toBeTruthy();
    expect(screen.queryByTestId('diagram-toolbar-mock')).toBeNull();
  });

  it('点「绘图」入口：引导让位，画布级工具条展开（画图能力不删，只降级呈现）', () => {
    render(<DesignCanvasTab />);

    fireEvent.click(screen.getByTestId('design-canvas-drawing-entry'));

    expect(screen.queryByTestId('design-canvas-empty-guide')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();
  });

  it('有内容后回到原行为：工具条（含导出 PPTX 槽）在场，空态引导不再出现', () => {
    setCanvas([imageNode('初版')]);
    render(<DesignCanvasTab />);

    expect(screen.queryByTestId('design-canvas-empty-guide')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar-mock')).toBeTruthy();
    expect(screen.getByTestId('design-canvas-export-pptx')).toBeTruthy();
  });
});
