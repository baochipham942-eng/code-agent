import type { ToolCall, ToolResult } from '../../../shared/contract';
import { getLangfuseService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import {
  sanitizeToolArgumentsForObservation,
  sanitizeToolResultForObservation,
} from './toolObservationSanitizers';

const logger = createLogger('AgentLoop');

type HandleToolExecutionErrorArgs = {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  toolCall: ToolCall;
  error: unknown;
  startTime: number;
  langfuse: ReturnType<typeof getLangfuseService>;
  toolSpanId: string;
};

/**
 * executeSingleTool 末尾 catch 块的错误处理：cancellation 检查 → circuit breaker →
 * post-tool-failure hook → planning error hook → langfuse endSpan →
 * telemetry/onEvent/logging → 返回 errorResult。
 *
 * 从 executeSingleTool 抽取，行为保持不变。该块在 emitToolCallStart 已调用之后运行，
 * 不依赖 emitToolCallStart/emitBlockedToolResult 闭包，可安全抽取。
 * progressInterval 的 clearInterval 仍留在 engine catch 内（引用局部变量）。
 */
export async function handleToolExecutionError({
  ctx,
  contextAssembly,
  toolCall,
  error,
  startTime,
  langfuse,
  toolSpanId,
}: HandleToolExecutionErrorArgs): Promise<ToolResult> {
  const isRunCancelled = ctx.isCancelled || Boolean(ctx.runAbortController?.signal.aborted);
  if (isRunCancelled) {
    const suppressedResult: ToolResult = {
      toolCallId: toolCall.id,
      success: false,
      error: 'cancelled',
      duration: Date.now() - startTime,
      metadata: {
        cancelledByRun: true,
        suppressObservation: true,
      },
    };
    langfuse.endSpan(toolSpanId, {
      success: false,
      error: suppressedResult.error,
      duration: suppressedResult.duration,
    }, 'WARNING', 'cancelled');
    return suppressedResult;
  }

  logger.error(`Tool ${toolCall.name} threw exception:`, error);
  const toolResult: ToolResult = {
    toolCallId: toolCall.id,
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
    duration: Date.now() - startTime,
  };

  logger.debug(` Tool ${toolCall.name} failed with error: ${toolResult.error}`);

  // Circuit breaker tracking for exceptions
  if (ctx.circuitBreaker.recordFailure(toolResult.error)) {
    contextAssembly.injectSystemMessage(ctx.circuitBreaker.generateWarningMessage(toolResult.error));
    ctx.onEvent({
      type: 'error',
      data: {
        message: ctx.circuitBreaker.generateUserErrorMessage(toolResult.error),
        code: 'CIRCUIT_BREAKER_TRIPPED',
      },
    });
  }

  // User-configurable Post-Tool Failure Hook
  if (ctx.hookManager) {
    try {
      const toolInput = JSON.stringify(toolCall.arguments);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const userFailResult = await ctx.hookManager.triggerPostToolUseFailure(
        toolCall.name,
        toolInput,
        errorMessage,
        ctx.sessionId
      );

      if (userFailResult.message) {
        contextAssembly.injectSystemMessage(`<post-tool-failure-hook>\n${userFailResult.message}\n</post-tool-failure-hook>`);
      }
    } catch (hookError) {
      logger.error('[AgentLoop] User post-tool failure hook error:', hookError);
    }
  }

  // Planning Error Hook
  if (ctx.enableHooks && ctx.planningService) {
    try {
      const errorResult = await ctx.planningService.hooks.onError({
        toolName: toolCall.name,
        toolParams: toolCall.arguments,
        error: error instanceof Error ? error : new Error('Unknown error'),
      });

      if (errorResult.injectContext) {
        contextAssembly.injectSystemMessage(errorResult.injectContext);
      }
    } catch (hookError) {
      logger.error('Error hook error:', hookError);
    }
  }

  langfuse.endSpan(toolSpanId, {
    success: false,
    error: toolResult.error,
    duration: toolResult.duration,
  }, 'ERROR', toolResult.error);

  logger.debug(` Emitting tool_call_end for ${toolCall.name} (error)`);
  ctx.telemetryAdapter?.onToolCallEnd(ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined);
  ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
  // Tool execution logging (non-blocking)
  if (ctx.onToolExecutionLog && ctx.sessionId) {
    try {
      const safeToolResult = sanitizeToolResultForObservation(toolCall, toolResult);
      ctx.onToolExecutionLog({
        sessionId: ctx.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: sanitizeToolArgumentsForObservation(toolCall) as Record<string, unknown>,
        result: safeToolResult,
      });
    } catch {
      // Never let logging break tool execution
    }
  }

  return toolResult;
}
