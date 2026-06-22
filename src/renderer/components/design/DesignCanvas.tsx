// 设计画布（Cowart 式无限画布，konva/react-konva）。
// P0：平移/缩放/图片节点/空状态。P1：文生图回灌。
// P2：点选图 → 圈选红框标注 → 局部重绘(通义万相 inpaint) → 新版回灌画布(带血缘)。
// 文案走 i18n（t.design.*），不硬编码。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect as KonvaRect, Text as KonvaText } from 'react-konva';
import type Konva from 'konva';
import { Palette, SquareDashedMousePointer, Sparkles, Loader2, X, GitCompare, Download, FileDown, Pencil, Presentation, Film } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { IconButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { useDesignCanvasGeneration, type ExpandDirection } from './useDesignCanvasGeneration';
import { useDesignCanvasImport } from './useDesignCanvasImport';
import { DesignCompareOverlay } from './DesignCompareOverlay';
import { DesignImageEditOps } from './DesignImageEditOps';
import { AnnotationLayer, type AnnotShape, type AnnotTool } from './AnnotationLayer';
import { readWorkspaceImageAsDataUrl, exportImagePdf, exportCanvasPptx } from './designFiles';
import { imagePdfExportName, canvasPptxExportName } from './designTypes';
import { imageModelsWithCap } from '@shared/constants/visualModels';
import { estimateImageCostCny, formatCny } from '@shared/media/imageCost';
import {
  normalizeDragRect,
  worldRectToImageRegion,
  type Rect,
} from './designCanvasMask';
import {
  isImageNode,
  isVideoNode,
  formatDurationLabel,
  type CanvasImageNode,
  type CanvasVideoNode,
} from './designCanvasTypes';

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
  onViewDiff: (node: CanvasImageNode) => void;
}> = ({ node, runDir, selected, onSelect, onViewDiff }) => {
  const { t } = useI18n();
  const img = useNodeImage(runDir, node.src);
  if (!img) return null;
  const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const evt = e.evt as MouseEvent;
    onSelect(Boolean(evt.shiftKey || evt.metaKey));
  };
  // 徽标字号随相机缩放保持视觉恒定（用 1/scale 反算近似，简化为固定值即可）。
  const badge = Math.max(14, Math.round(node.width * 0.03));
  // T4 一致性徽章：clean=未选区守住(绿)；locked=已锁定未选区(琥珀, 可点开 diff 证据)。
  const c = node.consistency;
  const consistencyBadge = ((): React.ReactNode => {
    if (!c) return null;
    const isLocked = c.status === 'locked';
    const color = isLocked ? '#f59e0b' : '#10b981'; // ds-allow:viz konva 画布字面色，CSS 变量够不到
    const label = isLocked ? t.design.consistencyLocked : t.design.consistencyClean;
    const fs = badge;
    const padX = fs * 0.55;
    const pillW = Math.round(label.length * fs * 0.62 + padX * 2);
    const pillH = Math.round(fs * 1.7);
    const px = node.x + node.width - pillW - 8;
    const py = node.y + 8;
    const clickable = isLocked && Boolean(c.diffPath);
    const open = (): void => {
      if (clickable) onViewDiff(node);
    };
    return (
      <>
        <KonvaRect
          x={px}
          y={py}
          width={pillW}
          height={pillH}
          fill="rgba(9,9,11,0.78)"
          stroke={color}
          strokeWidth={1.5}
          cornerRadius={pillH / 2}
          listening={clickable}
          onMouseDown={open}
          onTap={open}
        />
        <KonvaText
          x={px}
          y={py + pillH * 0.26}
          width={pillW}
          align="center"
          text={label}
          fontSize={Math.round(fs * 0.72)}
          fill={color}
          listening={false}
        />
      </>
    );
  })();
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
            stroke="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
            strokeWidth={3}
            listening={false}
          />
          <KonvaText
            x={node.x + 8}
            y={node.y + 8}
            text="★"
            fontSize={badge}
            fill="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
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
          stroke="#e879f9" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={2}
          dash={[10, 6]}
          listening={false}
        />
      )}
      {consistencyBadge}
    </>
  );
};

// P2 视频节点：poster 缩略图（有则懒加载，无则深色占位）+ 居中播放徽标 + 左下时长 +
// 选中/主版高亮（与 CanvasImage 同视觉语言）。点播放徽标打开 DOM <video> 浮层。
const KonvaVideoNode: React.FC<{
  node: CanvasVideoNode;
  runDir: string | null;
  selected: boolean;
  onSelect: (additive: boolean) => void;
  onPlay: () => void;
}> = ({ node, runDir, selected, onSelect, onPlay }) => {
  const poster = useNodeImage(runDir, node.poster ?? '');
  const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const evt = e.evt as MouseEvent;
    onSelect(Boolean(evt.shiftKey || evt.metaKey));
  };
  const play = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    e.cancelBubble = true;
    onPlay();
  };
  const cy = node.y + node.height / 2;
  const glyph = Math.max(28, Math.round(Math.min(node.width, node.height) * 0.18));
  const durFs = Math.max(12, Math.round(node.width * 0.04));
  return (
    <>
      {poster ? (
        <KonvaImage image={poster} x={node.x} y={node.y} width={node.width} height={node.height} onMouseDown={pick} onTap={pick} />
      ) : (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          fill="#18181b" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          cornerRadius={6} onMouseDown={pick} onTap={pick}
        />
      )}
      <KonvaText
        x={node.x}
        y={cy - glyph / 2}
        width={node.width}
        align="center"
        text="▶"
        fontSize={glyph}
        fill="rgba(255,255,255,0.92)"
        onMouseDown={play}
        onTap={play}
      />
      <KonvaText
        x={node.x + 8}
        y={node.y + node.height - durFs * 1.6}
        text={formatDurationLabel(node.durationSec)}
        fontSize={durFs}
        fill="rgba(255,255,255,0.85)"
        listening={false}
      />
      {node.chosen && (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          stroke="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={3} listening={false}
        />
      )}
      {selected && (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          stroke="#e879f9" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={2} dash={[10, 6]} listening={false}
        />
      )}
    </>
  );
};

// P2 视频播放浮层（DOM，镜像 DiffEvidenceOverlay）：把 mp4 读成 data URL 喂 <video> 就地播放。
const VideoPlayOverlay: React.FC<{
  runDir: string | null;
  node: CanvasVideoNode;
  onClose: () => void;
}> = ({ runDir, node, onClose }) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!runDir) return;
      // readBinary 按扩展名返回 video/mp4，readWorkspaceImageAsDataUrl 用真实 mimeType → 可直接喂 <video>。
      const data = await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`);
      if (alive) setUrl(data);
    })();
    return () => {
      alive = false;
    };
  }, [runDir, node.src]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6">
      <IconButton
        onClick={onClose}
        className="absolute right-4 top-4"
        aria-label={t.design.videoPlayClose}
        icon={<X size={18} />}
      />
      {url ? (
        <video src={url} controls autoPlay className="max-h-[80%] max-w-[90%] rounded border border-white/20" />
      ) : (
        <Loader2 className="animate-spin text-zinc-500" size={20} />
      )}
    </div>
  );
};

// T4 diff 证据浮层：展示"模型偷改了哪些未选区域"（标红）+ 度量。
const DiffEvidenceOverlay: React.FC<{
  runDir: string | null;
  node: CanvasImageNode;
  onClose: () => void;
}> = ({ runDir, node, onClose }) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const diffPath = node.consistency?.diffPath;
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!runDir || !diffPath) return;
      const data = await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${diffPath}`);
      if (alive) setUrl(data);
    })();
    return () => {
      alive = false;
    };
  }, [runDir, diffPath]);
  const c = node.consistency;
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6">
      <div className="flex items-center gap-2 text-sm text-amber-300">
        <span>{t.design.diffEvidenceTitle}</span>
        <IconButton onClick={onClose} aria-label={t.design.diffClose} icon={<X size={16} />} />
      </div>
      {c && (
        <p className="text-[11px] text-zinc-400">
          {t.design.diffMaxDelta}: {Math.round(c.maxDelta)} · {t.design.diffChangedPixels}: {c.changedPixels}
        </p>
      )}
      {url ? (
        <img src={url} alt="diff" className="max-h-[70%] max-w-[90%] rounded border border-amber-500/40" />
      ) : (
        <Loader2 className="animate-spin text-zinc-500" size={20} />
      )}
      <p className="max-w-md text-center text-[11px] leading-snug text-zinc-500">{t.design.diffEvidenceHint}</p>
    </div>
  );
};

// 标注重绘模型下拉（cap 过滤）：仅列声明 annotEdit 能力的视觉模型，与 key 可用性求交，
// 未配置 key 的灰显。可用性经 listVisualImageModels IPC 拉取（与 ImageModelPicker 同源）。
const AnnotModelSelect: React.FC<{ value: string; onChange: (id: string) => void }> = ({
  value,
  onChange,
}) => {
  const { t } = useI18n();
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const capModels = useMemo(() => imageModelsWithCap('annotEdit'), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.domainAPI?.invoke<{ models: Array<{ id: string; available: boolean }> }>(
        IPC_DOMAINS.WORKSPACE,
        'listVisualImageModels',
      );
      if (!cancelled && res?.success && res.data?.models) {
        const map: Record<string, boolean> = {};
        for (const m of res.data.models) map[m.id] = m.available;
        setAvailability(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <select
      data-testid="annot-model-select"
      aria-label={t.design.imageModel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-1 text-xs text-zinc-200 focus:border-white/[0.3] focus:outline-none"
    >
      {capModels.map((m) => {
        const available = availability[m.id] ?? false;
        return (
          <option key={m.id} value={m.id} disabled={!available}>
            {available ? m.label : `${m.label}（${t.design.imageModelUnconfigured}）`}
          </option>
        );
      })}
    </select>
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
  const { editRegion, expand, removeWatermark, editByAnnotation, generateVideo } = useDesignCanvasGeneration();
  const { importFiles } = useDesignCanvasImport();

  // 标注重绘态（B4）：模式开关/指令/模型全走 designStore 瞬时态，不持久化。
  // 模型独立于全局 imageModel（文生图默认）——选第 2 个 annotEdit 模型不应改用户文生图默认（B4 审查 Minor2）。
  const annotMode = useDesignStore((s) => s.annotMode);
  const setAnnotMode = useDesignStore((s) => s.setAnnotMode);
  const annotInstruction = useDesignStore((s) => s.annotInstruction);
  const setAnnotInstruction = useDesignStore((s) => s.setAnnotInstruction);
  const annotModel = useDesignStore((s) => s.annotModel);
  const setAnnotModel = useDesignStore((s) => s.setAnnotModel);
  // 标注图形（世界坐标）+ 当前工具，本地态（换图重置）。
  const [annotShapes, setAnnotShapes] = useState<AnnotShape[]>([]);
  const [annotTool, setAnnotTool] = useState<AnnotTool>('pen');
  // 生效模型（cap 解析的唯一来源）：已选且仍具 annotEdit 能力则用之，否则取首个 annotEdit 模型为默认。
  // 保证下拉值、成本预估、送 IPC 的模型三处一致且必为 annotEdit-capable。
  const effectiveAnnotModel = useMemo(() => {
    const caps = imageModelsWithCap('annotEdit');
    return annotModel && caps.some((m) => m.id === annotModel) ? annotModel : caps[0]?.id ?? '';
  }, [annotModel]);

  // 圈选标注本地态（世界坐标）。
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<Rect[]>([]);
  const [draft, setDraft] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [comparing, setComparing] = useState(false);
  // 画布全幅 PPTX 导出进行中（防重复点击 + 按钮态）。
  const [exportingPptx, setExportingPptx] = useState(false);
  // T4 diff 证据浮层目标节点（locked 徽章点开）。
  const [diffNode, setDiffNode] = useState<CanvasImageNode | null>(null);
  const [playingVideo, setPlayingVideo] = useState<CanvasVideoNode | null>(null);
  // 扩图本地态：方向 + 比例（1.0–2.0）。
  const [expandDirection, setExpandDirection] = useState<ExpandDirection>('all');
  const [expandRatio, setExpandRatio] = useState(1.5);

  // 淘汰(软删除)的节点落盘保留但不在画布上呈现/参与对比。
  const visibleNodes = useMemo(() => nodes.filter((n) => !n.discarded), [nodes]);

  // 单选→局部重绘面板；双选→A/B 对比。
  const selectedNode =
    selectedIds.length === 1 ? visibleNodes.find((n) => n.id === selectedIds[0]) ?? null : null;
  // 图像专属编辑（圈选重绘/标注/扩图/去水印/导出）只对图节点开放；视频节点的渲染与操作走画布视频分支。
  const selectedImageNode = selectedNode && isImageNode(selectedNode) ? selectedNode : null;
  const compareNodes =
    selectedIds.length === 2
      ? selectedIds
          .map((id) => visibleNodes.find((n) => n.id === id))
          .filter((n): n is CanvasImageNode => n !== undefined && isImageNode(n))
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
    setAnnotShapes([]);
  }, [selectedNode?.id]);

  // 无图选中时强制退出标注重绘模式（标注 UI 仅在单选图节点时存在；选中视频节点也退出）。
  useEffect(() => {
    if (!selectedImageNode && annotMode) setAnnotMode(false);
  }, [selectedImageNode, annotMode, setAnnotMode]);

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

  // 选中图节点 → 单页 PDF（主进程 pdfkit 图嵌）→ 落「下载」。
  // 解析成 dataUrl 再传（data: 直用；相对路径经 readBinary 转 dataUrl）。
  // pdfkit 需要图字节，纯 http URL（未落盘的 OSS 临时链接）不直接支持，跳过。
  const onExportPdf = async (node: CanvasImageNode): Promise<void> => {
    const dataUrl = /^data:/.test(node.src)
      ? node.src
      : runDir && !/^https?:/.test(node.src)
        ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
        : null;
    if (!dataUrl) return;
    await exportImagePdf({ dataUrl }, imagePdfExportName(Date.now()));
  };

  // 画布全部活动图节点 → 全幅 PPTX（每张 1 张全幅 slide）→ 落「下载」。
  // 薄版：导出当前画布上全部可见（未淘汰）图节点，按画布顺序。逐张解析成 dataUrl
  // （data: 直用；相对路径经 readBinary 转）后送主进程 pptxgenjs 拼装。
  const onExportPptx = async (): Promise<void> => {
    if (visibleNodes.length === 0 || exportingPptx) return;
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
      if (images.length === 0) return;
      await exportCanvasPptx(images, canvasPptxExportName(Date.now()));
    } finally {
      setExportingPptx(false);
    }
  };

  const onRepaint = async (): Promise<void> => {
    if (!selectedImageNode) return;
    const regions = annotations
      .map((r) => worldRectToImageRegion(r, selectedImageNode))
      .filter((r): r is Rect => r !== null);
    await editRegion({ baseNode: selectedImageNode, regions, instruction });
    if (!useDesignCanvasStore.getState().error) {
      setAnnotations([]);
      setInstruction('');
      setAnnotating(false);
    }
  };

  // 标注重绘：成本确认 → 调 editByAnnotation → 成功后清标注、退模式。
  const onAnnotRedraw = async (): Promise<void> => {
    if (!selectedImageNode || annotShapes.length === 0 || !annotInstruction.trim()) return;
    const est = formatCny(estimateImageCostCny(effectiveAnnotModel));
    if (!window.confirm(`${t.design.annotCostConfirm}（${est}）`)) return;
    await editByAnnotation({
      baseNode: selectedImageNode,
      shapes: annotShapes,
      instruction: annotInstruction,
      model: effectiveAnnotModel,
    });
    if (!useDesignCanvasStore.getState().error) {
      setAnnotShapes([]);
      setAnnotInstruction('');
      setAnnotMode(false);
    }
  };

  // 扩图：按方向+比例外扩 → 新 variant 落底图右侧。
  const onExpand = async (): Promise<void> => {
    if (!selectedImageNode) return;
    await expand({ baseNode: selectedImageNode, direction: expandDirection, ratio: expandRatio });
  };

  // 去水印：消除中英文文字水印 → 新 variant 落底图右侧。
  const onRemoveWatermark = async (): Promise<void> => {
    if (!selectedImageNode) return;
    await removeWatermark({ baseNode: selectedImageNode });
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
          draggable={!annotating && !annotMode}
          onWheel={handleWheel}
          onDragEnd={handleDragEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <Layer>
            {visibleNodes.map((node) =>
              // 图节点走 CanvasImage；视频节点走 KonvaVideoNode（缩略图+播放徽标）。
              isVideoNode(node) ? (
                <KonvaVideoNode
                  key={node.id}
                  node={node}
                  runDir={runDir}
                  selected={selectedIds.includes(node.id)}
                  onSelect={(additive) => selectNode(node.id, additive)}
                  onPlay={() => setPlayingVideo(node)}
                />
              ) : (
                <CanvasImage
                  key={node.id}
                  node={node}
                  runDir={runDir}
                  selected={selectedIds.includes(node.id)}
                  onSelect={(additive) => selectNode(node.id, additive)}
                  onViewDiff={setDiffNode}
                />
              ),
            )}
            {draftAndCommitted.map((r, i) => (
              <KonvaRect
                key={i}
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                stroke="#ef4444" // ds-allow:viz konva 画布字面色，CSS 变量够不到
                strokeWidth={2}
                fill="rgba(239,68,68,0.15)"
                listening={false}
              />
            ))}
          </Layer>
          {annotMode && selectedImageNode && (
            <AnnotationLayer shapes={annotShapes} onShapesChange={setAnnotShapes} tool={annotTool} />
          )}
        </Stage>
      )}

      {visibleNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
          <Palette className="h-6 w-6 text-zinc-600" />
          <span>{t.design.canvasEmpty}</span>
        </div>
      )}

      {/* 画布全幅 PPTX 导出（薄版）：当前画布上有图即显示，把全部活动图节点打成一份
          全幅 deck（每张 1 张全幅 slide），给干系人打包。<1 张图时隐藏。 */}
      {visibleNodes.length > 0 && (
        <>
          {/* ds-allow:start 画布操作栏沿用旧裸 button 样式，与同栏导出图片/PDF 按钮一致；design-mode 整体 W3 收口时统一迁 primitive */}
          <button
            type="button"
            onClick={() => void onExportPptx()}
            disabled={exportingPptx}
            className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 shadow-xl backdrop-blur transition-colors hover:text-zinc-100 disabled:opacity-50"
          >
            {exportingPptx ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Presentation className="h-3.5 w-3.5" />
            )}
            {t.design.exportCanvasPptx}
          </button>
          {/* ds-allow:end */}
        </>
      )}

      {/* 选中图后的局部重绘面板（仅图节点；视频节点不显示图像编辑工具） */}
      {selectedImageNode && (
        <div className="absolute left-4 top-4 flex w-72 flex-col gap-2 rounded-xl border border-white/[0.1] bg-zinc-900/90 p-3 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between">
            {/* ds-allow:start 圈选开关用 toggle 态自定义填充（active=bg-red-500/20，idle=bg-white/[0.06]，非 Button variant）+ 清除标注用裸文字按钮 */}
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
            {/* ds-allow:end */}
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
          {/* ds-allow:start 局部重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言）+ 导出图片/图生视频用透明描边自定义样式（Button secondary 实色会回归） */}
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
            onClick={() => void onExport(selectedImageNode)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
          >
            <Download className="h-3.5 w-3.5" />
            {t.design.exportImage}
          </button>
          {/* P2 图生视频：以选中图为底图，生成前 confirm 预估 ¥（走 generateVideo i2v 路径）。 */}
          <button
            type="button"
            onClick={() => void generateVideo({ baseNode: selectedImageNode })}
            disabled={generating}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-50"
          >
            <Film className="h-3.5 w-3.5" />
            {t.design.generateVideoFromImage}
          </button>
          {/* ds-allow:end */}
          {/* ds-allow:start 画布节点操作栏沿用旧裸 button 样式，与同栏导出图片按钮一致；design-mode 整体 W3 收口时统一迁 primitive */}
          <button
            type="button"
            onClick={() => void onExportPdf(selectedImageNode)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
          >
            <FileDown className="h-3.5 w-3.5" />
            {t.design.exportImagePdf}
          </button>
          {/* ds-allow:end */}

          {/* T3：wanx 扩图（方向+比例）+ 去水印，各落新 variant 挂 spine */}
          <DesignImageEditOps
            t={t}
            direction={expandDirection}
            ratio={expandRatio}
            generating={generating}
            onDirectionChange={setExpandDirection}
            onRatioChange={setExpandRatio}
            onExpand={() => void onExpand()}
            onRemoveWatermark={() => void onRemoveWatermark()}
          />

          {/* B4：标注重绘（自由画标注 + 指令 + cap 模型 → editImageByAnnotation → 新 variant 挂 spine） */}
          <div className="mt-1 flex flex-col gap-2 border-t border-white/[0.08] pt-2">
            {/* ds-allow:start 标注重绘开关用 toggle 态自定义填充（active=bg-fuchsia-500/20，idle=bg-white/[0.06]，非 Button variant） */}
            <button
              type="button"
              onClick={() => setAnnotMode(!annotMode)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
                annotMode ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-white/[0.06] text-zinc-300 hover:text-zinc-100'
              }`}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t.design.annotMode}
            </button>
            {/* ds-allow:end */}
            {annotMode && (
              <>
                {/* 工具选择：自由笔 / 箭头 / 矩形 / 文字 */}
                <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
                  {/* ds-allow:start 标注工具分段控件（active 用自定义 bg-white/[0.10]，非 Button variant） */}
                  {([
                    ['pen', t.design.annotToolPen],
                    ['arrow', t.design.annotToolArrow],
                    ['rect', t.design.annotToolRect],
                    ['text', t.design.annotToolText],
                  ] as Array<[AnnotTool, string]>).map(([tool, label]) => (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => setAnnotTool(tool)}
                      className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                        annotTool === tool ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {/* ds-allow:end */}
                </div>
                {/* 重绘模型（cap 过滤；瞬时 annotModel，与全局 imageModel 解耦） */}
                <AnnotModelSelect value={effectiveAnnotModel} onChange={setAnnotModel} />
                {/* 重绘指令（带可见 label） */}
                <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                  <span>{t.design.annotInstruction}</span>
                  <textarea
                    value={annotInstruction}
                    onChange={(e) => setAnnotInstruction(e.target.value)}
                    placeholder={t.design.annotInstructionPlaceholder}
                    rows={2}
                    className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
                  />
                </label>
                {/* 成本预估 */}
                <div className="text-[11px] text-zinc-500">
                  {t.design.costEstimateLabel}{' '}
                  <span className="font-mono text-emerald-300">{formatCny(estimateImageCostCny(effectiveAnnotModel))}</span>
                </div>
                {/* ds-allow:start 标注重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言） */}
                <button
                  type="button"
                  onClick={() => void onAnnotRedraw()}
                  disabled={generating || annotShapes.length === 0 || !annotInstruction.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
                >
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t.design.annotRedraw}
                </button>
                {/* ds-allow:end */}
              </>
            )}
          </div>
        </div>
      )}

      {selectedIds.length === 0 && visibleNodes.length > 0 && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-lg bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur">
          {t.design.canvasSelectHint} · {t.design.compareHint}
        </div>
      )}

      {/* 双选 → A/B 对比入口 */}
      {compareNodes.length === 2 && !comparing && (
        // ds-allow:start 画布悬浮对比 CTA（绝对定位 rounded-full 胶囊 + 设计区品牌色 bg-fuchsia-500/90，非 Button variant/形状）
        <button
          type="button"
          onClick={() => setComparing(true)}
          className="absolute bottom-6 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-fuchsia-500/90 px-4 py-2 text-sm font-medium text-white shadow-xl transition-colors hover:bg-fuchsia-500"
        >
          <GitCompare className="h-4 w-4" />
          {t.design.compareBtn}
        </button>
        // ds-allow:end
      )}

      {comparing && compareNodes.length === 2 && (
        <DesignCompareOverlay
          nodeA={compareNodes[0]}
          nodeB={compareNodes[1]}
          runDir={runDir}
          onClose={() => setComparing(false)}
        />
      )}

      {playingVideo && (
        <VideoPlayOverlay runDir={runDir} node={playingVideo} onClose={() => setPlayingVideo(null)} />
      )}
      {diffNode && (
        <DiffEvidenceOverlay runDir={runDir} node={diffNode} onClose={() => setDiffNode(null)} />
      )}
    </div>
  );
};
