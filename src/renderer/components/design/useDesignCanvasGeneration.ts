// 设计画布出图回灌 hook（Cowart 式 P1：文生图 → 回灌画布节点）。
//
// 直连出图：renderer 经 WORKSPACE/generateDesignImage IPC 直接调通义万相（spec D2 钦定引擎），
// 不经 agent——纯文生图无需 agent 推理，直连更确定。IPC 出图落盘后返回路径，本 hook 读成
// dataURL、量原始尺寸、在现有节点右侧落一个画布节点，并存盘 canvas.json。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { buildImagePrompt } from './designTypes';
import { emptyCanvasDoc, nextNodePlacement, type CanvasImageNode } from './designCanvasTypes';
import { saveCanvasDoc } from './designCanvasPersistence';
import { groupKey } from './variantSpine';
import { resolveDesignDir, readWorkspaceImageAsDataUrl } from './designFiles';
import { buildMaskDataUrl, type Rect } from './designCanvasMask';

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

/**
 * 由出图结果构造新 variant 节点：落底图右侧（make-real 式 x:maxX+gap），parentId 锚到血缘根
 * （groupKey=parentId??id），归入底图所在版本槽。扩图/去水印/局部重绘共用同一血缘规则。
 * id/createdAt 可注入以便测试确定性。
 */
export function buildVariantNode(
  baseNode: CanvasImageNode,
  assetRel: string,
  dims: { width: number; height: number },
  label: string,
  id: string = `node-${Date.now()}`,
  createdAt: number = Date.now(),
): CanvasImageNode {
  return {
    id,
    src: assetRel,
    x: baseNode.x + baseNode.width + DESIGN_WORKSPACE.CANVAS_NODE_GAP,
    y: baseNode.y,
    width: dims.width,
    height: dims.height,
    prompt: label,
    parentId: groupKey(baseNode),
    createdAt,
  };
}

export function useDesignCanvasGeneration(): {
  generate: () => Promise<void>;
  editRegion: (args: EditRegionArgs) => Promise<void>;
  expand: (args: ExpandArgs) => Promise<void>;
  removeWatermark: (args: RemoveWatermarkArgs) => Promise<void>;
} {
  const { t } = useI18n();

  const generate = useCallback(async () => {
    const form = useDesignStore.getState();
    const canvas = useDesignCanvasStore.getState();
    const outputType = form.outputType;
    if (outputType === 'prototype') return; // 由 useDesignGeneration 处理

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
    const prompt = buildImagePrompt({
      requirement: form.requirement,
      outputType,
      designContext: {
        surface: form.surface ?? undefined,
        brandColor: form.brandColor.trim() || undefined,
        tone: form.tone,
      },
    });

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{ path: string }>(
        IPC_DOMAINS.WORKSPACE,
        'generateDesignImage',
        { prompt, aspectRatio: form.aspectRatio, outputPath: assetAbs },
      );
      if (!res?.success) {
        throw new Error(res?.error?.message || t.design.errDispatch);
      }
      // 画布期间未被切到别的 run 才回灌。
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return;
      }
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      const { x, y } = nextNodePlacement(
        useDesignCanvasStore.getState().nodes,
        DESIGN_WORKSPACE.CANVAS_NODE_GAP,
      );
      const node: CanvasImageNode = {
        id: `node-${Date.now()}`,
        src: assetRel,
        x,
        y,
        width,
        height,
        prompt: form.requirement,
        createdAt: Date.now(),
      };
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
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

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{ path: string }>(
        IPC_DOMAINS.WORKSPACE,
        'editDesignImage',
        {
          prompt: instruction,
          baseImagePath: `${runDir}/${baseNode.src}`,
          maskDataUrl,
          outputPath: assetAbs,
        },
      );
      if (!res?.success) {
        throw new Error(res?.error?.message || t.design.errDispatch);
      }
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return;
      }
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      // 新版放在底图右侧（make-real 式 x:maxX+gap）。parentId 锚定到血缘根（groupKey=
      // parentId??id）而非直接底图：编辑「编辑版」时也归入同一版本槽，避免深层血缘碎成多槽
      // 导致「一个槽一个主版」不变量被打破。
      const node: CanvasImageNode = {
        id: `node-${Date.now()}`,
        src: assetRel,
        x: baseNode.x + baseNode.width + DESIGN_WORKSPACE.CANVAS_NODE_GAP,
        y: baseNode.y,
        width,
        height,
        prompt: instruction,
        parentId: groupKey(baseNode),
        createdAt: Date.now(),
      };
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  // 扩图/去水印结果共用落盘：读结果图 → 量尺寸 → 在底图右侧落新 variant 节点（parentId 锚血缘根，
  // 与 editRegion 同槽规则）→ 存盘。扩图结果尺寸大于原图，loadImageDims 量真实尺寸即正确。
  const landResultAsVariant = useCallback(
    async (runDir: string, assetRel: string, assetAbs: string, baseNode: CanvasImageNode, label: string): Promise<void> => {
      if (useDesignCanvasStore.getState().runDir !== runDir) return;
      const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
      if (!dataUrl) throw new Error(t.design.errTimeout);
      const { width, height } = await loadImageDims(dataUrl);
      const node = buildVariantNode(baseNode, assetRel, { width, height }, label);
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
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

      useDesignCanvasStore.getState().setError(null);
      useDesignCanvasStore.getState().setGenerating(true);
      try {
        const res = await window.domainAPI?.invoke<{ path: string }>(
          IPC_DOMAINS.WORKSPACE,
          'expandDesignImage',
          { baseImagePath: `${runDir}/${baseNode.src}`, outputPath: assetAbs, direction, ratio, prompt },
        );
        if (!res?.success) {
          throw new Error(res?.error?.message || t.design.errDispatch);
        }
        await landResultAsVariant(runDir, assetRel, assetAbs, baseNode, t.design.expandBtn);
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

      useDesignCanvasStore.getState().setError(null);
      useDesignCanvasStore.getState().setGenerating(true);
      try {
        const res = await window.domainAPI?.invoke<{ path: string }>(
          IPC_DOMAINS.WORKSPACE,
          'removeWatermarkDesignImage',
          { baseImagePath: `${runDir}/${baseNode.src}`, outputPath: assetAbs },
        );
        if (!res?.success) {
          throw new Error(res?.error?.message || t.design.errDispatch);
        }
        await landResultAsVariant(runDir, assetRel, assetAbs, baseNode, t.design.removeWatermarkBtn);
        useDesignCanvasStore.getState().setGenerating(false);
      } catch (e) {
        useDesignCanvasStore.getState().setGenerating(false);
        useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      }
    },
    [t, landResultAsVariant],
  );

  return { generate, editRegion, expand, removeWatermark };
}
