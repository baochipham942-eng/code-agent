// ADR-026 二刀 Layer2：把 agent 提议的 generateImage op 真出图并落画布节点。
// 与表单态 generate() 共用同一出图原语（generateDesignImage IPC + addNode），但**不落盘、不清史**——
// 由 canvasProposalController 统一收尾（单次 save + 条件 clearEditHistory，混批顺序写死）。
// 故本函数是无 React 依赖的纯过程（全经 store getState），可被非 hook 的 controllerDeps 直接调用。
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { imageModelById } from '@shared/constants/visualModels';
import type { ProposeGenerateImageOp } from '@shared/contract/canvasProposal';
import { useDesignStore } from './designStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { buildImagePrompt } from './designTypes';
import { emptyCanvasDoc, nextNodePlacement, type CanvasImageNode } from './designCanvasTypes';
import { resolveDesignDir, readWorkspaceImageAsDataUrl } from './designFiles';
import { loadImageDims, nextVariantNodeId } from './useDesignCanvasGeneration';

/**
 * 解析提议生成实际用的图像模型（红线②）：agent 指定的 model 仅当它是注册表里声明 t2i 能力的
 * 内置模型才采纳；否则（未知 id / 无 t2i / 自定义端点）回退表单当前选择，**绝不让 agent 引入新模型/端点**。
 */
export function resolveProposedImageModel(opModel: string | undefined, formModel: string): string {
  if (opModel) {
    const m = imageModelById(opModel);
    if (m?.caps.includes('t2i')) return opModel;
  }
  return formModel;
}

/** 预估单个生成 op 的成本（¥）——UI 审批面板与实际出图用同一解析口径，预估与落地的 model 一致。 */
export { estimateImageCostCny as estimateProposedImageCostCny } from '@shared/media/imageCost';

async function ensureRunDir(): Promise<string | null> {
  const existing = useDesignCanvasStore.getState().runDir;
  if (existing) return existing;
  const baseDir = await resolveDesignDir();
  if (!baseDir) return null;
  const runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath: runDir });
  } catch {
    /* 出图 IPC 也会建父目录，这里失败不致命 */
  }
  useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
  return runDir;
}

/**
 * 执行一个 generateImage 提议 op：解析模型 → 文生图 IPC → 落新节点（带实际 costCny）。
 * **不落盘、不清史**（controller 收尾）。失败（无 runDir / IPC 报错 / 读图失败 / 中途切 run）一律返回
 * { ok:false }，由 controller 计 skipped——不抛、不污染画布、不重复付费。落位 nextNodePlacement 自动定（红线③）。
 */
export async function generateProposedImage(
  op: ProposeGenerateImageOp,
  opts?: { parentId?: string },
): Promise<{ ok: boolean; costCny?: number; nodeId?: string }> {
  // 全程包在 try 内（审计 HIGH-2）：ensureRunDir/resolveDesignDir 也可能抛（FS/权限），
  // 任何抛错都收敛成 { ok:false }，绝不让异常冒泡到 controller 把整批拖垮 / 吞掉 respond。
  try {
    const runDir = await ensureRunDir();
    if (!runDir) return { ok: false };

    const form = useDesignStore.getState();
    const model = resolveProposedImageModel(op.model, form.imageModel);
    const aspectRatio = op.aspectRatio || form.aspectRatio;
    // 用 agent 的 prompt 作 requirement，套画布当前品牌上下文保持视觉一致（outputType 收敛到图类）。
    const prompt = buildImagePrompt({
      requirement: op.prompt,
      outputType: form.outputType === 'infographic' ? 'infographic' : 'mockup',
      designContext: {
        surface: form.surface ?? undefined,
        brandColor: form.brandColor.trim() || undefined,
        tone: form.tone,
      },
    });

    const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/gen-${Date.now()}.png`;
    const assetAbs = `${runDir}/${assetRel}`;

    const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number }>(
      IPC_DOMAINS.WORKSPACE,
      'generateDesignImage',
      { prompt, aspectRatio, model, outputPath: assetAbs },
    );
    if (!res?.success) return { ok: false };
    // 出图期间用户切到别的 run：丢弃回灌（与表单 generate 一致），不落到错画布。
    if (useDesignCanvasStore.getState().runDir !== runDir) return { ok: false };
    const dataUrl = await readWorkspaceImageAsDataUrl(assetAbs);
    if (!dataUrl) return { ok: false };
    const { width, height } = await loadImageDims(dataUrl);
    const { x, y } = nextNodePlacement(useDesignCanvasStore.getState().nodes, DESIGN_WORKSPACE.CANVAS_NODE_GAP);
    const costCny = res.data?.costCny;
    const nodeId = nextVariantNodeId();
    const node: CanvasImageNode = {
      id: nodeId,
      src: assetRel,
      x,
      y,
      width,
      height,
      prompt: op.prompt,
      createdAt: Date.now(),
      // ADR-027：自主扇出时归入同一变体组（parentId=组首张 id），使 N 张成兄弟变体供人挑（setChosen 按 groupKey）。
      ...(opts?.parentId ? { parentId: opts.parentId } : {}),
      ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}),
    };
    // addNode 不落盘不清史：controller 在整批生成毕统一 save + 条件 clearEditHistory（混批顺序写死）。
    useDesignCanvasStore.getState().addNode(node);
    return { ok: true, nodeId, ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}) };
  } catch {
    return { ok: false };
  }
}
