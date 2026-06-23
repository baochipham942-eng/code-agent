// ============================================================================
// RequestDesignAutonomy（ADR-027）—— agent 请求一个有界自主预算信封，阻塞等用户一次性审批。
// 复刻 proposeCanvasOps/askUserQuestion 的阻塞往返骨架：
//   * CANVAS_AUTONOMY_ASK → renderer（{requestId, goal, proposed, rationale}）
//   * CANVAS_AUTONOMY_RESPONSE ← renderer（{requestId, verdict, granted?, feedback?}）
//   * 无交互 renderer（CLI/headless）→ 降级回告，不假装已进入自主（红线⑤）
//   * INTERACTION_TIMEOUTS.USER_QUESTION 超时（这步仅审批，出图在后续 proposeCanvasOps 各自计时）
// 信封态由 renderer 在审批时建立并持有（成本权威所在，红线④）；本工具只取审批结果 + 告诉 agent 信封条款。
// ============================================================================
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { AutonomyEnvelopeRequest, AutonomyEnvelopeDecision, AutonomyGrant } from '../../../../shared/contract';
import { grantEnvelope } from '../../../../shared/contract/designAutonomy';
import { formatCny } from '../../../../shared/media/imageCost';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { BrowserWindow, ipcMain } from '../../../platform';
import { createLogger } from '../../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../../shared/constants';
import { requestDesignAutonomySchema as schema } from './requestDesignAutonomy.schema';

const logger = createLogger('RequestDesignAutonomy');

const pendingRequests = new Map<string, {
  resolve: (decision: AutonomyEnvelopeDecision) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

let handlerRegistered = false;

function registerResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE,
    async (_event, decision: AutonomyEnvelopeDecision) => {
      const pending = pendingRequests.get(decision.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(decision.requestId);
        pending.resolve(decision);
      }
    },
  );
}

export async function executeRequestDesignAutonomy(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal) {
    return { ok: false, error: 'goal must be a non-empty string describing what to explore autonomously', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });
  registerResponseHandler();

  // agent 提议的信封（两上限可选；renderer/人审批时夹紧 + 派生默认）。
  const proposed: AutonomyGrant = {
    ...(typeof args.maxVariants === 'number' && Number.isFinite(args.maxVariants) ? { maxVariants: args.maxVariants } : {}),
    ...(typeof args.maxCny === 'number' && Number.isFinite(args.maxCny) ? { maxCny: args.maxCny } : {}),
  };
  const rationale = typeof args.rationale === 'string' ? args.rationale : undefined;
  const request: AutonomyEnvelopeRequest = {
    requestId: `da-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
    goal,
    proposed,
    ...(rationale ? { rationale } : {}),
  };

  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || !BrowserWindow.hasInteractiveRenderer()) {
    // 降级（红线⑤）：非交互环境无法启动自主——明确回告，不假装已进入自主。
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `[当前非交互式设计画布环境，无法启动有界自主生成]\n目标：${goal}。请改用文字向用户描述你打算探索的方向与变体思路，等待用户在设计画布中操作。不要假设已进入自主模式。`,
    };
  }

  logger.info('Requesting design autonomy envelope', { requestId: request.requestId, proposed });
  mainWindow.webContents.send(IPC_CHANNELS.CANVAS_AUTONOMY_ASK, request);

  try {
    const { notificationService } = await import('../../../services/infra/notificationService');
    notificationService.notifyNeedsInput({
      sessionId: ctx.sessionId || '',
      title: '自主信封待审批',
      body: rationale || goal,
    });
  } catch {
    /* ignore */
  }

  // abort/超时撤掉信封审批面板（防孤儿信封被后点 Grant 后无 agent 使用）。
  const broadcastCancel = (): void => {
    try { mainWindow.webContents.send(IPC_CHANNELS.CANVAS_AUTONOMY_CANCEL, { requestId: request.requestId }); } catch { /* 窗口已毁 */ }
  };

  try {
    const decision = await new Promise<AutonomyEnvelopeDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(request.requestId);
        broadcastCancel();
        reject(new Error('Autonomy envelope request timeout - no response from user'));
      }, INTERACTION_TIMEOUTS.USER_QUESTION);
      ctx.abortSignal.addEventListener(
        'abort',
        () => {
          const p = pendingRequests.get(request.requestId);
          if (p) {
            clearTimeout(p.timeout);
            pendingRequests.delete(request.requestId);
          }
          broadcastCancel();
          reject(new Error('aborted'));
        },
        { once: true },
      );
      pendingRequests.set(request.requestId, { resolve, reject, timeout });
    });

    onProgress?.({ stage: 'completing', percent: 100 });

    if (decision.verdict === 'grant') {
      // 用人最终确认的信封（可能改过 agent 提议值）算最终条款；与 renderer 用同一 grantEnvelope，二者一致。
      const env = grantEnvelope(decision.granted ?? proposed);
      return {
        ok: true,
        output:
          `自主信封已批准：本轮最多生成 ${env.maxVariants} 个变体、预算上限 ${formatCny(env.maxCny)}。\n` +
          `现在请用 ProposeCanvasOps 逐个提议 generateImage（文生图）——它们会在信封内自动出图、无需逐张审批，直到信封耗尽。` +
          `每张出图后你会收到剩余预算；信封耗尽时停止生成，让用户从变体里挑选。\n` +
          `关键：发散地尝试明显不同的方向（不要互相雷同），不要自我评判或试图"修好某一张"——用户挑选是唯一的质量信号。` +
          `破坏性操作（淘汰/删除）和视频不在自主范围，仍需逐步审批。`,
      };
    }
    const fb = decision.feedback ? `：${decision.feedback}` : '';
    return {
      ok: true,
      output: `用户未批准自主信封${fb}。请改用逐步 ProposeCanvasOps（每步审批）或用文字向用户描述方案。不要假设已进入自主模式。`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to get user decision on autonomy envelope',
      code: 'DOMAIN_ERROR',
    };
  }
}

class RequestDesignAutonomyHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRequestDesignAutonomy(args, ctx, canUseTool, onProgress);
  }
}

export const requestDesignAutonomyModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RequestDesignAutonomyHandler();
  },
};
