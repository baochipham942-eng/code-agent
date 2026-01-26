// ============================================================================
// Confirm Action Tool - 弹窗确认危险操作
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { createLogger } from '../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../shared/constants';

const logger = createLogger('ConfirmAction');

// Store pending confirm requests
const pendingConfirms = new Map<string, {
  resolve: (confirmed: boolean) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Register IPC handler for user responses (only once)
let handlerRegistered = false;

function registerResponseHandler() {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcMain.handle(IPC_CHANNELS.CONFIRM_ACTION_RESPONSE, async (_event, response: { requestId: string; confirmed: boolean }) => {
    const pending = pendingConfirms.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingConfirms.delete(response.requestId);
      pending.resolve(response.confirmed);
    }
  });
}

export const confirmActionTool: Tool = {
  name: 'confirm_action',
  description: `Show a confirmation dialog to the user before executing a dangerous or irreversible action.

USE THIS TOOL when:
- Deleting files or directories
- Modifying system settings
- Executing potentially destructive commands
- Any action that cannot be easily undone

The dialog will display:
- A title describing the action
- A detailed message explaining what will happen
- Action type (danger, warning, info)
- Confirm and Cancel buttons

Returns: "confirmed" if user clicked confirm, "cancelled" if user clicked cancel or closed the dialog.

Example:
  confirm_action({
    title: "删除文件",
    message: "确定要删除以下 5 个文件吗？\\n\\n- file1.txt\\n- file2.txt\\n...",
    type: "danger",
    confirmText: "删除",
    cancelText: "取消"
  })`,
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Dialog title (e.g., "删除文件", "执行命令")',
      },
      message: {
        type: 'string',
        description: 'Detailed message explaining the action and its consequences',
      },
      type: {
        type: 'string',
        enum: ['danger', 'warning', 'info'],
        description: 'Action type: "danger" for destructive actions (red), "warning" for caution (yellow), "info" for informational (blue)',
      },
      confirmText: {
        type: 'string',
        description: 'Text for the confirm button (default: "确认")',
      },
      cancelText: {
        type: 'string',
        description: 'Text for the cancel button (default: "取消")',
      },
    },
    required: ['title', 'message'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const title = params.title as string;
    const message = params.message as string;
    const type = (params.type as string) || 'warning';
    const confirmText = (params.confirmText as string) || '确认';
    const cancelText = (params.cancelText as string) || '取消';

    if (!title || !message) {
      return {
        success: false,
        error: 'title and message are required',
      };
    }

    // Register response handler
    registerResponseHandler();

    // Create request
    const request = {
      id: `confirm-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
      title,
      message,
      type,
      confirmText,
      cancelText,
      timestamp: Date.now(),
    };

    // Get the main window to send IPC event
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      // No window available - fall back to auto-deny for safety
      logger.warn('No window available for confirmation dialog, denying action');
      return {
        success: true,
        output: 'cancelled (no UI available)',
      };
    }

    // Send confirmation request to renderer
    logger.info('Sending confirmation request to UI', { requestId: request.id, title });
    mainWindow.webContents.send(IPC_CHANNELS.CONFIRM_ACTION_ASK, request);

    // Wait for response with timeout
    const TIMEOUT_MS = INTERACTION_TIMEOUTS.CONFIRM_ACTION;

    try {
      const confirmed = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingConfirms.delete(request.id);
          resolve(false); // Timeout = cancel
        }, TIMEOUT_MS);

        pendingConfirms.set(request.id, { resolve, reject, timeout });
      });

      return {
        success: true,
        output: confirmed ? 'confirmed' : 'cancelled',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user confirmation',
      };
    }
  },
};
