// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const designFiles = vi.hoisted(() => ({
  readWorkspaceImageAsDataUrl: vi.fn(),
  exportImagePdf: vi.fn(),
  exportCanvasPptx: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  ...designFiles,
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

const toolbarProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('../../../src/renderer/components/design/DesignImageToolbar', () => ({
  DesignImageToolbar: (props: {
    onExportImage: () => void;
    onExportPdf: () => void;
    onExportCanvasPptx: () => void;
  }) => {
    toolbarProps.current = props as unknown as Record<string, unknown>;
    const { onExportImage, onExportPdf, onExportCanvasPptx } = props;
    return (
      <div>
        <button type="button" onClick={onExportImage}>测试导出图片</button>
        <button type="button" onClick={onExportPdf}>测试导出 PDF</button>
        <button type="button" onClick={onExportCanvasPptx}>测试导出 PPTX</button>
      </div>
    );
  },
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
});

function setCanvas(node?: CanvasImageNode, error: string | null = null): void {
  useDesignCanvasStore.setState({
    runDir: node ? '/tmp/design-run' : null,
    nodes: node ? [node] : [],
    connectors: [],
    shapes: [],
    camera: { x: 0, y: 0, scale: 1 },
    selectedIds: node ? [node.id] : [],
    selectedDiagram: null,
    generating: false,
    error,
    setError: originalSetError,
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
  designFiles.readWorkspaceImageAsDataUrl.mockReset();
  designFiles.exportImagePdf.mockReset();
  designFiles.exportCanvasPptx.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCanvas();
});

describe('DesignCanvas tab 错误条', () => {
  it('tab 挂载的画布显示 store error，关闭时调用 setError(null)', () => {
    const setError = vi.fn(originalSetError);
    setCanvas(undefined, '图片生成失败，请稍后重试。');
    useDesignCanvasStore.setState({ setError });

    render(<DesignCanvasTab />);

    expect(screen.getByTestId('design-canvas-error-bar').textContent).toContain(
      '图片生成失败，请稍后重试。',
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭错误提示' }));
    expect(setError).toHaveBeenCalledWith(null);
    expect(useDesignCanvasStore.getState().error).toBeNull();
  });

  it('图片导出读取不到源文件时显示可读原因', async () => {
    setCanvas(imageNode('assets/missing.png'));
    designFiles.readWorkspaceImageAsDataUrl.mockResolvedValue(null);
    render(<DesignCanvasTab />);

    fireEvent.click(screen.getByRole('button', { name: '测试导出图片' }));

    expect((await screen.findByTestId('design-canvas-error-bar')).textContent).toContain(
      '图片导出失败，请确认原图仍在工作区后重试。',
    );
  });

  it('PDF 导出失败时显示返回的失败原因', async () => {
    setCanvas(imageNode('data:image/png;base64,AAAA'));
    designFiles.exportImagePdf.mockResolvedValue({ filePath: null, error: '磁盘空间不足' });
    render(<DesignCanvasTab />);

    fireEvent.click(screen.getByRole('button', { name: '测试导出 PDF' }));

    await waitFor(() => {
      expect(screen.getByTestId('design-canvas-error-bar').textContent).toContain(
        'PDF 导出失败：磁盘空间不足',
      );
    });
  });

  it('整册 PPTX 导出失败时显示返回的失败原因（入口已收进动词条「更多 · 整个画布」）', async () => {
    setCanvas(imageNode('data:image/png;base64,AAAA'));
    designFiles.exportCanvasPptx.mockResolvedValue({ filePath: null, error: '没有下载目录权限' });
    render(<DesignCanvasTab />);

    fireEvent.click(screen.getByRole('button', { name: '测试导出 PPTX' }));

    await waitFor(() => {
      expect(screen.getByTestId('design-canvas-error-bar').textContent).toContain(
        'PPTX 导出失败：没有下载目录权限',
      );
    });
  });
});

describe('批注重绘默认模型（2026-08-01 返工#4）', () => {
  const stubModelAvailability = (available: boolean): void => {
    vi.stubGlobal('domainAPI', {
      invoke: vi.fn().mockResolvedValue({
        success: true,
        data: { models: [{ id: 'gpt-image-2', label: 'GPT-image-2', available }] },
      }),
    });
  };

  it('唯一 annotEdit 模型配了 key → 默认生效模型就是它，入口不降级', async () => {
    stubModelAvailability(true);
    setCanvas(imageNode('data:image/png;base64,AAAA'));
    render(<DesignCanvasTab />);

    await waitFor(() => expect(toolbarProps.current?.effectiveAnnotModel).toBe('gpt-image-2'));
    expect(toolbarProps.current?.annotModelUnavailable).toBe(false);
  });

  it('唯一 annotEdit 模型没配 key → 生效模型置空 + annotModelUnavailable=true（默认档不许指向用不了的模型）', async () => {
    stubModelAvailability(false);
    setCanvas(imageNode('data:image/png;base64,AAAA'));
    render(<DesignCanvasTab />);

    await waitFor(() => expect(toolbarProps.current?.annotModelUnavailable).toBe(true));
    expect(toolbarProps.current?.effectiveAnnotModel).toBe('');
  });
});
