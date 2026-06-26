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
import { AppWindow, ipcHost } from '../../../platform';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { createLogger } from '../../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../../shared/constants';
import { confirmActionSchema as schema } from './confirmAction.schema';

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
    };
  }

  logger.info('Sending confirmation request to UI', { requestId: request.id, title });
  mainWindow.webContents.send(IPC_CHANNELS.CONFIRM_ACTION_ASK, request);

  const TIMEOUT_MS = INTERACTION_TIMEOUTS.CONFIRM_ACTION;

  try {
    const confirmed = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingConfirms.delete(request.id);
        resolve(false); // Timeout = cancel (与 legacy 一致)
      }, TIMEOUT_MS);

      pendingConfirms.set(request.id, { resolve, reject, timeout });
    });

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('confirm_action done', { confirmed });

    return {
      ok: true,
      output: confirmed ? 'confirmed' : 'cancelled',
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
