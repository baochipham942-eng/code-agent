// 2b：把一次「出视频」请求落到画布视频节点。与表单态 generateVideo 共用同一出图原语
// （generateDesignVideo IPC + addNode + save），抽成无 React 依赖的纯过程（全经 store getState），
// 供表单 hook 与 agent 路径（useCanvasVideoRequest 订阅 ProposeVideoOps 的 CANVAS_VIDEO_ASK）共用。
// 不含成本确认 / 模型解析（调用方负责）：表单走 window.confirm，agent 走会话区成本卡。
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import {
  emptyCanvasDoc,
  nextNodePlacement,
  type CanvasNode,
  type CanvasVideoNode,
} from './designCanvasTypes';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import { groupKey } from './variantSpine';
import { resolveDesignDir, readWorkspaceBinaryAsBlobUrl } from './designFiles';
import { nextVariantNodeId } from './useDesignCanvasGeneration';

/**
 * 抽视频首帧当封面（JPEG data URL，缩到 maxWidth）。失败返回 null（封面是增强，不阻塞落节点）。
 * 依赖 CSP media-src 允许 blob:（已在 index.html 放开）。blob 同源 → canvas 不被污染，toDataURL 可用。
 */
async function captureVideoFirstFrame(videoBlobUrl: string, maxWidth = 480): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: string | null): void => {
      if (!done) {
        done = true;
        resolve(val);
      }
    };
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.src = videoBlobUrl;
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
      } catch {
        finish(null);
      }
    };
    v.onseeked = () => {
      try {
        const scale = v.videoWidth > maxWidth ? maxWidth / v.videoWidth : 1;
        const w = Math.max(1, Math.round(v.videoWidth * scale));
        const h = Math.max(1, Math.round(v.videoHeight * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.72));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
  });
}

export interface GenerateVideoToCanvasParams {
  mode: 't2v' | 'i2v';
  /** 已解析为合法视频模型 id（调用方用注册表解析+回退）。 */
  modelId: string;
  /** 已 clamp 到模型区间的时长（秒）。 */
  durationSec: number;
  prompt?: string;
  /** i2v 底图节点。 */
  baseNode?: CanvasNode;
}

export interface GenerateVideoToCanvasResult {
  ok: boolean;
  costCny?: number;
  durationSec?: number;
  actualModel?: string;
  nodeId?: string;
  error?: string;
}

/**
 * 出视频 + 落画布节点。复用当前画布 run（无则新建）。setGenerating 驱动画布忙态遮罩。
 * 任何失败（无目录 / IPC 报错 / 中途切 run）一律返回 { ok:false, error }，不抛、不污染画布。
 */
export async function generateVideoToCanvas(
  params: GenerateVideoToCanvasParams,
): Promise<GenerateVideoToCanvasResult> {
  const { mode, modelId, durationSec, prompt, baseNode } = params;
  try {
    let runDir = useDesignCanvasStore.getState().runDir;
    if (!runDir) {
      const baseDir = await resolveDesignDir();
      if (!baseDir) return { ok: false, error: '无法解析设计目录' };
      runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
      try {
        await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath: runDir });
      } catch {
        /* 出图 IPC 也会建父目录，这里失败不致命 */
      }
      useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
    }

    const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/vid-${Date.now()}.mp4`;
    const assetAbs = `${runDir}/${assetRel}`;

    useDesignCanvasStore.getState().setGenerating(true);
    try {
      const res = await window.domainAPI?.invoke<{
        path: string;
        actualModel: string;
        costCny: number;
        durationSec: number;
      }>(IPC_DOMAINS.WORKSPACE, 'generateDesignVideo', {
        mode,
        model: modelId,
        prompt: prompt || undefined,
        baseImagePath: mode === 'i2v' && baseNode ? `${runDir}/${baseNode.src}` : undefined,
        outputPath: assetAbs,
        durationSec,
      });
      if (!res?.success) {
        useDesignCanvasStore.getState().setGenerating(false);
        return { ok: false, error: res?.error?.message || '出视频失败' };
      }
      // 画布期间被切到别的 run 则丢弃回灌（与表单态一致）。
      if (useDesignCanvasStore.getState().runDir !== runDir) {
        useDesignCanvasStore.getState().setGenerating(false);
        return { ok: false, error: '画布已切换，已放弃落地' };
      }

      // 抽首帧当封面（增强，失败不阻塞）：blob URL 喂 <video> → canvas → JPEG data URL，
      // 存进 node.poster（useNodeImage 直接渲染 data:），否则画布上是黑底不明显。
      let poster: string | undefined;
      try {
        const blobUrl = await readWorkspaceBinaryAsBlobUrl(`${runDir}/${assetRel}`);
        if (blobUrl) {
          poster = (await captureVideoFirstFrame(blobUrl)) ?? undefined;
          URL.revokeObjectURL(blobUrl);
        }
      } catch {
        /* 封面是增强，抽帧失败就回退黑底 */
      }

      const { x, y } = nextNodePlacement(
        useDesignCanvasStore.getState().nodes,
        DESIGN_WORKSPACE.CANVAS_NODE_GAP,
      );
      const costCny = res.data?.costCny;
      const actualDuration = res.data?.durationSec ?? durationSec;
      const node: CanvasVideoNode = {
        id: nextVariantNodeId(),
        kind: 'video',
        src: assetRel,
        x,
        y,
        width: DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE,
        height: Math.round((DESIGN_WORKSPACE.CANVAS_NODE_FALLBACK_SIZE * 9) / 16),
        durationSec: actualDuration,
        prompt: prompt || undefined,
        parentId: mode === 'i2v' && baseNode ? groupKey(baseNode) : undefined,
        createdAt: Date.now(),
        ...(poster ? { poster } : {}),
        ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}),
      };
      useDesignCanvasStore.getState().addNode(node);
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().clearEditHistory();
      useDesignCanvasStore.getState().setGenerating(false);
      return {
        ok: true,
        costCny: typeof costCny === 'number' ? costCny : undefined,
        durationSec: actualDuration,
        actualModel: res.data?.actualModel,
        nodeId: node.id,
      };
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      return { ok: false, error: e instanceof Error ? e.message : '出视频失败' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '出视频失败' };
  }
}
