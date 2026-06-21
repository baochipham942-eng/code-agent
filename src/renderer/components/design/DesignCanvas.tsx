// 设计画布（Cowart 式无限画布，konva/react-konva）。
// P0：平移/缩放/图片节点/空状态。P1：文生图回灌。
// P2：点选图 → 圈选红框标注 → 局部重绘(通义万相 inpaint) → 新版回灌画布(带血缘)。
// 文案走 i18n（t.design.*），不硬编码。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect as KonvaRect, Text as KonvaText } from 'react-konva';
import type Konva from 'konva';
import { Palette, SquareDashedMousePointer, Sparkles, Loader2, X, GitCompare, Download } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';
import { useDesignCanvasGeneration } from './useDesignCanvasGeneration';
import { useDesignCanvasImport } from './useDesignCanvasImport';
import { DesignCompareOverlay } from './DesignCompareOverlay';
import { readWorkspaceImageAsDataUrl } from './designFiles';
import {
  normalizeDragRect,
  worldRectToImageRegion,
  type Rect,
} from './designCanvasMask';
import type { CanvasImageNode } from './designCanvasTypes';

// 缩放范围与步进（避免画布塌缩/无限放大）。
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;
const SCALE_STEP = 1.05;

function useNodeImage(runDir: string | null, src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let url: string | null = src;
      if (!/^(data:|https?:)/.test(src)) {
        url = runDir ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${src}`) : null;
      }
      if (!url || !alive) return;
      const image = new window.Image();
      image.onload = () => {
        if (alive) setImg(image);
      };
      image.src = url;
    })();
    return () => {
      alive = false;
    };
  }, [runDir, src]);
  return img;
}

const CanvasImage: React.FC<{
  node: CanvasImageNode;
  runDir: string | null;
  selected: boolean;
  onSelect: (additive: boolean) => void;
}> = ({ node, runDir, selected, onSelect }) => {
  const img = useNodeImage(runDir, node.src);
  if (!img) return null;
  const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const evt = e.evt as MouseEvent;
    onSelect(Boolean(evt.shiftKey || evt.metaKey));
  };
  // 徽标字号随相机缩放保持视觉恒定（用 1/scale 反算近似，简化为固定值即可）。
  const badge = Math.max(14, Math.round(node.width * 0.03));
  return (
    <>
      <KonvaImage
        image={img}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        onMouseDown={pick}
        onTap={pick}
      />
      {node.chosen && (
        <>
          <KonvaRect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            stroke="#10b981"
            strokeWidth={3}
            listening={false}
          />
          <KonvaText
            x={node.x + 8}
            y={node.y + 8}
            text="★"
            fontSize={badge}
            fill="#10b981"
            listening={false}
          />
        </>
      )}
      {selected && (
        <KonvaRect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          stroke="#e879f9"
          strokeWidth={2}
          dash={[10, 6]}
          listening={false}
        />
      )}
    </>
  );
};

export const DesignCanvas: React.FC = () => {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const nodes = useDesignCanvasStore((s) => s.nodes);
  const camera = useDesignCanvasStore((s) => s.camera);
  const setCamera = useDesignCanvasStore((s) => s.setCamera);
  const runDir = useDesignCanvasStore((s) => s.runDir);
  const selectedIds = useDesignCanvasStore((s) => s.selectedIds);
  const setSelected = useDesignCanvasStore((s) => s.setSelected);
  const generating = useDesignCanvasStore((s) => s.generating);
  const { editRegion } = useDesignCanvasGeneration();
  const { importFiles } = useDesignCanvasImport();

  // 圈选标注本地态（世界坐标）。
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<Rect[]>([]);
  const [draft, setDraft] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [comparing, setComparing] = useState(false);

  // 淘汰(软删除)的节点落盘保留但不在画布上呈现/参与对比。
  const visibleNodes = useMemo(() => nodes.filter((n) => !n.discarded), [nodes]);

  // 单选→局部重绘面板；双选→A/B 对比。
  const selectedNode =
    selectedIds.length === 1 ? visibleNodes.find((n) => n.id === selectedIds[0]) ?? null : null;
  const compareNodes =
    selectedIds.length === 2
      ? selectedIds
          .map((id) => visibleNodes.find((n) => n.id === id))
          .filter((n): n is CanvasImageNode => Boolean(n))
      : [];

  // 选择变化时退出对比浮层（除非仍是双选）。
  useEffect(() => {
    if (selectedIds.length !== 2) setComparing(false);
  }, [selectedIds]);

  const selectNode = (id: string, additive: boolean): void => {
    if (annotating) return;
    const cur = useDesignCanvasStore.getState().selectedIds;
    if (additive) {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2);
      setSelected(next);
    } else {
      setSelected([id]);
    }
  };

  // 容器尺寸跟随（Stage 需要显式像素宽高）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 选中变化时复位标注（换图重圈）。
  useEffect(() => {
    setAnnotations([]);
    setDraft(null);
  }, [selectedNode?.id]);

  // 自由画布：粘贴图片导入（剪贴板含图片时拦截，纯文本粘贴不受影响）。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => Boolean(f));
      if (files.length > 0) {
        e.preventDefault();
        void importFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importFiles]);

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) void importFiles(files);
  };

  const worldFromPointer = (): { x: number; y: number } | null => {
    const stage = stageRef.current;
    const p = stage?.getPointerPosition();
    if (!stage || !p) return null;
    return { x: (p.x - camera.x) / camera.scale, y: (p.y - camera.y) / camera.scale };
  };

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const oldScale = camera.scale;
    const mousePoint = { x: (pointer.x - camera.x) / oldScale, y: (pointer.y - camera.y) / oldScale };
    const direction = e.evt.deltaY > 0 ? 1 : -1;
    let newScale = direction > 0 ? oldScale / SCALE_STEP : oldScale * SCALE_STEP;
    newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, newScale));
    setCamera({ scale: newScale, x: pointer.x - mousePoint.x * newScale, y: pointer.y - mousePoint.y * newScale });
  };

  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    if (e.target !== stageRef.current) return;
    setCamera({ ...camera, x: e.target.x(), y: e.target.y() });
  };

  // 圈选标注：mousedown 起框 → move 更新 → up 落框（仅 annotating 时）。
  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (!annotating) {
      // 非标注模式：点空白处清除选择。
      if (e.target === stageRef.current) setSelected([]);
      return;
    }
    const w = worldFromPointer();
    if (!w) return;
    dragStart.current = w;
    setDraft({ x: w.x, y: w.y, width: 0, height: 0 });
  };
  const handleMouseMove = (): void => {
    if (!annotating || !dragStart.current) return;
    const w = worldFromPointer();
    if (!w) return;
    setDraft(normalizeDragRect(dragStart.current.x, dragStart.current.y, w.x, w.y));
  };
  const handleMouseUp = (): void => {
    if (!annotating || !draft) {
      dragStart.current = null;
      return;
    }
    if (draft.width > 4 && draft.height > 4) setAnnotations((a) => [...a, draft]);
    setDraft(null);
    dragStart.current = null;
  };

  const onExport = async (node: CanvasImageNode): Promise<void> => {
    const url = /^(data:|https?:)/.test(node.src)
      ? node.src
      : runDir
        ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
        : null;
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = node.src.split('/').pop() || 'design.png';
    a.click();
  };

  const onRepaint = async (): Promise<void> => {
    if (!selectedNode) return;
    const regions = annotations
      .map((r) => worldRectToImageRegion(r, selectedNode))
      .filter((r): r is Rect => r !== null);
    await editRegion({ baseNode: selectedNode, regions, instruction });
    if (!useDesignCanvasStore.getState().error) {
      setAnnotations([]);
      setInstruction('');
      setAnnotating(false);
    }
  };

  const draftAndCommitted = draft ? [...annotations, draft] : annotations;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden bg-zinc-900"
      data-testid="design-canvas"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {size.w > 0 && size.h > 0 && (
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          x={camera.x}
          y={camera.y}
          scaleX={camera.scale}
          scaleY={camera.scale}
          draggable={!annotating}
          onWheel={handleWheel}
          onDragEnd={handleDragEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <Layer>
            {visibleNodes.map((node) => (
              <CanvasImage
                key={node.id}
                node={node}
                runDir={runDir}
                selected={selectedIds.includes(node.id)}
                onSelect={(additive) => selectNode(node.id, additive)}
              />
            ))}
            {draftAndCommitted.map((r, i) => (
              <KonvaRect
                key={i}
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                stroke="#ef4444"
                strokeWidth={2}
                fill="rgba(239,68,68,0.15)"
                listening={false}
              />
            ))}
          </Layer>
        </Stage>
      )}

      {visibleNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
          <Palette className="h-6 w-6 text-zinc-600" />
          <span>{t.design.canvasEmpty}</span>
        </div>
      )}

      {/* 选中图后的局部重绘面板 */}
      {selectedNode && (
        <div className="absolute left-4 top-4 flex w-72 flex-col gap-2 rounded-xl border border-white/[0.1] bg-zinc-900/90 p-3 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setAnnotating((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
                annotating ? 'bg-red-500/20 text-red-200' : 'bg-white/[0.06] text-zinc-300 hover:text-zinc-100'
              }`}
            >
              <SquareDashedMousePointer className="h-3.5 w-3.5" />
              {annotating ? t.design.annotateStop : t.design.annotateStart}
            </button>
            {annotations.length > 0 && (
              <button
                type="button"
                onClick={() => setAnnotations([])}
                className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
                {t.design.clearAnnotations}（{annotations.length}）
              </button>
            )}
          </div>
          {annotating ? (
            <p className="text-[11px] leading-snug text-amber-300/80">{t.design.annotateHint}</p>
          ) : (
            annotations.length === 0 && (
              <p className="text-[11px] leading-snug text-zinc-500">{t.design.annotateGuide}</p>
            )
          )}
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t.design.editInstructionPlaceholder}
            rows={3}
            className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void onRepaint()}
            disabled={generating || annotations.length === 0 || !instruction.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {generating ? t.design.editingRegion : t.design.editRegionBtn}
          </button>
          <button
            type="button"
            onClick={() => void onExport(selectedNode)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
          >
            <Download className="h-3.5 w-3.5" />
            {t.design.exportImage}
          </button>
        </div>
      )}

      {selectedIds.length === 0 && visibleNodes.length > 0 && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-lg bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur">
          {t.design.canvasSelectHint} · {t.design.compareHint}
        </div>
      )}

      {/* 双选 → A/B 对比入口 */}
      {compareNodes.length === 2 && !comparing && (
        <button
          type="button"
          onClick={() => setComparing(true)}
          className="absolute bottom-6 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-fuchsia-500/90 px-4 py-2 text-sm font-medium text-white shadow-xl transition-colors hover:bg-fuchsia-500"
        >
          <GitCompare className="h-4 w-4" />
          {t.design.compareBtn}
        </button>
      )}

      {comparing && compareNodes.length === 2 && (
        <DesignCompareOverlay
          nodeA={compareNodes[0]}
          nodeB={compareNodes[1]}
          runDir={runDir}
          onClose={() => setComparing(false)}
        />
      )}
    </div>
  );
};
