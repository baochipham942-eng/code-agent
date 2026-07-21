/**
 * Browser Relay V2 high-level facade.
 *
 * Native tab/window/debugger ids never enter this API. All reads and writes
 * are routed through an owner-scoped Surface lease and the extension performs
 * a second owner/domain/action/expiry check before delivery.
 */
import type { ToolContext, ToolExecutionResult } from '../../../tools/types';
import { relayBrowserUploadApprovalRegistry } from './browserUploadApprovalRegistry';
import { getRelayBrowserProviderAdapter } from '../../surfaceExecution/RelayBrowserProviderAdapter';

export interface RelayActionParams {
  action: string;
  url?: string;
  selector?: string;
  targetRef?: unknown;
  destinationTargetRef?: unknown;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  fullPage?: boolean;
  formData?: Record<string, string>;
  width?: number;
  height?: number;
  timeout?: number;
  dialogAction?: 'accept' | 'dismiss';
  dialogPromptText?: string;
  relayUploadApprovalToken?: string;
  relayDomainScopes?: string[];
  relayActionScopes?: string[];
  relayLeaseTtlMs?: number;
}

const MANAGED_ONLY_ACTIONS = new Set([
  'set_viewport',
  'export_storage_state',
  'import_storage_state',
  'list_profiles',
  'import_profile_cookies',
  'clear_cookies',
  'wait_for_download',
  'read_clipboard',
  'write_clipboard',
]);

function fail(
  error: string,
  code: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult {
  return {
    success: false,
    error,
    metadata: {
      provider: 'browser-relay',
      engine: 'relay',
      code,
      ...metadata,
    },
  };
}

export async function executeRelayBrowserAction(
  params: RelayActionParams,
  context?: ToolContext,
): Promise<ToolExecutionResult> {
  if (MANAGED_ONLY_ACTIONS.has(params.action)) {
    const downloadDeferred = params.action === 'wait_for_download';
    return fail(
      downloadDeferred
        ? 'wait_for_download is unavailable on Relay because the extension transport cannot guarantee cancellation and partial-file cleanup; use engine=managed.'
        : `${params.action} is managed-engine only; use engine=managed.`,
      'SURFACE_CAPABILITY_UNSUPPORTED',
      downloadDeferred
        ? { deferReason: 'relay_download_cancel_cleanup_unavailable' }
        : {},
    );
  }
  const conversationId = context?.sessionId?.trim();
  const runId = context?.runId?.trim();
  const agentId = context?.agentId?.trim();
  const operationId = context?.currentToolCallId?.trim();
  if (!conversationId || !runId || !agentId || !operationId) {
    return fail(
      'Relay actions require explicit conversation, run, agent, and operation ownership.',
      'SURFACE_TARGET_NOT_OWNED',
    );
  }
  let adapterParams = params as unknown as Record<string, unknown>;
  if (params.action === 'upload_file') {
    const token = params.relayUploadApprovalToken?.trim();
    if (!token) {
      return fail(
        'Relay upload requires a one-time Host approval for the exact normalized file.',
        'SURFACE_APPROVAL_REQUIRED',
      );
    }
    try {
      const approved = relayBrowserUploadApprovalRegistry.consume({
        token,
        owner: { conversationId, runId, agentId, operationId },
      });
      const { relayUploadApprovalToken: _token, ...safeParams } = params;
      adapterParams = {
        ...safeParams,
        approvedUpload: {
          approvalRef: approved.approvalRef,
          ...approved.file,
        },
      };
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : 'Relay upload approval is invalid.',
        'SURFACE_APPROVAL_INVALID',
      );
    }
  }
  return await getRelayBrowserProviderAdapter().execute({
    identity: {
      conversationId,
      runId,
      ...(context?.turnId?.trim() ? { turnId: context.turnId.trim() } : {}),
      agentId,
      emitSurfaceEvent: (event) => context?.emit?.('surface_execution', event),
    },
    operationId,
    action: params.action,
    params: adapterParams,
    ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
  });
}
