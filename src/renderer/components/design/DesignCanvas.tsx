// 设计画布（Cowart 式无限画布，konva/react-konva）。
// P0：平移/缩放/图片节点/空状态。P1：文生图回灌。
// P2：点选图 → 圈选红框标注 → 局部重绘(通义万相 inpaint) → 新版回灌画布(带血缘)。
// 文案走 i18n（t.design.*），不硬编码。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Rect as KonvaRect } from 'react-konva';
import type Konva from 'konva';
import { Palette, Loader2, X, GitCompare, Presentation } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { useDesignCanvasGeneration, type ExpandDirection } from './useDesignCanvasGeneration';
import { useDesignCanvasImport } from './useDesignCanvasImport';
import { DesignCompareOverlay } from './DesignCompareOverlay';
import { DesignImageEditPanel } from './DesignImageEditPanel';
import { DesignLayerPanel } from './DesignLayerPanel';
import { CanvasImage, KonvaVideoNode } from './DesignCanvasNodes';
import { AnnotationLayer, reduceAnnot, type AnnotShape, type AnnotTool } from './AnnotationLayer';
import { DiagramLayer, type DiagramCanvasTool, type TextEditTarget } from './DiagramLayer';
import { CanvasProposalGhostLayer } from './CanvasProposalGhostLayer';
import { CanvasProposalReviewBar } from './CanvasProposalReviewBar';
import { DiscardedNodesTray } from './DiscardedNodesTray';
import { useCanvasProposalReview } from './useCanvasProposalReview';
import { useAutonomyEnvelopeReview } from './useAutonomyEnvelopeReview';
import { useCanvasVideoRequest } from './useCanvasVideoRequest';
import { CanvasAutonomyReviewBar } from './CanvasAutonomyReviewBar';
import { useDesignAutonomyStore } from './designAutonomyStore';
import { DiagramToolbar } from './DiagramToolbar';
import { reduceDiagram, type ShapeTool } from './diagramReducer';
import { DIAGRAM_DEFAULT_COLOR, type CanvasShape } from './designDiagramTypes';
import { saveCanvasDoc } from './designCanvasPersistence';
import { dispatchCanvasUndoKey } from './canvasUndoKeybinding';
import { dispatchCanvasDeleteKey } from './canvasDeleteKeybinding';
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
  isReferenceNode,
  computeFitCamera,
  type CanvasImageNode,
  type CanvasVideoNode,
} from './designCanvasTypes';
import {
  classifyPointerDragIntent,
  classifyWheelIntent,
  panBy,
  panFromWheel,
  zoomFromWheel,
} from './canvasCameraInput';
import { VideoPlayOverlay, DiffEvidenceOverlay } from './DesignCanvasOverlays';

export const DesignCanvas: React.FC = () => {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const spaceDownRef = useRef(false);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  const [panModifierActive, setPanModifierActive] = useState(false);

  const nodes = useDesignCanvasStore((s) => s.nodes);
  const camera = useDesignCanvasStore((s) => s.camera);
  const setCamera = useDesignCanvasStore((s) => s.setCamera);
  const runDir = useDesignCanvasStore((s) => s.runDir);
  const selectedIds = useDesignCanvasStore((s) => s.selectedIds);
  const setSelected = useDesignCanvasStore((s) => s.setSelected);
  const renameNode = useDesignCanvasStore((s) => s.renameNode);
  const setChosen = useDesignCanvasStore((s) => s.setChosen);
  const discardNode = useDesignCanvasStore((s) => s.discardNode);
  const deleteNodes = useDesignCanvasStore((s) => s.deleteNodes);
  const generating = useDesignCanvasStore((s) => s.generating);
  // —— 图解层（连线 / freeform 形状）——
  const connectors = useDesignCanvasStore((s) => s.connectors);
  const shapes = useDesignCanvasStore((s) => s.shapes);
  // ADR-026：订阅 agent 画布提议 + Apply/Reject 落地。
  const canvasProposal = useCanvasProposalReview();
  // ADR-027：订阅 agent 自主信封请求 + Grant/Decline；活跃信封态驱动进度/停止指示。
  const autonomy = useAutonomyEnvelopeReview();
  // 2b：订阅 agent 经 ProposeVideoOps 发来的出视频请求 → 落画布视频节点。
  useCanvasVideoRequest();
  const autonomyEnvelope = useDesignAutonomyStore((st) => st.envelope);
  const autonomyClear = useDesignAutonomyStore((st) => st.clear);
  const selectedDiagram = useDesignCanvasStore((s) => s.selectedDiagram);
  const setSelectedDiagram = useDesignCanvasStore((s) => s.setSelectedDiagram);
  const [diagramTool, setDiagramTool] = useState<DiagramCanvasTool>('select');
  const [diagramColor, setDiagramColor] = useState<string>(DIAGRAM_DEFAULT_COLOR);
  // 图解文字内联编辑目标（新建 text / 编辑形状文字 / 编辑连线 label）。
  const [diagramText, setDiagramText] = useState<{ target: TextEditTarget; value: string } | null>(null);
  // 防 Enter+blur 双提交（new-text 会落两份）：每次开编辑器重置，提交/取消后置 true 吃掉卸载触发的 blur（修 skeptic MED-2）。
  const diagramTextDoneRef = useRef(false);
  const openDiagramText = (target: TextEditTarget): void => {
    diagramTextDoneRef.current = false;
    setDiagramText({ target, value: target.kind === 'new-text' ? '' : target.initial });
  };
  // 进行中的图解绘制形状（Stage 处理器维护，up 后提交进 store）。
  const [diagramDraft, setDiagramDraft] = useState<CanvasShape | null>(null);
  const diagramDrawing = useRef(false);
  const isShapeTool = diagramTool !== 'select' && diagramTool !== 'connect';
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
  // 文字标注：画布内输入框（替代原生 window.prompt）。world=落点世界坐标，value=草稿文字。
  const [textDraft, setTextDraft] = useState<{ world: { x: number; y: number }; value: string } | null>(
    null,
  );
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
  // 图像专属编辑（圈选重绘/标注/扩图/去水印/导出）只对【产物】图节点开放：视频节点走画布视频分支；
  // 参考图（role=reference）是生成前的视觉输入、无版本序号，不开放编辑工具栏（审计 HIGH#1）。
  const selectedImageNode =
    selectedNode && isImageNode(selectedNode) && !isReferenceNode(selectedNode) ? selectedNode : null;
  const compareNodes =
    selectedIds.length === 2
      ? selectedIds
          .map((id) => visibleNodes.find((n) => n.id === id))
          .filter((n): n is CanvasImageNode => n !== undefined && isImageNode(n))
      : [];

  const persistCanvasDoc = useCallback((): void => {
    const state = useDesignCanvasStore.getState();
    if (state.runDir) void saveCanvasDoc(state.runDir, state.toDoc());
  }, []);

  const deleteCanvasNodes = useCallback((ids: readonly string[]): void => {
    const existingIds = new Set(useDesignCanvasStore.getState().nodes.map((node) => node.id));
    const targetIds = ids.filter((id) => existingIds.has(id));
    if (targetIds.length === 0) return;
    deleteNodes(targetIds);
    if (targetIds.some((id) => id === diffNode?.id)) setDiffNode(null);
    if (targetIds.some((id) => id === playingVideo?.id)) setPlayingVideo(null);
    if (targetIds.some((id) => selectedIds.includes(id))) setComparing(false);
    persistCanvasDoc();
  }, [deleteNodes, diffNode?.id, persistCanvasDoc, playingVideo?.id, selectedIds]);

  const renameCanvasNode = useCallback((id: string, label: string): void => {
    renameNode(id, label);
    persistCanvasDoc();
  }, [persistCanvasDoc, renameNode]);

  const setCanvasChosen = useCallback((id: string): void => {
    setChosen(id);
    persistCanvasDoc();
  }, [persistCanvasDoc, setChosen]);

  const discardCanvasNode = useCallback((id: string): void => {
    discardNode(id);
    persistCanvasDoc();
  }, [discardNode, persistCanvasDoc]);

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

  // fit-to-view：节点新增（含空→非空、出图回灌）时自动把内容居中并缩放到适配视口，留 padding。
  // 仅在「可见节点数增加」时 fit 一次——不在每次 setCamera 时跑，避免打断用户手动平移/缩放。
  const prevNodeCountRef = useRef(0);
  useEffect(() => {
    const count = visibleNodes.length;
    const grew = count > prevNodeCountRef.current;
    prevNodeCountRef.current = count;
    if (!grew || size.w <= 0 || size.h <= 0) return;
    const fit = computeFitCamera(visibleNodes, size.w, size.h);
    if (fit) setCamera(fit);
    // 只想在节点集 / 视口变化时评估，setCamera 稳定
  }, [visibleNodes, size.w, size.h]);

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

  // 撤销/重做快捷键（Cmd/Ctrl+Z、+Shift+Z）。路由判定见 canvasUndoKeybinding（纯函数+测试覆盖）：
  // 输入框/IME 内让出原生 undo（MED-4）；比较浮层显示时不劫持（MED-2）；标注模式不做画布 undo
  // （HIGH-2，标注笔画级撤销延后）。挂组件内 window listener，切走设计画布自动卸载。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const handled = dispatchCanvasUndoKey(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing,
          targetTag: (e.target as HTMLElement | null)?.tagName,
          targetEditable: (e.target as HTMLElement | null)?.isContentEditable ?? false,
        },
        { annotMode, comparing },
        {
          // undo/redo 后落盘：图解对象每次改都写 canvas.json，撤销也须同步磁盘，
          // 否则内存回滚但磁盘还在，reload 复活（修 skeptic LOW-2）。
          undo: () => {
            useDesignCanvasStore.getState().undoEdit();
            persistCanvasDoc();
          },
          redo: () => {
            useDesignCanvasStore.getState().redoEdit();
            persistCanvasDoc();
          },
        },
      );
      if (handled) {
        e.preventDefault();
        return;
      }
      const handledDelete = dispatchCanvasDeleteKey(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          isComposing: e.isComposing,
          targetTag: (e.target as HTMLElement | null)?.tagName,
          targetEditable: (e.target as HTMLElement | null)?.isContentEditable ?? false,
        },
        { annotMode, comparing, selectedCount: useDesignCanvasStore.getState().selectedIds.length },
        { deleteSelected: () => deleteCanvasNodes(useDesignCanvasStore.getState().selectedIds) },
      );
      if (handledDelete) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotMode, comparing, deleteCanvasNodes, persistCanvasDoc]);

  // 行业常见手势：空格临时手型工具。输入框内不劫持空格，避免影响指令编辑。
  useEffect(() => {
    const editableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };
    const setSpaceDown = (active: boolean): void => {
      spaceDownRef.current = active;
      setPanModifierActive(active);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || editableTarget(e.target)) return;
      e.preventDefault();
      setSpaceDown(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      setSpaceDown(false);
    };
    const onBlur = (): void => setSpaceDown(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // 图解删除键：选中图解对象（形状/连线）时按 Delete/Backspace 删除。
  // 在输入框/可编辑元素内不劫持（让出原生删除）；正在编辑文字时不响应。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (diagramText) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const editable = (e.target as HTMLElement | null)?.isContentEditable ?? false;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return;
      if (!useDesignCanvasStore.getState().selectedDiagram) return;
      e.preventDefault();
      onDeleteSelectedDiagram();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onDeleteSelectedDiagram 是稳定闭包（无依赖捕获），diagramText 变化时重挂以读最新态。
  }, [diagramText]);

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
    if (classifyWheelIntent(e.evt) === 'zoom') {
      setCamera((current) => zoomFromWheel(current, pointer, e.evt));
    } else {
      setCamera((current) => panFromWheel(current, e.evt));
    }
  };

  // —— 图解层辅助 ——
  const makeId = (): string =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 图解编辑后落盘（复用既有 canvas.json 写盘链路；无 runDir 时仅内存态，与节点编辑落盘模型一致）。
  const persistDiagram = (): void => {
    const rd = useDesignCanvasStore.getState().runDir;
    if (rd) void saveCanvasDoc(rd, useDesignCanvasStore.getState().toDoc());
  };
  const onUpdateShape = (id: string, patch: Partial<CanvasShape>): void => {
    useDesignCanvasStore.getState().updateShape(id, patch);
    persistDiagram();
  };
  const onAddConnector = (fromNodeId: string, toNodeId: string): void => {
    useDesignCanvasStore
      .getState()
      .addConnector({ id: makeId(), fromNodeId, toNodeId, createdAt: Date.now() });
    persistDiagram();
  };
  const onDeleteSelectedDiagram = (): void => {
    const sel = useDesignCanvasStore.getState().selectedDiagram;
    if (!sel) return;
    if (sel.type === 'shape') useDesignCanvasStore.getState().deleteShape(sel.id);
    else useDesignCanvasStore.getState().deleteConnector(sel.id);
    persistDiagram();
  };
  // 文字内联编辑提交：新建 text / 改形状文字 / 改连线 label。
  const commitDiagramText = (): void => {
    if (diagramTextDoneRef.current || !diagramText) return; // 已提交/取消：吃掉卸载触发的二次 blur
    diagramTextDoneRef.current = true;
    const { target, value } = diagramText;
    const text = value.trim();
    const store = useDesignCanvasStore.getState();
    if (target.kind === 'new-text') {
      if (text) {
        store.addShape({
          id: makeId(),
          kind: 'text',
          x: target.world.x,
          y: target.world.y,
          text,
          color: diagramColor,
          createdAt: Date.now(),
        });
      }
    } else if (target.kind === 'shape') {
      store.updateShape(target.id, { text } as Partial<CanvasShape>);
    } else {
      store.updateConnector(target.id, { label: text || undefined });
    }
    setDiagramText(null);
    persistDiagram();
  };

  // 圈选标注：mousedown 起框 → move 更新 → up 落框（仅 annotating 时）。
  // 图解绘制（shape 工具）也走 Stage 处理器（对所有点击触发，能在节点之上起笔）。
  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (isShapeTool) {
      const w = worldFromPointer();
      if (!w) return;
      if (diagramTool === 'text') {
        openDiagramText({ kind: 'new-text', world: w });
        return;
      }
      diagramDrawing.current = true;
      const next = reduceDiagram([], {
        type: 'down',
        tool: diagramTool as ShapeTool,
        x: w.x,
        y: w.y,
        id: makeId(),
        createdAt: Date.now(),
        color: diagramColor,
      });
      setDiagramDraft(next[0] ?? null);
      return;
    }
    if (!annotating && !annotMode) {
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      const intent = classifyPointerDragIntent({
        button: e.evt.button,
        spaceKey: spaceDownRef.current,
      });
      if (pointer && intent === 'pan') {
        e.evt.preventDefault();
        panDragRef.current = pointer;
        return;
      }
    }
    if (!annotating) {
      // 非标注/非绘制模式：点空白处清除选择（节点 + 图解）。
      if (e.target === stageRef.current) {
        setSelected([]);
        setSelectedDiagram(null);
      }
      return;
    }
    const w = worldFromPointer();
    if (!w) return;
    dragStart.current = w;
    setDraft({ x: w.x, y: w.y, width: 0, height: 0 });
  };
  const handleMouseMove = (): void => {
    if (panDragRef.current) {
      const pointer = stageRef.current?.getPointerPosition();
      if (!pointer) return;
      const prev = panDragRef.current;
      panDragRef.current = pointer;
      setCamera((current) => panBy(current, { x: pointer.x - prev.x, y: pointer.y - prev.y }));
      return;
    }
    if (isShapeTool) {
      if (!diagramDrawing.current || !diagramDraft) return;
      const w = worldFromPointer();
      if (!w) return;
      setDiagramDraft(reduceDiagram([diagramDraft], { type: 'move', x: w.x, y: w.y })[0] ?? null);
      return;
    }
    if (!annotating || !dragStart.current) return;
    const w = worldFromPointer();
    if (!w) return;
    setDraft(normalizeDragRect(dragStart.current.x, dragStart.current.y, w.x, w.y));
  };
  const handleMouseUp = (): void => {
    if (panDragRef.current) {
      panDragRef.current = null;
      return;
    }
    if (isShapeTool) {
      if (!diagramDrawing.current || !diagramDraft) return;
      diagramDrawing.current = false;
      const committed = reduceDiagram([diagramDraft], { type: 'up' });
      setDiagramDraft(null);
      if (committed.length > 0) {
        useDesignCanvasStore.getState().addShape(committed[0]);
        persistDiagram();
      }
      return;
    }
    if (!annotating || !draft) {
      dragStart.current = null;
      return;
    }
    if (draft.width > 4 && draft.height > 4) setAnnotations((a) => [...a, draft]);
    setDraft(null);
    dragStart.current = null;
  };

  const focusNode = (id: string): void => {
    const node = useDesignCanvasStore.getState().nodes.find((candidate) => candidate.id === id);
    if (!node || size.w <= 0 || size.h <= 0) return;
    setSelected([id]);
    setCamera((current) => ({
      ...current,
      x: size.w / 2 - (node.x + node.width / 2) * current.scale,
      y: size.h / 2 - (node.y + node.height / 2) * current.scale,
    }));
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
      {/* 生成忙态遮罩（审计 MED-1）：仅在提议「正在落地」（applying）期间拦截 konva 指针事件，禁止
          手动拖拽/绘制——否则提议生成收尾的 clearEditHistory 会连带清掉用户中途手动编辑的 undo。
          审批条 z-30 在其上、自身 busy 已禁用按钮；本遮罩 z-10 只盖 Stage。
          绑 applying 而非 generating&&pending（R3 MED-1）：避免「表单出图中 + agent 后台推来一条 pending」
          时遮罩误弹挡住用户手动流程；只有用户真点了 Apply 进入落地才锁。 */}
      {canvasProposal.applying && (
        <div
          data-testid="canvas-busy-overlay"
          className="absolute inset-0 z-10 cursor-wait"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {size.w > 0 && size.h > 0 && (
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          x={camera.x}
          y={camera.y}
          scaleX={camera.scale}
          scaleY={camera.scale}
          draggable={false}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            panDragRef.current = null;
          }}
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
                  panModifierActive={panModifierActive}
                  onSelect={(additive) => selectNode(node.id, additive)}
                  onPlay={() => setPlayingVideo(node)}
                />
              ) : (
                <CanvasImage
                  key={node.id}
                  node={node}
                  runDir={runDir}
                  selected={selectedIds.includes(node.id)}
                  panModifierActive={panModifierActive}
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
          {/* 图解层（连线 + freeform 形状），始终渲染；绘制走 Stage 处理器，本层管渲染+选中+连接。 */}
          <DiagramLayer
            tool={diagramTool}
            nodes={visibleNodes}
            connectors={connectors}
            shapes={shapes}
            draft={diagramDraft}
            selected={selectedDiagram}
            onUpdateShape={onUpdateShape}
            onAddConnector={onAddConnector}
            onSelect={setSelectedDiagram}
            onRequestText={openDiagramText}
          />
          {annotMode && selectedImageNode && (
            <AnnotationLayer
              shapes={annotShapes}
              onShapesChange={setAnnotShapes}
              tool={annotTool}
              onRequestText={(world) => setTextDraft({ world, value: '' })}
            />
          )}
          {/* ADR-026：agent 待审批提议的 ghost 虚影（蓝色虚线/半透明），点应用才落库。 */}
          {canvasProposal.pending && (
            <Layer listening={false}>
              <CanvasProposalGhostLayer ops={canvasProposal.pending.ops} nodes={nodes} />
            </Layer>
          )}
        </Stage>
      )}

      {/* ADR-026：提议审批条（逐 op 取舍 + 应用/拒绝）。 */}
      {canvasProposal.pending && (
        <CanvasProposalReviewBar
          proposal={canvasProposal.pending}
          onApply={(ops) => void canvasProposal.apply(ops)}
          onReject={(fb) => void canvasProposal.reject(fb)}
        />
      )}

      {/* ADR-027：自主信封审批条（人一次性批预算 → AI 在信封内自主出图）。 */}
      {autonomy.pendingRequest && (
        <CanvasAutonomyReviewBar
          request={autonomy.pendingRequest}
          onGrant={(g, perImageCny) => void autonomy.grant(g, perImageCny)}
          onDecline={(fb) => void autonomy.decline(fb)}
        />
      )}

      {/* ADR-027：自主进行中指示 + 停止（活跃信封时；审批条出现时不重叠）。 */}
      {autonomyEnvelope && !autonomy.pendingRequest && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full border border-amber-300/60 bg-white/95 px-4 py-1.5 text-xs text-neutral-600 shadow-md backdrop-blur dark:border-amber-500/40 dark:bg-neutral-900/95 dark:text-neutral-300">
          <span>
            {t.design.autonomyRunning
              .replace('{used}', String(autonomyEnvelope.usedVariants))
              .replace('{max}', String(autonomyEnvelope.maxVariants))
              .replace('{spent}', formatCny(autonomyEnvelope.spentCny))
              .replace('{cap}', formatCny(autonomyEnvelope.maxCny))}
          </span>
          <button type="button" onClick={() => autonomyClear()} className="rounded-full px-2 py-0.5 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10">
            {t.design.autonomyStop}
          </button>
        </div>
      )}

      {/* ADR-026 三刀：已淘汰节点恢复入口（软删找回）。 */}
      <DiscardedNodesTray />

      {/* 图解工具条（模式/调色板/删除）——消费 surface 只放工具选择，不放配置管理。 */}
      <DiagramToolbar
        tool={diagramTool}
        onToolChange={(tl) => {
          setDiagramTool(tl);
          setSelectedDiagram(null);
        }}
        color={diagramColor}
        onColorChange={setDiagramColor}
        canDelete={selectedDiagram !== null}
        onDelete={onDeleteSelectedDiagram}
      />

      {/* 图解模式提示（connect/绘制时给一句引导）。 */}
      {diagramTool === 'connect' && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-md bg-zinc-900/85 px-2.5 py-1 text-[11px] text-sky-200/90 shadow">
          {t.design.diagramConnectHint}
        </div>
      )}
      {isShapeTool && diagramTool !== 'text' && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-md bg-zinc-900/85 px-2.5 py-1 text-[11px] text-zinc-300 shadow">
          {t.design.diagramDrawHint}
        </div>
      )}

      {/* 图解文字内联编辑（新建 text / 改形状文字 / 改连线 label）。 */}
      {diagramText &&
        (() => {
          const sx = diagramText.target.world.x * camera.scale + camera.x;
          const sy = diagramText.target.world.y * camera.scale + camera.y;
          return (
            <input
              autoFocus
              data-testid="diagram-text-input"
              value={diagramText.value}
              onChange={(e) => setDiagramText({ ...diagramText, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDiagramText();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  diagramTextDoneRef.current = true; // 取消：吃掉卸载触发的 blur 提交
                  setDiagramText(null);
                }
              }}
              onBlur={commitDiagramText}
              placeholder={t.design.diagramTextPlaceholder}
              className="absolute z-10 rounded border border-sky-400/60 bg-zinc-900/95 px-1.5 py-0.5 text-xs text-zinc-100 shadow-lg outline-none placeholder:text-zinc-500"
              style={{ left: sx, top: sy, minWidth: 120 }}
            />
          );
        })()}

      {visibleNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
          <Palette className="h-6 w-6 text-zinc-600" />
          <span>{t.design.canvasEmpty}</span>
        </div>
      )}

      {/* 文字标注输入框（画布内，替代原生 window.prompt；落点处定位，Enter 落定 / Esc 取消）。 */}
      {textDraft &&
        (() => {
          const sx = textDraft.world.x * camera.scale + camera.x;
          const sy = textDraft.world.y * camera.scale + camera.y;
          const commit = (): void => {
            const text = textDraft.value.trim();
            if (text) {
              setAnnotShapes(
                reduceAnnot(annotShapes, {
                  type: 'down',
                  tool: 'text',
                  x: textDraft.world.x,
                  y: textDraft.world.y,
                  text,
                }),
              );
            }
            setTextDraft(null);
          };
          return (
            <input
              autoFocus
              value={textDraft.value}
              onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTextDraft(null);
                }
              }}
              onBlur={commit}
              placeholder={t.design.annotTextPlaceholder}
              // ds-allow:viz 标注输入框用红色描边呼应标注色，绝对定位于画布落点
              className="absolute z-10 rounded border border-red-400/60 bg-zinc-900/95 px-1.5 py-0.5 text-xs text-red-200 shadow-lg outline-none placeholder:text-zinc-500"
              style={{ left: sx, top: sy, minWidth: 120 }}
            />
          );
        })()}

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

      <DesignLayerPanel
        nodes={nodes}
        selectedIds={selectedIds}
        onSelect={(id, additive) => selectNode(id, additive)}
        onRename={renameCanvasNode}
        onSetChosen={setCanvasChosen}
        onDiscard={discardCanvasNode}
        onDelete={(id) => deleteCanvasNodes([id])}
        onFocus={focusNode}
      />

      {/* 选中图后的局部重绘面板（仅图节点；视频节点不显示图像编辑工具） */}
      {selectedImageNode && (
        <DesignImageEditPanel
          t={t}
          generating={generating}
          annotating={annotating}
          setAnnotating={setAnnotating}
          annotationCount={annotations.length}
          onClearAnnotations={() => setAnnotations([])}
          instruction={instruction}
          setInstruction={setInstruction}
          onRepaint={() => void onRepaint()}
          onExportImage={() => void onExport(selectedImageNode)}
          onGenerateVideo={() => void generateVideo({ baseNode: selectedImageNode })}
          onExportPdf={() => void onExportPdf(selectedImageNode)}
          expandDirection={expandDirection}
          expandRatio={expandRatio}
          onExpandDirectionChange={setExpandDirection}
          onExpandRatioChange={setExpandRatio}
          onExpand={() => void onExpand()}
          onRemoveWatermark={() => void onRemoveWatermark()}
          annotMode={annotMode}
          setAnnotMode={setAnnotMode}
          annotTool={annotTool}
          setAnnotTool={setAnnotTool}
          effectiveAnnotModel={effectiveAnnotModel}
          setAnnotModel={setAnnotModel}
          annotInstruction={annotInstruction}
          setAnnotInstruction={setAnnotInstruction}
          annotShapeCount={annotShapes.length}
          onAnnotRedraw={() => void onAnnotRedraw()}
        />
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
