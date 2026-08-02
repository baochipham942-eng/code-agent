// 画布导出 hook（2026-07-31 从 DesignCanvas 抽出，逻辑原样搬迁）：导出图片 / 单页 PDF / 全幅 PPTX。
// 抽出的直接动机：DesignCanvas 触 1000 有效行门，顶栏语义反转要求该行数净下降。
import { useCallback, useMemo, useState } from 'react';
import { useDesignCanvasStore } from './designCanvasStore';
import { readWorkspaceImageAsDataUrl, exportImagePdf, exportCanvasPptx } from './designFiles';
import { imagePdfExportName, canvasPptxExportName } from './designTypes';
import type { CanvasImageNode } from './designCanvasTypes';

export function useDesignCanvasExports(): {
  exportingPptx: boolean;
  exportImage: (node: CanvasImageNode) => Promise<void>;
  exportImagePdf: (node: CanvasImageNode) => Promise<void>;
  exportCanvasPptx: () => Promise<void>;
} {
  const runDir = useDesignCanvasStore((s) => s.runDir);
  const nodes = useDesignCanvasStore((s) => s.nodes);
  const setError = useDesignCanvasStore((s) => s.setError);
  // 画布全幅 PPTX 导出进行中（防重复点击 + 按钮态）。
  const [exportingPptx, setExportingPptx] = useState(false);
  // 淘汰(软删除)的节点落盘保留但不参与导出。
  const visibleNodes = useMemo(() => nodes.filter((n) => !n.discarded), [nodes]);

  const exportImage = useCallback(
    async (node: CanvasImageNode): Promise<void> => {
      setError(null);
      try {
        const url = /^(data:|https?:)/.test(node.src)
          ? node.src
          : runDir
            ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
            : null;
        if (!url) {
          setError('图片导出失败，请确认原图仍在工作区后重试。');
          return;
        }
        const a = document.createElement('a');
        a.href = url;
        a.download = node.src.split('/').pop() || 'design.png';
        a.click();
      } catch {
        setError('图片导出失败，请稍后重试。');
      }
    },
    [runDir, setError],
  );

  // 选中图节点 → 单页 PDF（主进程 pdfkit 图嵌）→ 落「下载」。
  // 解析成 dataUrl 再传（data: 直用；相对路径经 readBinary 转 dataUrl）。
  // pdfkit 需要图字节，纯 http URL（未落盘的 OSS 临时链接）不直接支持，跳过。
  const exportImagePdfFn = useCallback(
    async (node: CanvasImageNode): Promise<void> => {
      setError(null);
      try {
        const dataUrl = /^data:/.test(node.src)
          ? node.src
          : runDir && !/^https?:/.test(node.src)
            ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
            : null;
        if (!dataUrl) {
          setError('PDF 导出失败，请确认原图仍在工作区后重试。');
          return;
        }
        const result = await exportImagePdf({ dataUrl }, imagePdfExportName(Date.now()));
        if (!result.filePath) {
          setError(result.error ? `PDF 导出失败：${result.error}` : 'PDF 导出失败，请稍后重试。');
        }
      } catch {
        setError('PDF 导出失败，请稍后重试。');
      }
    },
    [runDir, setError],
  );

  // 画布全部活动图节点 → 全幅 PPTX（每张 1 张全幅 slide）→ 落「下载」。
  // 薄版：导出当前画布上全部可见（未淘汰）图节点，按画布顺序。逐张解析成 dataUrl
  // （data: 直用；相对路径经 readBinary 转）后送主进程 pptxgenjs 拼装。
  const exportCanvasPptxFn = useCallback(async (): Promise<void> => {
    if (visibleNodes.length === 0 || exportingPptx) return;
    setError(null);
    setExportingPptx(true);
    try {
      const images: Array<{ dataUrl?: string }> = [];
      for (const node of visibleNodes) {
        const dataUrl = /^data:/.test(node.src)
          ? node.src
          : runDir && !/^https?:/.test(node.src)
            ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
            : null;
        if (dataUrl) images.push({ dataUrl });
      }
      if (images.length === 0) {
        setError('PPTX 导出失败，请确认画布中的原图仍在工作区后重试。');
        return;
      }
      const result = await exportCanvasPptx(images, canvasPptxExportName(Date.now()));
      if (!result.filePath) {
        setError(result.error ? `PPTX 导出失败：${result.error}` : 'PPTX 导出失败，请稍后重试。');
      }
    } catch {
      setError('PPTX 导出失败，请稍后重试。');
    } finally {
      setExportingPptx(false);
    }
  }, [visibleNodes, exportingPptx, runDir, setError]);

  return { exportingPptx, exportImage, exportImagePdf: exportImagePdfFn, exportCanvasPptx: exportCanvasPptxFn };
}
