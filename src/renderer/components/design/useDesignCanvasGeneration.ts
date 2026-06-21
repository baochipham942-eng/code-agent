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

export function useDesignCanvasGeneration(): {
  generate: () => Promise<void>;
  editRegion: (args: EditRegionArgs) => Promise<void>;
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
      const res = await window.domainAPI?.invoke<{ path: string; consistency?: RegionLockReport }>(
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
      // 一致性报告挂到节点（随 canvas.json 落 T1 spine）。main 返回绝对 diffPath，
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
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  return { generate, editRegion };
}
