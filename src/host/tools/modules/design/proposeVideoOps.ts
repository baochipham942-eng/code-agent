// ============================================================================
// ProposeVideoOps（2b）—— agent 在设计会话里提议生成视频。
//
// 与 ProposeCanvasOps（图像/ADR-026）独立、与 ADR-027 自主信封**绝缘**：
//   1) main 侧用共享视频模型注册表解析模型 + clamp 时长 → 估成本
//   2) **会话区**成本确认（confirmGenerationCost，复用 AskUserQuestion round-trip）——
//      不落画布审批条、不弹 window.confirm；取消/无 renderer → 不花钱直接返回
//   3) 确认后 CANVAS_VIDEO_ASK → renderer（属主闸 + 出视频 + 落画布视频节点）→ 回裁决
//   4) 视频永不自动批量生成：每次都要人确认，不接 RequestDesignAutonomy
// ============================================================================
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { CanvasVideoRequest, CanvasVideoDecision } from '../../../../shared/contract';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { BrowserWindow, ipcMain } from '../../../platform';
import { createLogger } from '../../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../../shared/constants';
import { videoModelById, videoModelsWithCap, clampVideoDuration } from '../../../../shared/constants/visualModels';
import { estimateVideoCostCny } from '../../../../shared/media/videoCost';
import { confirmGenerationCost } from './generationCostConfirm';
import { proposeVideoOpsSchema as schema } from './proposeVideoOps.schema';

const logger = createLogger('ProposeVideoOps');

const pendingVideo = new Map<string, {
  resolve: (decision: CanvasVideoDecision) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

let handlerRegistered = false;
function registerResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_VIDEO_RESPONSE,
    async (_event, decision: CanvasVideoDecision) => {
      const p = pendingVideo.get(decision.requestId);
      if (p) {
        clearTimeout(p.timeout);
        pendingVideo.delete(decision.requestId);
        p.resolve(decision);
      }
    },
  );
}

export async function executeProposeVideoOps(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const mode = args.mode === 'i2v' ? 'i2v' : args.mode === 't2v' ? 't2v' : undefined;
  if (!mode) {
    return { ok: false, error: 'mode must be "t2v" or "i2v"', code: 'INVALID_ARGS' };
  }
  const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : undefined;
  const baseNodeId = typeof args.baseNodeId === 'string' && args.baseNodeId ? args.baseNodeId : undefined;
  if (mode === 't2v' && !prompt) {
    return { ok: false, error: 'text-to-video (t2v) requires a non-empty prompt', code: 'INVALID_ARGS' };
  }
  if (mode === 'i2v' && !baseNodeId) {
    return { ok: false, error: 'image-to-video (i2v) requires baseNodeId of an existing image node', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  // 解析视频模型（红线：agent 不得引入非法模型）：指定 model 仅当它存在且支持该 mode 才用；
  // 否则回退该 mode 下首个内置模型。无可用模型 → 报错（不静默走错模型）。
  const requested = typeof args.model === 'string' ? videoModelById(args.model) : undefined;
  const resolved = requested && requested.caps.includes(mode) ? requested : videoModelsWithCap(mode)[0];
  if (!resolved) {
    return { ok: false, error: `no available video model for mode ${mode}`, code: 'DOMAIN_ERROR' };
  }
  const requestedDuration = typeof args.durationSec === 'number' ? args.durationSec : undefined;
  const durationSec = clampVideoDuration(resolved, requestedDuration);
  const estCny = estimateVideoCostCny(resolved.id, durationSec);

  onProgress?.({ stage: 'starting', detail: schema.name });

  // ── 会话区成本确认（不抢画布焦点；fail-closed：取消/无 renderer/超时 → 不花钱）──
  const confirmed = await confirmGenerationCost({
    mediaLabel: '视频',
    estCny,
    detail: `${mode} · ${durationSec}s · ${resolved.label}`,
    sessionId: ctx.sessionId,
    abortSignal: ctx.abortSignal,
  });
  if (!confirmed) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `用户未确认本次视频生成（预估 ¥${estCny.toFixed(2)}），已取消，未产生费用。可在确认成本后重试，或先用文字与用户对齐需求。`,
    };
  }

  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  // ── 已确认 → 请求 renderer 出视频并落画布节点 ──
  registerResponseHandler();
  const request: CanvasVideoRequest = {
    requestId: `cv-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
    mode,
    model: resolved.id,
    durationSec,
    ...(prompt ? { prompt } : {}),
    ...(baseNodeId ? { baseNodeId } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };

  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || !BrowserWindow.hasInteractiveRenderer()) {
    // 成本确认能过说明刚才有 renderer；走到这里基本不会发生，兜底不假装已出图。
    return {
      ok: true,
      output: `[设计画布不可用 - 无法落地视频] 已确认成本但当前无交互式画布，未生成。请在桌面 app 的设计画布中重试。`,
    };
  }

  logger.info('Sending canvas video request to UI', { requestId: request.requestId, mode, model: resolved.id });
  mainWindow.webContents.send(IPC_CHANNELS.CANVAS_VIDEO_ASK, request);

  const TIMEOUT_MS = INTERACTION_TIMEOUTS.USER_QUESTION + INTERACTION_TIMEOUTS.CANVAS_PROPOSAL_GEN_BUDGET;
  try {
    const decision = await new Promise<CanvasVideoDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingVideo.delete(request.requestId);
        reject(new Error('Canvas video generation timeout'));
      }, TIMEOUT_MS);
      // 先登记 pending 再挂 abort 监听（审计 F2）：否则 abort 在两者之间触发时，监听器
      // 取不到 entry → 不 clearTimeout，随后 set 进来的 timer 会空跑到 TIMEOUT_MS（6.5min）
      // 才清理。与 promptUserInChat 同序：set 在前、addEventListener 在后。
      pendingVideo.set(request.requestId, { resolve, reject, timeout });
      ctx.abortSignal.addEventListener(
        'abort',
        () => {
          const p = pendingVideo.get(request.requestId);
          if (p) {
            clearTimeout(p.timeout);
            pendingVideo.delete(request.requestId);
          }
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });

    onProgress?.({ stage: 'completing', percent: 100 });

    if (decision.status === 'applied') {
      const cost = typeof decision.costCny === 'number' ? `，实际花费 ¥${decision.costCny.toFixed(2)}` : '';
      const dur = typeof decision.durationSec === 'number' ? `${decision.durationSec}s ` : '';
      return { ok: true, output: `已生成${dur}视频并落到设计画布${cost}。` };
    }
    if (decision.status === 'rejected') {
      return { ok: true, output: `视频生成被画布属主隔离拒绝${decision.error ? `：${decision.error}` : ''}。当前画布不属于该会话。` };
    }
    return {
      ok: false,
      error: decision.error || 'video generation failed',
      code: 'DOMAIN_ERROR',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to generate video',
      code: 'DOMAIN_ERROR',
    };
  }
}

class ProposeVideoOpsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeProposeVideoOps(args, ctx, canUseTool, onProgress);
  }
}

export const proposeVideoOpsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProposeVideoOpsHandler();
  },
};
