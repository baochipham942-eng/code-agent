import type { BrowserService, BrowserTargetRef } from '../../services/infra/browserService.js';
import type { ToolContext, ToolExecutionResult } from '../types';
import {
  formatBrowserTargetRefLabel,
  summarizeBrowserTargetRefForTool,
} from './browserActionResultProjection';

type SurfaceInteractionAction =
  | 'hover'
  | 'drag'
  | 'get_dialog_state'
  | 'handle_dialog'
  | 'read_clipboard'
  | 'write_clipboard';

interface BrowserSurfaceInteractionInput {
  action: string;
  browserService: BrowserService;
  context: ToolContext;
  params: Record<string, unknown>;
  tabId: string | undefined;
}

export async function maybeExecuteBrowserSurfaceInteraction(
  input: BrowserSurfaceInteractionInput,
): Promise<ToolExecutionResult | null> {
  const action = input.action as SurfaceInteractionAction;
  const targetRef = input.params.targetRef as string | BrowserTargetRef | undefined;
  const destinationTargetRef = input.params.destinationTargetRef as string | BrowserTargetRef | undefined;
  const dialogAction = input.params.dialogAction as 'accept' | 'dismiss' | undefined;
  const dialogPromptText = input.params.dialogPromptText as string | undefined;
  const clipboardText = input.params.clipboardText as string | undefined;

  switch (action) {
    case 'hover': {
      if (!targetRef) {
        return {
          success: false,
          error: 'hover requires a fresh targetRef from get_dom_snapshot; selector or coordinate guessing is not allowed',
          metadata: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND', retryable: true },
        };
      }
      const resolved = await input.browserService.hoverTargetRef(targetRef, input.tabId);
      return {
        success: true,
        output: `Hovered targetRef: ${formatBrowserTargetRefLabel(resolved)}`,
        metadata: { targetRef: summarizeBrowserTargetRefForTool(resolved) },
      };
    }

    case 'drag': {
      if (!targetRef || !destinationTargetRef) {
        return {
          success: false,
          error: 'drag requires fresh targetRef and destinationTargetRef values from get_dom_snapshot; selector or coordinate guessing is not allowed',
          metadata: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND', retryable: true },
        };
      }
      const dragged = await input.browserService.dragTargetRefs(
        targetRef,
        destinationTargetRef,
        input.tabId,
      );
      return {
        success: true,
        output: `Dragged ${formatBrowserTargetRefLabel(dragged.source)} to ${formatBrowserTargetRefLabel(dragged.destination)}`,
        metadata: {
          targetRef: summarizeBrowserTargetRefForTool(dragged.source),
          destinationTargetRef: summarizeBrowserTargetRefForTool(dragged.destination),
        },
      };
    }

    case 'get_dialog_state': {
      const dialogState = input.browserService.getDialogState(input.tabId);
      return {
        success: true,
        output: dialogState.pending
          ? `A ${dialogState.type || 'browser'} dialog is paused for explicit accept or dismiss.`
          : 'No browser dialog is currently pending. Dialogs pause by default.',
        metadata: { browserDialogState: dialogState },
      };
    }

    case 'handle_dialog': {
      if (dialogAction !== 'accept' && dialogAction !== 'dismiss') {
        return {
          success: false,
          error: 'dialogAction=accept or dialogAction=dismiss is required',
          metadata: { code: 'SURFACE_POLICY_BLOCKED', userActionRequired: true },
        };
      }
      const pendingDialog = input.browserService.getDialogState(input.tabId);
      if (!pendingDialog.pending) {
        return {
          success: false,
          error: 'No paused browser dialog is available.',
          metadata: {
            code: 'SURFACE_DIALOG_BLOCKED',
            retryable: true,
            userActionRequired: true,
            browserDialogState: pendingDialog,
          },
        };
      }
      if (dialogPromptText !== undefined
        && (dialogAction !== 'accept' || pendingDialog.type !== 'prompt')) {
        return {
          success: false,
          error: 'dialogPromptText is only allowed when accepting a paused prompt dialog.',
          metadata: { code: 'SURFACE_POLICY_BLOCKED', userActionRequired: true },
        };
      }
      if (dialogAction === 'accept') {
        const approved = await input.context.requestPermission({
          type: 'dangerous_command',
          tool: 'browser_action.handle_dialog',
          forceConfirm: true,
          dangerLevel: 'danger',
          reason: '接受网页对话框可能确认支付、删除或授权，必须对当前动作显式批准。',
          details: {
            action: 'handle_dialog',
            dialogAction,
            hasPromptText: dialogPromptText !== undefined,
          },
        });
        if (!approved) {
          return {
            success: false,
            error: 'Browser dialog acceptance was not approved.',
            metadata: { code: 'SURFACE_APPROVAL_REQUIRED', userActionRequired: true },
          };
        }
      }
      const dialogState = await input.browserService.handleDialog(
        dialogAction,
        dialogPromptText,
        input.tabId,
      );
      return {
        success: true,
        output: `${dialogAction === 'accept' ? 'Accepted' : 'Dismissed'} the paused ${dialogState.type || 'browser'} dialog.`,
        metadata: {
          browserDialogState: {
            ...dialogState,
            handled: true,
            action: dialogAction,
          },
        },
      };
    }

    case 'read_clipboard': {
      const approved = await input.context.requestPermission({
        type: 'dangerous_command',
        tool: 'browser_action.read_clipboard',
        forceConfirm: true,
        dangerLevel: 'warning',
        reason: '读取当前浏览器来源的剪贴板状态可能接触敏感数据，必须显式批准。',
        details: { action: 'read_clipboard', returnMode: 'metadata_only' },
      });
      if (!approved) {
        return {
          success: false,
          error: 'Browser clipboard read was not approved.',
          metadata: { code: 'SURFACE_APPROVAL_REQUIRED', userActionRequired: true },
        };
      }
      const clipboard = await input.browserService.readClipboardMetadata(input.tabId);
      return {
        success: true,
        output: `Browser clipboard contains ${clipboard.textLength} text characters. Raw clipboard text was not persisted or returned.`,
        metadata: {
          browserClipboardState: {
            textAvailable: clipboard.textLength > 0,
            textLength: clipboard.textLength,
            returnMode: 'metadata_only',
            redactionStatus: 'redacted',
          },
        },
      };
    }

    case 'write_clipboard': {
      if (clipboardText === undefined) {
        return {
          success: false,
          error: 'clipboardText is required for write_clipboard',
          metadata: { code: 'SURFACE_POLICY_BLOCKED' },
        };
      }
      const approved = await input.context.requestPermission({
        type: 'command',
        tool: 'browser_action.write_clipboard',
        forceConfirm: true,
        dangerLevel: 'warning',
        reason: '写入浏览器剪贴板会替换当前剪贴板文本，必须显式批准。',
        details: { action: 'write_clipboard', textLength: clipboardText.length },
      });
      if (!approved) {
        return {
          success: false,
          error: 'Browser clipboard write was not approved.',
          metadata: { code: 'SURFACE_APPROVAL_REQUIRED', userActionRequired: true },
        };
      }
      await input.browserService.writeClipboard(clipboardText, input.tabId);
      return {
        success: true,
        output: `Wrote ${clipboardText.length} text characters to the browser clipboard.`,
        metadata: {
          browserClipboardState: {
            written: true,
            textLength: clipboardText.length,
            redactionStatus: 'redacted',
          },
        },
      };
    }

    default:
      return null;
  }
}
