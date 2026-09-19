import type { ToolCall, ToolResult } from '../../../shared/contract';
import { AgentFailureCode } from '../../../shared/contract';
import { extractWorkbenchReferenceFromToolCall } from '../../../shared/contract/workbenchTools';
import { resolve } from 'node:path';
import { redactSecrets } from '../../security/secretRedaction';
import type { RuntimeContext } from './runtimeContext';

/** AskUserQuestion 自身是 execute + requiresPermission:false，冻结期内仍允许再问。 */
export function shouldFreezeNonReadWhileAwaitingUser(
  awaitingUserInput: boolean,
  definition: { permissionLevel?: string; requiresPermission?: boolean } | null | undefined,
): boolean {
  return awaitingUserInput
    && definition?.permissionLevel !== 'read'
    && definition?.requiresPermission !== false;
}

const AWAITING_USER_BLOCKED_ERROR = '<awaiting-user-input>\n'
  + '上一条 AskUserQuestion 没有得到用户回答（无头环境按无用户响应处理）。\n'
  + '本轮禁止创建、修改、删除文件以及其它执行类操作。\n'
  + '请基于当前已知信息给出分析与建议并结束本轮，等待用户下一步指示。\n'
  + '</awaiting-user-input>';

export const AWAITING_USER_FREEZE_NOTICE = '<awaiting-user-input-freeze>\n'
  + '上一条 AskUserQuestion 在无头环境里没有得到用户回答。在本轮结束、用户给出下一步指示之前，'
  + '创建/修改/删除/执行类工具一律被引擎拦截；只读分析与 AskUserQuestion 本身不受影响。\n'
  + '请基于当前已知信息给出分析与建议并结束本轮。\n'
  + '</awaiting-user-input-freeze>';

export function buildAwaitingUserBlockedResult(toolCallId: string, duration: number): ToolResult {
  return {
    toolCallId,
    success: false,
    error: AWAITING_USER_BLOCKED_ERROR,
    duration,
    metadata: {
      blocked: true,
      awaitingUserInput: true,
      executionStarted: false,
      failureCode: AgentFailureCode.PermissionDenied,
    },
  };
}

class ToolAttemptTrace {
  consecutiveErrors = 0;
  noProgressStopped = false;
  /** 本 run 内已有 AskUserQuestion 无人应答（无头回退），问句未答冻结生效中。 */
  awaitingUserInput = false;
  private failures = new Map<string, string[]>();
  constructor(private readonly ctx: RuntimeContext) {}

  reset(): void { this.consecutiveErrors = 0; this.noProgressStopped = false; this.awaitingUserInput = false; this.failures.clear(); }

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
    if (result.metadata?.awaitingUserInput === true) this.awaitingUserInput = true;
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
      ...(typeof result.metadata?.sandboxed === 'boolean' ? { sandboxed: result.metadata.sandboxed } : {}),
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
