// ============================================================================
// ProposeCanvasOps（ADR-026）—— agent 提议一批画布 op，阻塞等用户审批；批准后由
// renderer 应用（agent 不直接改画布）。复刻 askUserQuestion 的阻塞往返骨架：
//   * CANVAS_PROPOSAL_ASK → renderer（{requestId, ops, rationale}）
//   * CANVAS_PROPOSAL_RESPONSE ← renderer（{requestId, verdict, feedback?, appliedCount?, skippedCount?}）
//   * ipcMain.handle once-per-process 注册
//   * 无交互 renderer（CLI/headless）→ fallback 文案，不假装已应用
//   * INTERACTION_TIMEOUTS.USER_QUESTION 超时
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { CanvasOpProposal, CanvasProposalDecision } from '../../../../shared/contract';
import { normalizeProposal } from '../../../../shared/contract/canvasProposal';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { BrowserWindow, ipcMain } from '../../../platform';
import { createLogger } from '../../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../../shared/constants';
import { proposeCanvasOpsSchema as schema } from './proposeCanvasOps.schema';

const logger = createLogger('ProposeCanvasOps');

const pendingProposals = new Map<string, {
  resolve: (decision: CanvasProposalDecision) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

let handlerRegistered = false;

function registerResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE,
    async (_event, decision: CanvasProposalDecision) => {
      const pending = pendingProposals.get(decision.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingProposals.delete(decision.requestId);
        pending.resolve(decision);
      }
    },
  );
}

function describeOps(ops: CanvasOpProposal['ops']): string {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
}

/**
 * 阻塞超时（ADR-026 增补-D1）：纯 Layer1 批用 USER_QUESTION；含付费生成的批每张加一份出图预算，
 * 因审批后还要在 renderer 串行出图、整体 await 到落地才回裁决，慢付费不能撞死工具。
 */
export function computeProposalTimeoutMs(ops: CanvasOpProposal['ops']): number {
  const genCount = ops.filter((o) => o.kind === 'generateImage').length;
  return INTERACTION_TIMEOUTS.USER_QUESTION + genCount * INTERACTION_TIMEOUTS.CANVAS_PROPOSAL_GEN_BUDGET;
}

export async function executeProposeCanvasOps(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // 校验 + 归一化（剥离破坏性/破损 op，防越权）。
  const { ops, dropped } = normalizeProposal(args.ops);
  if (ops.length === 0) {
    return {
      ok: false,
      error: dropped > 0
        ? `No valid ops: all ${dropped} op(s) were invalid or unsupported (allowed: moveNode/addConnector/addShape/renameNode/discardNode on existing nodes, or generateImage with a prompt).`
        : 'ops must be a non-empty array of canvas operations',
      code: 'INVALID_ARGS',
    };
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

  const rationale = typeof args.rationale === 'string' ? args.rationale : undefined;
  const request: CanvasOpProposal = {
    requestId: `cp-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
    ops,
    ...(rationale ? { rationale } : {}),
    // H2-R2：带上发起提议的 session，renderer 属主隔离闸用（跨会话提议被拒）。
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };

  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || !BrowserWindow.hasInteractiveRenderer()) {
    // 无交互 renderer：不假装已应用——明确告诉模型无法在此模式提议画布操作。
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `[画布提议无法展示 - 当前非交互式设计画布环境]\n提议内容：${describeOps(ops)}。请改用文字向用户描述你的画布修改建议，等待用户在设计画布中操作。不要假设提议已应用。`,
    };
  }

  logger.info('Sending canvas proposal to UI', { requestId: request.requestId, ops: ops.length, dropped });
  mainWindow.webContents.send(IPC_CHANNELS.CANVAS_PROPOSAL_ASK, request);

  try {
    const { notificationService } = await import('../../../services/infra/notificationService');
    notificationService.notifyNeedsInput({
      sessionId: ctx.sessionId || '',
      title: '画布提议待审批',
      body: rationale || `${ops.length} 项画布修改待你确认`,
    });
  } catch {
    /* ignore */
  }

  // 通知 renderer 撤掉审批条（审计 MED-3）：abort/超时后若不撤，用户后点 Apply 会在无 agent 监听下
  // 触发付费生成（孤儿提议烧钱）。二刀起生成是付费路径，必须主动取消 UI。
  const broadcastCancel = (): void => {
    try { mainWindow.webContents.send(IPC_CHANNELS.CANVAS_PROPOSAL_CANCEL, { requestId: request.requestId }); } catch { /* 窗口已毁，无需取消 */ }
  };

  const TIMEOUT_MS = computeProposalTimeoutMs(ops);
  try {
    const decision = await new Promise<CanvasProposalDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingProposals.delete(request.requestId);
        broadcastCancel();
        reject(new Error('Canvas proposal timeout - no response from user'));
      }, TIMEOUT_MS);
      // abort 中途触发（agent 取消）：清掉 pending + reject，别让条目泄漏 / 工具挂到超时（C1）。
      ctx.abortSignal.addEventListener(
        'abort',
        () => {
          const p = pendingProposals.get(request.requestId);
          if (p) {
            clearTimeout(p.timeout);
            pendingProposals.delete(request.requestId);
          }
          broadcastCancel();
          reject(new Error('aborted'));
        },
        { once: true },
      );
      pendingProposals.set(request.requestId, { resolve, reject, timeout });
    });

    onProgress?.({ stage: 'completing', percent: 100 });

    if (decision.verdict === 'apply') {
      const applied = decision.appliedCount ?? ops.length;
      const skipped = decision.skippedCount ?? 0;
      const skipNote = skipped > 0 ? `，跳过 ${skipped} 项（目标已变更，或被用户取消勾选——勿重复提议被否决项）` : '';
      // 二刀：含付费生成时回灌实际合计花费，让模型知道真烧了多少。
      const costNote = typeof decision.costCny === 'number' && decision.costCny > 0 ? `，本次生成实际花费 ¥${decision.costCny.toFixed(2)}` : '';
      // ADR-027 自主：自动路径回填剩余预算——告诉 agent 继续发散还是停下让用户挑。
      const auto = decision.autonomy;
      if (auto) {
        const tail = auto.exhausted
          ? `自主信封已耗尽（剩 ${auto.remainingVariants} 个变体 / ¥${auto.remainingCny.toFixed(2)}）。停止生成，让用户从变体里挑选一个。`
          : `自主信封剩余 ${auto.remainingVariants} 个变体 / ¥${auto.remainingCny.toFixed(2)}。可继续提议下一个**明显不同方向**的变体，或停下让用户挑选。`;
        return { ok: true, output: `已在自主信封内自动应用：${applied} 项画布操作${skipNote}${costNote}（${describeOps(ops)}）。${tail}` };
      }
      return { ok: true, output: `用户已批准并应用：${applied} 项画布操作${skipNote}${costNote}（${describeOps(ops)}）。画布已更新。` };
    }
    const fb = decision.feedback ? `\n用户意见：${decision.feedback}` : '';
    return { ok: true, output: `用户拒绝了本次画布提议。${fb}\n请据此调整后再提议，或改用其它方式。不要假设任何修改已应用。` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to get user decision',
      code: 'DOMAIN_ERROR',
    };
  }
}

class ProposeCanvasOpsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeProposeCanvasOps(args, ctx, canUseTool, onProgress);
  }
}

export const proposeCanvasOpsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProposeCanvasOpsHandler();
  },
};
