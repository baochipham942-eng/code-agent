/**
 * ADR-041 M4 — shared finalizer for managed/relay browser_action results:
 * pointer + proof + redaction + ledger persistence.
 */
import type { ToolContext, ToolExecutionResult } from '../types';
import { attachBrowserActionProof } from '../../../shared/utils/browserComputerRedaction';
import { buildAgentPointerEventFromToolCall } from '../../../shared/utils/agentPointer';
import { persistBrowserComputerProofFromResult } from '../../session/browserComputerProofStore';
import { redactBrowserWorkbenchTraceParams } from '../../services/infra/browser/managedBrowserHelpers';
import type { BrowserEngineRecovery, BrowserEngineRouteDecision } from '../../../shared/contract/desktop';
import { surfaceProofService } from '../../services/surfaceExecution/SurfaceProofService';

export interface BrowserActionTraceLike {
  id: string;
  targetKind: 'browser';
  toolName: string;
  action: string;
  params: Record<string, unknown>;
  startedAtMs: number;
  completedAtMs?: number | null;
  success?: boolean | null;
  error?: string | null;
  provider?: string | null;
  mode?: string | null;
  screenshotPath?: string | null;
  agentPointerEvent?: unknown;
}

function createSyntheticTrace(args: {
  action: string;
  params: Record<string, unknown>;
  success: boolean;
  error?: string | null;
  provider?: string | null;
}): BrowserActionTraceLike {
  const now = Date.now();
  return {
    id: `browser_trace_${now.toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
    targetKind: 'browser',
    toolName: 'browser_action',
    action: args.action,
    params: redactBrowserWorkbenchTraceParams('browser_action', args.params || {}),
    startedAtMs: now,
    completedAtMs: now,
    success: args.success,
    error: args.error || null,
    provider: args.provider || null,
    mode: args.provider === 'browser-relay' ? 'relay' : 'managed',
  };
}

function scrubResultMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const next = { ...metadata };
  // Never leave raw base64 screenshot blobs in tool metadata.
  if (typeof next.screenshotBase64 === 'string') {
    next.screenshotBase64 = '[redacted]';
  }
  if (typeof next.data === 'string' && next.data.length > 200 && /^[A-Za-z0-9+/=]+$/.test(next.data.slice(0, 80))) {
    next.data = '[redacted-binary]';
  }
  if (next.authToken) next.authToken = '[redacted]';
  if (next.token) next.token = '[redacted]';
  if (next.cookies) next.cookies = '[redacted]';
  if (next.cookie) next.cookie = '[redacted]';
  // ADR-041 P1: never leave import/export seed arrays or raw cookie rows in tool metadata.
  if (next.seeds) next.seeds = '[redacted]';
  if (next.cookieSeeds) next.cookieSeeds = '[redacted]';
  if (next.cookieRows) next.cookieRows = '[redacted]';
  if (next.storageState) next.storageState = '[redacted]';
  return next;
}

function hasRawBase64Image(metadata: Record<string, unknown>): boolean {
  return ['imageBase64', 'imageDataUrl', 'base64Image', 'image_base64', 'screenshotBase64']
    .some((key) => typeof metadata[key] === 'string');
}

function attachSurfaceProof(
  result: ToolExecutionResult,
  input: {
    action: string;
    context?: ToolContext;
    sessionId?: string;
    runId?: string;
    turnId?: string;
    agentId?: string;
    toolCallId?: string;
  },
): ToolExecutionResult {
  return surfaceProofService.finalizeToolResult({
    toolName: 'browser_action',
    action: input.action,
    result,
    surface: 'browser',
    identity: {
      conversationId: input.context?.sessionId || input.sessionId,
      runId: input.context?.runId || input.runId,
      turnId: input.context?.turnId || input.turnId,
      agentId: input.context?.agentId || input.agentId,
      operationId: input.context?.currentToolCallId || input.toolCallId,
    },
  });
}

export function finalizeBrowserActionResult(args: {
  result: ToolExecutionResult;
  action: string;
  params: Record<string, unknown>;
  context?: ToolContext;
  /** Real managed-browser workbench trace when available. */
  trace?: BrowserActionTraceLike | null;
  provider?: string | null;
  engineRoute?: BrowserEngineRouteDecision | null;
  recovery?: BrowserEngineRecovery | null;
  notes?: Array<string | null | undefined>;
}): ToolExecutionResult {
  const provider = args.provider
    || (typeof args.result.metadata?.provider === 'string' ? args.result.metadata.provider : null)
    || (args.engineRoute?.selectedEngine === 'relay' ? 'browser-relay' : 'system-chrome-cdp');

  const baseTrace = args.trace || createSyntheticTrace({
    action: args.action,
    params: args.params,
    success: args.result.success !== false,
    error: args.result.error || null,
    provider,
  });

  const metadata = scrubResultMetadata({
    ...(args.result.metadata || {}),
    provider,
    engine: args.engineRoute?.selectedEngine || (provider === 'browser-relay' ? 'relay' : 'managed'),
    engineRoute: args.engineRoute || args.result.metadata?.engineRoute || null,
    recovery: args.recovery || args.result.metadata?.recovery || null,
  });

  const pointerEvent = buildAgentPointerEventFromToolCall({
    id: baseTrace.id,
    name: 'browser_action',
    arguments: {
      action: args.action,
      ...args.params,
    },
    result: {
      success: args.result.success,
      error: args.result.error,
      metadata: {
        ...metadata,
        traceId: baseTrace.id,
        workbenchTrace: baseTrace,
      },
    },
  });

  const safeTrace = {
    ...baseTrace,
    provider,
    params: redactBrowserWorkbenchTraceParams('browser_action', baseTrace.params || {}),
    agentPointerEvent: pointerEvent,
  };

  const resultWithPointer: ToolExecutionResult = {
    ...args.result,
    metadata: {
      ...metadata,
      traceId: safeTrace.id,
      workbenchTrace: safeTrace,
      agentPointerEvent: pointerEvent,
    },
  };
  const deferProofPersistence = hasRawBase64Image(resultWithPointer.metadata || {});
  let resultWithProof = deferProofPersistence
    ? {
        ...resultWithPointer,
        metadata: {
          ...(resultWithPointer.metadata || {}),
          browserComputerProofPersistenceDeferred: true,
        },
      }
    : attachSurfaceProof(attachBrowserActionProof(resultWithPointer, safeTrace), {
        action: args.action,
        context: args.context,
      });

  const notes = (args.notes || []).filter((note): note is string => typeof note === 'string' && note.trim().length > 0);
  if (notes.length > 0) {
    const noteBlock = notes.map((note) => `Workbench: ${note}`).join('\n');
    resultWithProof = {
      ...resultWithProof,
      output: resultWithProof.output
        ? `${resultWithProof.output}\n\n${noteBlock}`
        : noteBlock,
    };
  }

  if (!deferProofPersistence) {
    persistBrowserComputerProofFromResult(resultWithProof, {
      sessionId: args.context?.sessionId,
      toolCallId: args.context?.currentToolCallId,
      toolName: 'browser_action',
    });
  }

  return resultWithProof;
}

export function finalizeDeferredBrowserActionProof(
  result: ToolExecutionResult,
  input: {
    sessionId?: string;
    runId?: string;
    turnId?: string;
    agentId?: string;
    toolCallId?: string;
  },
): ToolExecutionResult {
  if (result.metadata?.browserComputerProofPersistenceDeferred !== true) return result;
  const trace = result.metadata.workbenchTrace;
  const action = trace && typeof trace === 'object' && typeof (trace as BrowserActionTraceLike).action === 'string'
    ? (trace as BrowserActionTraceLike).action
    : 'unknown';
  const resultWithProof = attachSurfaceProof(attachBrowserActionProof({
    ...result,
    metadata: {
      ...(result.metadata || {}),
      browserComputerProofPersistenceDeferred: false,
    },
  }, trace && typeof trace === 'object'
    ? trace as BrowserActionTraceLike
    : { id: typeof result.metadata.traceId === 'string' ? result.metadata.traceId : null }), {
    action,
    ...input,
  });
  persistBrowserComputerProofFromResult(resultWithProof, {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: 'browser_action',
  });
  return resultWithProof;
}
