import { createHash } from 'node:crypto';
import type { PermissionRequestData } from './types';
import { getTelemetryService } from '../telemetry/telemetryService';

function findToolSpan(toolCallId?: string) {
  return toolCallId
    ? getTelemetryService().findActiveSpanByAttribute('tool.call_id', toolCallId)
    : undefined;
}

export function annotateToolExecution(input: {
  toolCallId?: string;
  toolName: string;
  permissionClass: string;
  runId?: string;
  bridged: boolean;
}): void {
  try {
    const toolSpan = findToolSpan(input.toolCallId);
    if (!toolSpan) return;
    getTelemetryService().updateSpan(toolSpan.spanId, {
      'tool.source': input.bridged
        ? 'bridge'
        : /^mcp(__|_)/i.test(input.toolName) ? 'mcp' : 'protocol',
      'tool.permission_class': input.permissionClass,
      'tool.idempotency_key_digest': createHash('sha256')
        .update(`${input.runId ?? 'background'}:${input.toolCallId}`)
        .digest('hex')
        .slice(0, 24),
    });
  } catch {
    // Trace annotation is best-effort and never changes tool execution.
  }
}

export async function requestPermissionWithTelemetry(input: {
  request: PermissionRequestData;
  toolCallId?: string;
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
}): Promise<boolean> {
  let approvalSpanId: string | undefined;
  try {
    const toolSpan = findToolSpan(input.toolCallId);
    const approvalSpan = getTelemetryService().startSpan(
      'approval:tool',
      'approval',
      {
        'approval.kind': input.request.type,
        'approval.state': 'waiting',
      },
      toolSpan?.spanId,
    );
    approvalSpanId = approvalSpan.spanId;
    getTelemetryService().addSpanEvent(approvalSpan.spanId, 'approval.waiting');
  } catch {
    // Approval tracing is diagnostic only.
  }

  let approved: boolean;
  try {
    approved = await input.requestPermission(input.request);
  } catch (error) {
    try {
      if (approvalSpanId) {
        getTelemetryService().endSpan(approvalSpanId, 'error', { 'approval.state': 'failed' });
      }
    } catch {
      // Approval tracing must not replace the permission error.
    }
    throw error;
  }

  try {
    if (approvalSpanId) {
      getTelemetryService().addSpanEvent(
        approvalSpanId,
        approved ? 'approval.resolved' : 'approval.rejected',
      );
      getTelemetryService().endSpan(approvalSpanId, approved ? 'ok' : 'cancelled', {
        'approval.state': approved ? 'resolved' : 'rejected',
      });
    }
  } catch {
    // Approval tracing is diagnostic only.
  }
  return approved;
}

export function markToolCacheHit(toolCallId?: string): void {
  try {
    const toolSpan = findToolSpan(toolCallId);
    if (toolSpan) getTelemetryService().updateSpan(toolSpan.spanId, { 'tool.cache_hit': true });
  } catch {
    // Trace storage is best-effort.
  }
}
