// 设计画布出图回灌 hook（Cowart 式 P1：文生图 → 回灌画布节点）。
//
// 流程：点"生成" → 复用/新建画布 run 目录 → 拼 image prompt（含预留 output_path）
// → 在隔离设计会话里发给现有 Agent loop → Agent 调 image_generate 把 PNG 写到预留路径
// → 本 hook 轮询该路径，图就位（且会话转 idle）后读成 dataURL、量原始尺寸、在现有节点
// 右侧落一个画布节点 → 存盘 canvas.json。
//
// 与 useDesignGeneration（HTML 原型）分离：产物类型不同、回填目标不同（画布 vs iframe）。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useAgent } from '../../hooks/useAgent';
import { useI18n } from '../../hooks/useI18n';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { buildImagePrompt } from './designTypes';
import { emptyCanvasDoc, nextNodePlacement, type CanvasImageNode } from './designCanvasTypes';
import { saveCanvasDoc } from './designCanvasPersistence';
import { resolveDesignDir, readWorkspaceImageAsDataUrl } from './designFiles';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath });
  } catch {
    // Agent 写文件时也会建父目录，这里失败不致命。
  }
}

/** 把 dataURL 加载进 Image 量原始像素尺寸；失败回退兜底正方形。 */
function loadImageDims(dataUrl: string): Promise<{ width: number; height: number }> {
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

/** 持久化当前画布到磁盘（best-effort，失败不打断用户）。 */
async function persistCanvas(runDir: string): Promise<void> {
  await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
}

/**
 * 轮询预留图片路径，就位后回灌为画布节点。完成判定以会话处理状态为准
 * （会话从"处理中"转 idle 即定稿），兜底用超时。
 */
async function pollAndIngest(
  runDir: string,
  assetAbs: string,
  assetRel: string,
  prompt: string,
  sessionId: string | null,
  timeoutMsg: string,
): Promise<void> {
  const canvas = useDesignCanvasStore;
  const deadline = Date.now() + DESIGN_WORKSPACE.POLL_TIMEOUT_MS;

  const ingest = async (dataUrl: string): Promise<void> => {
    const { width, height } = await loadImageDims(dataUrl);
    const { x, y } = nextNodePlacement(canvas.getState().nodes, DESIGN_WORKSPACE.CANVAS_NODE_GAP);
    const node: CanvasImageNode = {
      id: `node-${Date.now()}`,
      src: assetRel,
      x,
      y,
      width,
      height,
      prompt,
      createdAt: Date.now(),
    };
    canvas.getState().addNode(node);
    await persistCanvas(runDir);
    canvas.getState().setGenerating(false);
  };

  while (Date.now() < deadline) {
    // 画布被切到别的 run → 放弃本轮。
    if (canvas.getState().runDir !== runDir) {
      canvas.getState().setGenerating(false);
      return;
    }
    const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
    const processing = sessionId ? useAppStore.getState().processingSessionIds.has(sessionId) : false;
    // assetAbs 路径含时间戳唯一，文件存在即说明本回合 Agent 已写出图；
    // 再确认会话不在处理中（Agent 写完图后可能还在补总结）才定稿。
    if (dataUrl && !processing) {
      await ingest(dataUrl);
      return;
    }
    await sleep(DESIGN_WORKSPACE.POLL_INTERVAL_MS);
  }
  // 超时兜底：再尝试读一次，读到就收，否则报错。
  const last = await readWorkspaceImageAsDataUrl(assetAbs);
  if (last) {
    await ingest(last);
    return;
  }
  canvas.getState().setGenerating(false);
  canvas.getState().setError(timeoutMsg);
}

export function useDesignCanvasGeneration(): { generate: () => Promise<void> } {
  const { sendMessage } = useAgent();
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
    await ensureDir(`${runDir}/${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}`);

    const prompt = buildImagePrompt({
      requirement: form.requirement,
      outputType,
      reservedPath: assetAbs,
      designContext: {
        surface: form.surface ?? undefined,
        brandColor: form.brandColor.trim() || undefined,
        tone: form.tone,
      },
    });

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      // 记下用户当前聊天会话：设计生成不应抢占它（同 useDesignGeneration）。
      const prevSessionId = useSessionStore.getState().currentSessionId;
      const session = await useSessionStore
        .getState()
        .createSession(`${t.design.title}：${form.requirement.slice(0, 12)}`, {
          workingDirectory: runDir,
        });
      if (!session) {
        useDesignCanvasStore.getState().setGenerating(false);
        useDesignCanvasStore.getState().setError(t.design.errDispatch);
        return;
      }
      if (prevSessionId && prevSessionId !== session.id) {
        await useSessionStore.getState().switchSession(prevSessionId);
      }
      await sendMessage({
        content: prompt,
        sessionId: session.id,
        context: { workingDirectory: runDir },
      });
      void pollAndIngest(runDir, assetAbs, assetRel, form.requirement, session.id, t.design.errTimeout);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [sendMessage, t]);

  return { generate };
}
