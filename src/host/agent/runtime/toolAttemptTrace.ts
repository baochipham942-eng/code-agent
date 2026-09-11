import type { ToolCall, ToolResult } from '../../../shared/contract';
import { extractWorkbenchReferenceFromToolCall } from '../../../shared/contract/workbenchTools';
import { resolve } from 'node:path';
import { redactSecrets } from '../../security/secretRedaction';
import type { RuntimeContext } from './runtimeContext';

class ToolAttemptTrace {
  consecutiveErrors = 0;
  noProgressStopped = false;
  private failures = new Map<string, string[]>();
  constructor(private readonly ctx: RuntimeContext) {}

  reset(): void { this.consecutiveErrors = 0; this.noProgressStopped = false; this.failures.clear(); }

  begin(call: ToolCall): void {
    this.ctx.turnTrace?.record('tool_attempt', { toolCallId: call.id, toolName: call.name });
  }

  finish(call: ToolCall, result: ToolResult, dispatched: boolean, durationMs: number): void {
    const stopReason = this.ctx.control?.forceFinalResponseReason ?? '';
    // 'evidence boundary repeated' 已随证据边界改记录式而没有产生方，从这条正则里摘掉。
    if (/^(artifact repair attempts exhausted:|artifact repair unavailable tool repeated:)/.test(stopReason)) this.noProgressStopped = true;
    const cancelled = result.metadata?.cancelledByRun === true;
    const skipped = result.metadata?.skipped === true || result.metadata?.autoLoaded === true;
    const rejected = !dispatched || result.metadata?.permissionDecision === 'deny'
      || result.metadata?.blocked === true
      || (typeof result.metadata?.code === 'string' && result.metadata.code.startsWith('PERMISSION_DENIED'));
    if (!cancelled && !skipped) this.consecutiveErrors = result.success ? 0 : this.consecutiveErrors + 1;
    // Recovery needs the same operation and full canonical locator, never a basename/title match.
    const rawPath = call.arguments.file_path ?? call.arguments.path;
    const target = typeof rawPath === 'string' ? `${call.name}:${resolve(this.ctx.workingDirectory || '.', rawPath)}` : undefined;
    const recoveredFrom = result.success && target ? this.failures.get(target) : undefined;
    if (target && result.success) this.failures.delete(target);
    else if (target && !cancelled && !skipped) this.failures.set(target, [...(this.failures.get(target) ?? []), call.id]);
    this.ctx.turnTrace?.record('tool_dispatch', {
      toolCallId: call.id, toolName: call.name,
      toolAction: extractWorkbenchReferenceFromToolCall(call)?.action ?? null,
      stage: dispatched ? 'executor' : 'preflight',
      execution: result.metadata?.fromCache === true ? 'cache_hit'
        : result.metadata?.executionStarted === true ? 'executed'
        : !dispatched || result.metadata?.executionStarted === false ? 'not_executed' : 'unknown',
      outcome: cancelled ? 'cancelled' : skipped ? 'skipped' : result.success ? 'succeeded' : rejected ? 'rejected' : 'failed',
      success: result.success, durationMs,
      error: result.error ? redactSecrets(result.error) : null,
      fromCache: result.metadata?.fromCache === true,
      consecutiveErrors: this.consecutiveErrors,
      ...(recoveredFrom?.length ? { recoveredFrom } : {}),
    });
  }
}

const traces = new WeakMap<RuntimeContext, ToolAttemptTrace>();
export function getToolAttemptTrace(ctx: RuntimeContext): ToolAttemptTrace {
  let trace = traces.get(ctx);
  if (!trace) { trace = new ToolAttemptTrace(ctx); traces.set(ctx, trace); }
  return trace;
}
