// 设计画布出图回灌 hook（Cowart 式 P1：文生图 → 回灌画布节点）。
//
// 直连出图：renderer 经 WORKSPACE/generateDesignImage IPC 直接调通义万相（spec D2 钦定引擎），
// 不经 agent——纯文生图无需 agent 推理，直连更确定。IPC 出图落盘后返回路径，本 hook 读成
// dataURL、量原始尺寸、在现有节点右侧落一个画布节点，并存盘 canvas.json。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE, REGION_LOCK } from '@shared/constants';
import type { RegionLockReport } from '@shared/contract/imageConsistency';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { buildImagePrompt } from './designTypes';
import {
  emptyCanvasDoc,
  isImageNode,
  isVideoNode,
  isReferenceNode,
  type CanvasImageNode,
  type CanvasNode,
  type CanvasVideoNode,
} from './designCanvasTypes';
import type { DesignVideoMode } from './designTypes';
import { saveCanvasDoc } from './designCanvasPersistence';
import { groupKey } from './variantSpine';
import {
  videoModelById,
  videoModelsWithCap,
  clampVideoDuration,
} from '@shared/constants/visualModels';
import { estimateVideoCostCny } from '@shared/media/videoCost';
import { formatCny } from '@shared/media/imageCost';
import { resolveDesignDir, readWorkspaceImageAsDataUrl } from './designFiles';
import { buildMaskDataUrl, type Rect } from './designCanvasMask';
import { composeAnnotOps, exportAnnotatedPng } from './annotComposite';
import type { AnnotShape } from './AnnotationLayer';
import { placeCanvasNode, placeVariantNode, type CanvasPlacementOperation } from './canvasPlacement';
import {
  buildDesignSelectionContext,
  firstSelectedImageNode,
} from './designSelectionContext';

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath });
  } catch {
    // 出图 IPC 也会建父目录，这里失败不致命。
  }
}

/** 把 dataURL 加载进 Image 量原始像素尺寸；失败回退兜底正方形。 */
export function loadImageDims(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    const fallback = {
      width: DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE,
      height: DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE,
    };
    img.onload = () =>
      resolve({ width: img.naturalWidth || fallback.width, height: img.naturalHeight || fallback.height });
    img.onerror = () => resolve(fallback);
    img.src = dataUrl;
  });
}

export interface EditRegionArgs {
  /** 被编辑的底图节点。 */
  baseNode: CanvasImageNode;
  /** 编辑区（图内局部像素坐标，白=改）。 */
  regions: Rect[];
  /** 局部重绘指令（描述这块要变成什么）。 */
  instruction: string;
}

/** 扩图方向：单向(上/下/左/右) 或 四周(all)。与 main 侧 imageGenerationService 同义。 */
export type ExpandDirection = 'up' | 'down' | 'left' | 'right' | 'all';

export interface ExpandArgs {
  /** 被扩图的底图节点。 */
  baseNode: CanvasImageNode;
  /** 扩展方向。 */
  direction: ExpandDirection;
  /** 扩展比例（1.0–2.0，单边外扩倍数）。 */
  ratio: number;
  /** 可选补绘描述（缺省走 main 侧默认 prompt）。 */
  prompt?: string;
}

export interface RemoveWatermarkArgs {
  /** 被去水印的底图节点。 */
  baseNode: CanvasImageNode;
}

export interface EditByAnnotationArgs {
  /** 被标注重绘的底图节点。 */
  baseNode: CanvasImageNode;
  /** 标注图形（世界坐标，与画布相机一致；hook 内偏移到图内局部坐标再换算到原图像素）。 */
  shapes: AnnotShape[];
  /** 重绘指令（描述按标注要改成什么）。 */
  instruction: string;
  /** 出图模型 id（须声明 annotEdit 能力，main 侧 cap 守门复核）。 */
  model: string;
}

/** 把世界坐标标注偏移到底图局部坐标（减去节点左上角），供 composeAnnotOps 换算原图像素。 */
function shapesToNodeLocal(shapes: AnnotShape[], node: CanvasImageNode): AnnotShape[] {
  const dx = node.x;
  const dy = node.y;
  return shapes.map((shape) => {
    switch (shape.kind) {
      case 'pen':
        return { ...shape, points: shape.points.map((v, i) => (i % 2 === 0 ? v - dx : v - dy)) };
      case 'arrow':
        return {
          ...shape,
          points: [
            shape.points[0] - dx,
            shape.points[1] - dy,
            shape.points[2] - dx,
            shape.points[3] - dy,
          ] as [number, number, number, number],
        };
      case 'rect':
        return { ...shape, x: shape.x - dx, y: shape.y - dy };
      case 'text':
        return { ...shape, x: shape.x - dx, y: shape.y - dy };
      default:
        return shape;
    }
  });
}

// 单调序列：保证同毫秒内连续构造的节点 id 不碰撞（audit M4：纯 Date.now() 同 tick 会撞，
// store 按 id 做 setChosen/discard/对比会指向歧义节点）。generate/editRegion/buildVariantNode
// 三处节点构造共用本源（audit R2 对称应用）。
let variantNodeSeq = 0;

/** 防同毫秒碰撞的画布节点 id（Date.now() 前缀跨会话唯一 + 单调序列后缀同 tick 唯一）。 */
export function nextVariantNodeId(): string {
  return `node-${Date.now()}-${(variantNodeSeq++).toString(36)}`;
}

/**
 * 由出图结果构造新 variant 节点：落底图右侧（make-real 式 x:maxX+gap），parentId 锚到血缘根
 * （groupKey=parentId??id），归入底图所在版本槽。扩图/去水印/局部重绘共用同一血缘规则。
 * id/createdAt 可注入以便测试确定性；缺省 id 带单调序列后缀防同毫秒碰撞。
 */
export function buildVariantNode(
  baseNode: CanvasImageNode,
  assetRel: string,
  dims: { width: number; height: number },
  label: string,
  id: string = nextVariantNodeId(),
  createdAt: number = Date.now(),
  options: { existingNodes?: readonly CanvasNode[]; operation?: CanvasPlacementOperation } = {},
): CanvasImageNode {
  const { x, y } = placeVariantNode(
    baseNode,
    options.existingNodes ?? [baseNode],
    dims,
    options.operation ?? 'variant',
  );
  return {
    id,
    src: assetRel,
    x,
    y,
    width: dims.width,
    height: dims.height,
    prompt: label,
    parentId: groupKey(baseNode),
    createdAt,
  };
}

export function useDesignCanvasGeneration(): {
  generate: () => Promise<void>;
  generateVideo: (args?: { baseNode?: CanvasNode }) => Promise<void>;
  editRegion: (args: EditRegionArgs) => Promise<void>;
  expand: (args: ExpandArgs) => Promise<void>;
  removeWatermark: (args: RemoveWatermarkArgs) => Promise<void>;
  editByAnnotation: (args: EditByAnnotationArgs) => Promise<void>;
} {
  const { t } = useI18n();

  const generate = useCallback(async () => {
    const form = useDesignStore.getState();
    const canvas = useDesignCanvasStore.getState();
    const outputType = form.outputType;
    if (outputType === 'prototype') return; // 由 useDesignGeneration 处理
    if (outputType === 'video') return; // 视频走 generateVideo，非文生图
    if (outputType === 'slides') return; // 演示稿走厚版独立链路（二期），非文生图

    if (!form.requirement.trim()) {
      useDesignCanvasStore.getState().setError(t.design.errNoRequirement);
      return;
    }

    // 复用当前画布 run；无则新建一个（同一画布持续铺多张方案）。
    let runDir = canvas.runDir;
    if (!runDir) {
      const baseDir = await resolveDesignDir();
      if (!baseDir) {
        useDesignCanvasStore.getState().setError(t.design.errResolveDir);
        return;
      }
      runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
      await ensureDir(runDir);
      useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
    }

    const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/gen-${Date.now()}.png`;
    const assetAbs = `${runDir}/${assetRel}`;
    const selectionCanvas = useDesignCanvasStore.getState();
    const selectionContext = buildDesignSelectionContext(selectionCanvas.nodes, selectionCanvas.selectedIds);
    const prompt = buildImagePrompt({
      requirement: form.requirement,
      outputType,
      designContext: {
        surface: form.surface ?? undefined,
        brandColor: form.brandColor.trim() || undefined,
        tone: form.tone,
      },
      selectionContext,
    });

    // 参考图垫图：优先取当前选中的图片；没有选中图时，再取画布上第一张参考图。
    // 万相当前单图输入，多张选中时取第一张，与 selectionContext 的 primary 一致。
    const refNode = firstSelectedImageNode(selectionCanvas.nodes, selectionContext) ?? selectionCanvas.nodes.find(isReferenceNode);
    let referenceImageDataUrl: string | undefined;
    if (refNode) {
      referenceImageDataUrl = (await readWorkspaceImageAsDataUrl(`${runDir}/${refNode.src}`)) ?? undefined;
      // 参考图读失败时显式报错、不静默退化成纯文生图（否则用户以为用了参考图，审计 HIGH#2）。
      if (!referenceImageDataUrl) {
        useDesignCanvasStore.getState().setError(t.design.errReferenceRead);
        return;
      }
    }

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number }>(
        IPC_DOMAINS.WORKSPACE,
        'generateDesignImage',
        {
          prompt,
          aspectRatio: form.aspectRatio,
          model: form.imageModel,
          outputPath: assetAbs,
          referenceImageDataUrl,
          selectionContext,
        },
      );
      if (!res?.success) {
        throw new Error(res?.error?.message || t.design.errDispatch);
      }
      const costCny = res.data?.costCny;
      // 画布期间未被切到别的 run 才回灌。
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return;
      }
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      const latestCanvas = useDesignCanvasStore.getState();
      const { x, y } = placeCanvasNode({
        nodes: latestCanvas.nodes,
        size: { width, height },
        camera: latestCanvas.camera,
        operation: 'root',
      });
      const node: CanvasImageNode = {
        id: nextVariantNodeId(),
        src: assetRel,
        x,
        y,
        width,
        height,
        prompt: form.requirement,
        createdAt: Date.now(),
        ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}),
      };
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      // 生成成功提交后清 Layer1 编辑栈（codex HIGH-3 时机）：整数组快照不能跨生成边界，
      // 否则跨界 undo 会还原到不含新节点的旧数组=静默删掉刚生成的图。失败/取消路径不清。
      useDesignCanvasStore.getState().clearEditHistory();
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  const editRegion = useCallback(async (args: EditRegionArgs) => {
    const { baseNode, regions, instruction } = args;
    const runDir = useDesignCanvasStore.getState().runDir;
    if (!runDir) return;
    if (!instruction.trim()) {
      useDesignCanvasStore.getState().setError(t.design.errNoRequirement);
      return;
    }
    if (regions.length === 0) {
      useDesignCanvasStore.getState().setError(t.design.errNoAnnotation);
      return;
    }

    const maskDataUrl = buildMaskDataUrl(baseNode.width, baseNode.height, regions);
    const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/edit-${Date.now()}.png`;
    const assetAbs = `${runDir}/${assetRel}`;
    const selectionCanvas = useDesignCanvasStore.getState();
    const selectedIds = selectionCanvas.selectedIds.includes(baseNode.id) ? selectionCanvas.selectedIds : [baseNode.id];
    const selectionContext = buildDesignSelectionContext(selectionCanvas.nodes, selectedIds);

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{
        path: string;
        actualModel: string;
        costCny: number;
        consistency?: RegionLockReport;
      }>(
        IPC_DOMAINS.WORKSPACE,
        'editDesignImage',
        {
          prompt: instruction,
          baseImagePath: `${runDir}/${baseNode.src}`,
          maskDataUrl,
          outputPath: assetAbs,
          selectionContext,
        },
      );
      if (!res?.success) {
        throw new Error(res?.error?.message || t.design.errDispatch);
      }
      const costCny = res.data?.costCny;
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return;
      }
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      // 与扩图/去水印同构：复用 buildVariantNode 落底图右侧 + parentId 锚血缘根（audit R2 对称应用，
      // 顺带继承防碰撞 id；编辑「编辑版」也归同一版本槽，避免深层血缘碎成多槽破坏「一槽一主版」）。
      const node = buildVariantNode(baseNode, assetRel, { width, height }, instruction, undefined, undefined, {
        existingNodes: useDesignCanvasStore.getState().nodes,
        operation: 'variant',
      });
      // T2 BYOK 成本可见：把本次局部重绘实际花费挂到该 variant 节点。
      if (typeof costCny === 'number' && costCny >= 0) node.costCny = costCny;
      // T4 一致性报告挂到节点（随 canvas.json 落 T1 spine）。main 返回绝对 diffPath，
      // 这里相对化 main 的真实路径（与 src 同构、存档可移植，且不臆测 main 的文件名）；
      // clean 无 diff 文件。仅当无法从 main 路径推出相对路径时才退回约定命名兜底。
      const consistency = res.data?.consistency;
      if (consistency) {
        let diffPath: string | undefined;
        if (consistency.status === 'locked') {
          const prefix = `${runDir.replace(/\/+$/, '')}/`;
          diffPath = consistency.diffPath?.startsWith(prefix)
            ? consistency.diffPath.slice(prefix.length)
            : `${assetRel}${REGION_LOCK.DIFF_SUFFIX}`;
        }
        node.consistency = { ...consistency, diffPath };
      }
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().clearEditHistory(); // 成功提交后清 Layer1 编辑栈（同 generate）
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  // 扩图/去水印结果共用落盘：读结果图 → 量尺寸 → 在底图右侧落新 variant 节点（parentId 锚血缘根，
  // 与 editRegion 同槽规则）→ 存盘。扩图结果尺寸大于原图，loadImageDims 量真实尺寸即正确。
  const landResultAsVariant = useCallback(
    async (
      runDir: string,
      assetRel: string,
      assetAbs: string,
      baseNode: CanvasImageNode,
      label: string,
      operation: CanvasPlacementOperation = 'variant',
      costCny?: number,
    ): Promise<void> => {
      if (useDesignCanvasStore.getState().runDir !== runDir) return;
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      const node = buildVariantNode(baseNode, assetRel, { width, height }, label, undefined, undefined, {
        existingNodes: useDesignCanvasStore.getState().nodes,
        operation,
      });
      // 成本透明：扩图/去水印是付费调用，把实际花费挂节点（与 editRegion/generate 对称，进成本面板）。
      if (typeof costCny === 'number' && costCny >= 0) node.costCny = costCny;
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().clearEditHistory(); // 扩图/去水印成功提交后清 Layer1 编辑栈
    },
    [t],
  );

  const expand = useCallback(
    async (args: ExpandArgs) => {
      const { baseNode, direction, ratio, prompt } = args;
      const runDir = useDesignCanvasStore.getState().runDir;
      if (!runDir) return;
      const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/expand-${Date.now()}.png`;
      const assetAbs = `${runDir}/${assetRel}`;
      const selectionCanvas = useDesignCanvasStore.getState();
      const selectionContext = buildDesignSelectionContext(
        selectionCanvas.nodes,
        selectionCanvas.selectedIds.includes(baseNode.id) ? selectionCanvas.selectedIds : [baseNode.id],
      );

      useDesignCanvasStore.getState().setError(null);
      useDesignCanvasStore.getState().setGenerating(true);
      try {
        const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number }>(
          IPC_DOMAINS.WORKSPACE,
          'expandDesignImage',
          { baseImagePath: `${runDir}/${baseNode.src}`, outputPath: assetAbs, direction, ratio, prompt, selectionContext },
        );
        if (!res?.success) {
          throw new Error(res?.error?.message || t.design.errDispatch);
        }
        await landResultAsVariant(runDir, assetRel, assetAbs, baseNode, t.design.expandBtn, 'expand', res.data?.costCny);
        useDesignCanvasStore.getState().setGenerating(false);
      } catch (e) {
        useDesignCanvasStore.getState().setGenerating(false);
        useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      }
    },
    [t, landResultAsVariant],
  );

  const removeWatermark = useCallback(
    async (args: RemoveWatermarkArgs) => {
      const { baseNode } = args;
      const runDir = useDesignCanvasStore.getState().runDir;
      if (!runDir) return;
      const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/dewm-${Date.now()}.png`;
      const assetAbs = `${runDir}/${assetRel}`;
      const selectionCanvas = useDesignCanvasStore.getState();
      const selectionContext = buildDesignSelectionContext(
        selectionCanvas.nodes,
        selectionCanvas.selectedIds.includes(baseNode.id) ? selectionCanvas.selectedIds : [baseNode.id],
      );

      useDesignCanvasStore.getState().setError(null);
      useDesignCanvasStore.getState().setGenerating(true);
      try {
        const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number }>(
          IPC_DOMAINS.WORKSPACE,
          'removeWatermarkDesignImage',
          { baseImagePath: `${runDir}/${baseNode.src}`, outputPath: assetAbs, selectionContext },
        );
        if (!res?.success) {
          throw new Error(res?.error?.message || t.design.errDispatch);
        }
        await landResultAsVariant(runDir, assetRel, assetAbs, baseNode, t.design.removeWatermarkBtn, 'removeWatermark', res.data?.costCny);
        useDesignCanvasStore.getState().setGenerating(false);
      } catch (e) {
        useDesignCanvasStore.getState().setGenerating(false);
        useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      }
    },
    [t, landResultAsVariant],
  );

  // 标注重绘（Cowart 式 B4）：把世界坐标标注偏移到图内局部 → 按 原图/显示 比例换算到原图像素
  // → 烘焙成「底图+红色标注」PNG → 走 editImageByAnnotation IPC（main 侧 cap 守门 + 路径守卫）→
  // 结果落新 variant 挂 spine（parentId 锚血缘根，与 editRegion 同槽规则）。
  const editByAnnotation = useCallback(
    async (args: EditByAnnotationArgs) => {
      const { baseNode, shapes, instruction, model } = args;
      const runDir = useDesignCanvasStore.getState().runDir;
      if (!runDir) return;
      if (!instruction.trim()) {
        useDesignCanvasStore.getState().setError(t.design.errNoInstruction);
        return;
      }
      if (shapes.length === 0) {
        useDesignCanvasStore.getState().setError(t.design.errNoAnnotation);
        return;
      }

      // 读底图为 dataURL + 量原图自然像素（显示尺寸取节点 width/height；画布世界坐标 1:1 对应图像素，
      // composeAnnotOps 仍按 自然/显示 比例换算以兜住 node 尺寸与原图像素不一致的情形）。
      const sourceDataUrl = await readWorkspaceImageAsDataUrl(`${runDir}/${baseNode.src}`);
      if (!sourceDataUrl) {
        useDesignCanvasStore.getState().setError(t.design.errTimeout);
        return;
      }
      const { width: naturalW, height: naturalH } = await loadImageDims(sourceDataUrl);
      const scaled = composeAnnotOps({
        naturalW,
        naturalH,
        displayW: baseNode.width,
        displayH: baseNode.height,
        shapes: shapesToNodeLocal(shapes, baseNode),
      });
      const annotatedImageDataUrl = await exportAnnotatedPng(sourceDataUrl, scaled, naturalW, naturalH);

      const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/annot-${Date.now()}.png`;
      const assetAbs = `${runDir}/${assetRel}`;
      const selectionCanvas = useDesignCanvasStore.getState();
      const selectionContext = buildDesignSelectionContext(
        selectionCanvas.nodes,
        selectionCanvas.selectedIds.includes(baseNode.id) ? selectionCanvas.selectedIds : [baseNode.id],
      );

      useDesignCanvasStore.getState().setError(null);
      useDesignCanvasStore.getState().setGenerating(true);
      try {
        const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number }>(
          IPC_DOMAINS.WORKSPACE,
          'editImageByAnnotation',
          { model, annotatedImageDataUrl, instruction, outputPath: assetAbs, selectionContext },
        );
        if (!res?.success) {
          throw new Error(res?.error?.message || t.design.errDispatch);
        }
        const costCny = res.data?.costCny;
        if (useDesignCanvasStore.getState().runDir !== runDir) {
          useDesignCanvasStore.getState().setGenerating(false);
          return;
        }
        const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
        if (!dataUrl) throw new Error(t.design.errTimeout);
        const { width, height } = await loadImageDims(dataUrl);
        const node = buildVariantNode(baseNode, assetRel, { width, height }, instruction, undefined, undefined, {
          existingNodes: useDesignCanvasStore.getState().nodes,
          operation: 'annotation',
        });
        if (typeof costCny === 'number' && costCny >= 0) node.costCny = costCny;
        useDesignCanvasStore.getState().addNode(node);
        await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
        useDesignCanvasStore.getState().clearEditHistory(); // 标注重绘成功提交后清 Layer1 编辑栈
        useDesignCanvasStore.getState().setGenerating(false);
      } catch (e) {
        useDesignCanvasStore.getState().setGenerating(false);
        useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      }
    },
    [t],
  );

  // P2 视频生成（t2v/i2v）。有 baseNode（画布选图→生成视频）强制 i2v 用其作底图；
  // 否则用 composer 选的 videoMode。付费前 confirm 显示预估 ¥（视频按秒，比图贵一量级）。
  const generateVideo = useCallback(async (args?: { baseNode?: CanvasNode }) => {
    const form = useDesignStore.getState();
    const initialCanvas = useDesignCanvasStore.getState();
    const selectionContext = buildDesignSelectionContext(initialCanvas.nodes, initialCanvas.selectedIds);
    const selectedImageNode = firstSelectedImageNode(initialCanvas.nodes, selectionContext);
    const baseNode = args?.baseNode ?? (form.videoMode === 'i2v' ? selectedImageNode : undefined);
    const mode: DesignVideoMode = baseNode ? 'i2v' : form.videoMode;

    // 选模型：优先 composer 选中的，cap 不匹配则回退该模式下首个可用模型。
    let model = videoModelById(form.videoModel);
    if (!model?.caps.includes(mode)) model = videoModelsWithCap(mode)[0];
    if (!model) {
      useDesignCanvasStore.getState().setError(t.design.errDispatch);
      return;
    }

    // i2v 必须有图底；t2v 必须有需求描述（付费前拦）。
    if (mode === 'i2v' && (!baseNode || !isImageNode(baseNode) || isVideoNode(baseNode))) {
      useDesignCanvasStore.getState().setError(t.design.errNoBaseImageForI2v);
      return;
    }
    if (mode === 't2v' && !form.requirement.trim()) {
      useDesignCanvasStore.getState().setError(t.design.errNoRequirement);
      return;
    }

    // 复用当前画布 run；无则新建（视频与图共用同一画布）。
    let runDir = useDesignCanvasStore.getState().runDir;
    if (!runDir) {
      const baseDir = await resolveDesignDir();
      if (!baseDir) {
        useDesignCanvasStore.getState().setError(t.design.errResolveDir);
        return;
      }
      runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
      await ensureDir(runDir);
      useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
    }

    // 成本闸（T2）：视频按秒计费贵，付费前 confirm 显示预估 ¥ + 时长。
    const durationSec = clampVideoDuration(model, form.videoDurationSec);
    const estCny = estimateVideoCostCny(model.id, durationSec);
    if (!window.confirm(`${t.design.videoCostConfirm}（${formatCny(estCny)} / ${durationSec}s）`)) return;

    const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/vid-${Date.now()}.mp4`;
    const assetAbs = `${runDir}/${assetRel}`;

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{
        path: string;
        actualModel: string;
        costCny: number;
        durationSec: number;
      }>(IPC_DOMAINS.WORKSPACE, 'generateDesignVideo', {
        mode,
        model: model.id,
        prompt: form.requirement.trim() || undefined,
        baseImagePath: mode === 'i2v' && baseNode ? `${runDir}/${baseNode.src}` : undefined,
        outputPath: assetAbs,
        durationSec,
        selectionContext,
      });
      if (!res?.success) throw new Error(res?.error?.message || t.design.errDispatch);
      // 画布期间未被切到别的 run 才回灌。
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return;
      }
      const videoSize = {
        width: DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE,
        height: Math.round((DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE * 9) / 16),
      };
      const latestCanvas = useDesignCanvasStore.getState();
      const { x, y } = placeCanvasNode({
        nodes: latestCanvas.nodes,
        baseNode: mode === 'i2v' ? baseNode : undefined,
        size: videoSize,
        operation: 'video',
      });
      const costCny = res.data?.costCny;
      const node: CanvasVideoNode = {
        id: nextVariantNodeId(),
        kind: 'video',
        src: assetRel,
        x,
        y,
        // 视频缩略 MVP 用 16:9 占位宽高；真实分辨率后续可读。
        width: videoSize.width,
        height: videoSize.height,
        durationSec: res.data?.durationSec ?? durationSec,
        prompt: form.requirement.trim() || undefined,
        parentId: mode === 'i2v' && baseNode ? groupKey(baseNode) : undefined,
        createdAt: Date.now(),
        ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}),
      };
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().clearEditHistory(); // 视频生成成功提交后清 Layer1 编辑栈
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  return { generate, generateVideo, editRegion, expand, removeWatermark, editByAnnotation };
}
