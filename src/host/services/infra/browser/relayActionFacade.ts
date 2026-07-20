/**
 * Browser Relay V2 high-level facade.
 *
 * Native tab/window/debugger ids never enter this API. All reads and writes
 * are routed through an owner-scoped Surface lease and the extension performs
 * a second owner/domain/action/expiry check before delivery.
 */
import type { ToolContext, ToolExecutionResult } from '../../../tools/types';
import { getRelayBrowserProviderAdapter } from '../../surfaceExecution/RelayBrowserProviderAdapter';

export interface RelayActionParams {
  action: string;
  url?: string;
  selector?: string;
  targetRef?: unknown;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  fullPage?: boolean;
  formData?: Record<string, string>;
  width?: number;
  height?: number;
  timeout?: number;
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
  'upload_file',
  'wait_for_download',
]);

function fail(error: string, code: string): ToolExecutionResult {
  return {
    success: false,
    error,
    metadata: {
      provider: 'browser-relay',
      engine: 'relay',
      code,
    },
  };
}

export async function executeRelayBrowserAction(
  params: RelayActionParams,
  context?: ToolContext,
): Promise<ToolExecutionResult> {
  if (MANAGED_ONLY_ACTIONS.has(params.action)) {
    return fail(
      `${params.action} is managed-engine only; use engine=managed.`,
      'SURFACE_CAPABILITY_UNSUPPORTED',
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
  return await getRelayBrowserProviderAdapter().execute({
    identity: {
      conversationId,
      runId,
      agentId,
      emitSurfaceEvent: (event) => context?.emit?.('surface_execution', event),
    },
    operationId,
    action: params.action,
    params: params as unknown as Record<string, unknown>,
    ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
  });
}
