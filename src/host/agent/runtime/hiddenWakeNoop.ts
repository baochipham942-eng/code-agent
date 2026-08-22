// ============================================================================
// hiddenWakeNoop — 隐藏唤醒回合的「无话可说」终止（N-TASKWAKE）
// ============================================================================
// 后台任务终态唤醒前台 brain 时，模型若判断没有值得告诉用户的内容，会只调用
// wake_noop。这里把该回合的收尾（消息标 meta、关 span、发 turn_end）从
// messageProcessor 抽出来，避免那个文件顶破 god-file 红线。
// ============================================================================

import type { ToolCall, ToolResult } from '../../../shared/contract';
import { createLogger } from '../../services/infra/logger';
import { WAKE_NOOP_TOOL_NAME } from '../../services/commandCenter/foregroundWake';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';

const logger = createLogger('HiddenWakeNoop');

/** 只有在本 run 显式放行 wake_noop、且本轮唯一工具调用就是它时才算终止动作。 */
export function isTerminalWakeNoop(
  toolCalls: readonly ToolCall[],
  allowedToolNames: readonly string[] | undefined,
): boolean {
  return toolCalls.length === 1
    && toolCalls[0]?.name === WAKE_NOOP_TOOL_NAME
    && allowedToolNames?.includes(WAKE_NOOP_TOOL_NAME) === true;
}

export function finishHiddenWakeNoop(args: {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  langfuse: { endSpan(spanId: string, output?: unknown): void };
  toolResults: readonly ToolResult[];
  thinking?: string;
}): 'break' {
  const { ctx, contextAssembly, langfuse, toolResults, thinking } = args;
  contextAssembly.flushHookMessageBuffer();
  langfuse.endSpan(ctx.turn.currentIterationSpanId, {
    type: 'tool_calls',
    toolCount: 1,
    successCount: toolResults.filter((result) => result.success).length,
    wakeNoop: true,
  });
  ctx.telemetryAdapter?.onTurnEnd(
    ctx.turn.currentTurnId,
    '',
    thinking,
    ctx.contextHealth.currentSystemPromptHash,
  );
  ctx.onEvent({ type: 'turn_end', data: { turnId: ctx.turn.currentTurnId } });
  contextAssembly.updateContextHealth();
  logger.info('[AgentLoop] wake_noop ended hidden foreground wake without visible output');
  return 'break';
}
