// 把对话里的图产物落进设计画布（2026-08-01 B3「修改」入口）。
//
// 为什么是独立模块而不是 useDesignCanvasImport 的一个分支：调用方是聊天侧的
// MediaAssetControls，它不该 import 设计区的 React hook（跨层）。这里只用 store 的
// getState，无 React 依赖，两侧都能调。
//
// 与拖入/粘贴导入的区别：源是**磁盘上已有的文件**（会话工作区里的图产物），不是 File 对象，
// 所以走 host 的 importDesignImageFromPath——它带源路径守卫（限死在活跃工作目录+设计目录、
// 先解析 symlink 再判定），避免这条通道变成任意文件读取。
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useDesignCanvasStore } from './designCanvasStore';
import { ensureCanvasRun, saveCanvasDoc } from './designCanvasPersistence';
import { readWorkspaceImageAsDataUrl } from './designFiles';
import { loadImageDims, nextVariantNodeId } from './useDesignCanvasGeneration';
import { placeCanvasNode } from './canvasPlacement';
import type { CanvasImageNode } from './designCanvasTypes';

/** 从源文件名取扩展名；拿不到就按 png 兜底（host 侧只放行图片扩展名，这里保持一致）。 */
function extFromPath(sourcePath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(sourcePath.trim());
  return m ? m[1].toLowerCase() : 'png';
}

export interface ImportAssetToCanvasResult {
  ok: boolean;
  /** 落成的画布节点 id（成功时）。 */
  nodeId?: string;
  /** 失败原因（已是人话，可直接展示）。 */
  error?: string;
}

/**
 * 把一个磁盘上的图片复制进当前画布 run 并落成节点、选中它。
 * 成功后调用方负责切到设计画布 tab（本模块不碰 appStore，保持职责单一）。
 */
export async function importAssetToCanvas(sourcePath: string): Promise<ImportAssetToCanvasResult> {
  if (!sourcePath?.trim()) return { ok: false, error: '这张图没有本地文件路径，无法放进画布' };

  const runDir = await ensureCanvasRun();
  if (!runDir) return { ok: false, error: '找不到设计工作目录' };

  const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/from-chat-${Date.now()}.${extFromPath(sourcePath)}`;
  const assetAbs = `${runDir}/${assetRel}`;

  const res = await window.domainAPI?.invoke<{ path: string }>(
    IPC_DOMAINS.WORKSPACE,
    'importDesignImageFromPath',
    { sourcePath, outputPath: assetAbs },
  );
  if (!res?.success) return { ok: false, error: res?.error?.message || '把图放进画布失败' };

  // 尺寸在 renderer 侧量（host 只返回 path，接口更小）——与拖入/粘贴导入同一套。
  const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
  if (!dataUrl) return { ok: false, error: '图已复制进画布，但读不回来量尺寸' };
  const { width, height } = await loadImageDims(dataUrl);

  const canvas = useDesignCanvasStore.getState();
  const { x, y } = placeCanvasNode({
    nodes: canvas.nodes,
    size: { width, height },
    camera: canvas.camera,
    operation: 'root',
  });
  const node: CanvasImageNode = {
    id: nextVariantNodeId(),
    src: assetRel,
    x,
    y,
    width,
    height,
    createdAt: Date.now(),
  };
  useDesignCanvasStore.getState().addNode(node);
  // 选中它：用户点「修改」的意图就是马上对这张图动手，顶栏应当直接是那条图像动词条。
  useDesignCanvasStore.getState().setSelected([node.id]);
  await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
  return { ok: true, nodeId: node.id };
}
