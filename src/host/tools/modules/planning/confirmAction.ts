// ============================================================================
// ConfirmAction (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/confirmAction.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / DOMAIN_ERROR
// - 行为保真（**IPC 协议不变**）：
//   * IPC_CHANNELS.CONFIRM_ACTION_ASK → renderer (request shape:
//     {id, title, message, type, confirmText, cancelText, timestamp})
//   * IPC_CHANNELS.CONFIRM_ACTION_RESPONSE ← renderer (response: {requestId, confirmed})
//   * ipcMain.handle once-guard
//   * No window 时 fallback 'cancelled (no UI available)'
//   * INTERACTION_TIMEOUTS.CONFIRM_ACTION 超时 = cancel
//   * 输出 'confirmed' / 'cancelled' 1:1
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { AppWindow, hasInteractiveUi, ipcHost } from '../../../platform';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { createLogger } from '../../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../../shared/constants';
import { confirmActionSchema as schema } from './confirmAction.schema';
import {
  deniedDecisionMetadata,
  headlessDecisionTimeoutReason,
  markDecisionRequestExpired,
  notifyDecisionNeeded,
  notifyIfLateDecisionResponse,
} from '../../../permissions/userDecision';

const logger = createLogger('ConfirmAction');

// Store pending confirm requests
const pendingConfirms = new Map<string, {
  resolve: (confirmed: boolean) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

let handlerRegistered = false;

function registerResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcHost.handle(
    IPC_CHANNELS.CONFIRM_ACTION_RESPONSE,
    async (_event, response: { requestId: string; confirmed: boolean }) => {
      const pending = pendingConfirms.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingConfirms.delete(response.requestId);
        pending.resolve(response.confirmed);
      } else {
        notifyIfLateDecisionResponse(response.requestId);
        logger.warn('Received confirm_action response for unknown request', {
          requestId: response.requestId,
        });
      }
    },
  );
}

export async function executeConfirmAction(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const title = args.title as string | undefined;
  const message = args.message as string | undefined;
  const type = (args.type as string) || 'warning';
  const confirmText = (args.confirmText as string) || '确认';
  const cancelText = (args.cancelText as string) || '取消';

  if (!title || !message) {
    return {
      ok: false,
      error: 'title and message are required',
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

  const request = {
    id: `confirm-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
    title,
    message,
    type,
    confirmText,
    cancelText,
    timestamp: Date.now(),
  };

  const mainWindow = AppWindow.getAllWindows()[0];
  if (!mainWindow) {
    logger.warn('No window available for confirmation dialog, denying action');
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: 'cancelled (no UI available)',
      meta: deniedDecisionMetadata(
        '当前运行环境没有可投递的交互界面，确认操作已按无头规则安全拒绝。',
      ),
    };
  }

  logger.info('Sending confirmation request to UI', { requestId: request.id, title });
  mainWindow.webContents.send(IPC_CHANNELS.CONFIRM_ACTION_ASK, request);
  notifyDecisionNeeded({
    sessionId: ctx.sessionId,
    title: title,
    body: message,
  });

  const interactive = hasInteractiveUi();
  const timeoutMs = interactive
    ? INTERACTION_TIMEOUTS.PARKED_APPROVAL
    : INTERACTION_TIMEOUTS.CONFIRM_ACTION;

  try {
    const decision = await new Promise<{ confirmed: boolean; timedOut: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingConfirms.delete(request.id);
        markDecisionRequestExpired(request.id, '确认操作');
        resolve({ confirmed: false, timedOut: true });
      }, timeoutMs);

      pendingConfirms.set(request.id, {
        resolve: (confirmed) => resolve({ confirmed, timedOut: false }),
        reject,
        timeout,
      });
    });

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('confirm_action done', { confirmed: decision.confirmed });

    if (!decision.confirmed) {
      const reason = decision.timedOut
        ? interactive
          ? '等待确认操作超过 24 小时，停车请求已按安全兜底取消。'
          : headlessDecisionTimeoutReason(timeoutMs)
        : '用户取消了确认操作。';
      return {
        ok: true,
        output: decision.timedOut ? reason : 'cancelled',
        meta: deniedDecisionMetadata(reason),
      };
    }

    return {
      ok: true,
      output: 'confirmed',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to get user confirmation',
      code: 'DOMAIN_ERROR',
    };
  }
}

class ConfirmActionHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeConfirmAction(args, ctx, canUseTool, onProgress);
  }
}

export const confirmActionModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ConfirmActionHandler();
  },
};
