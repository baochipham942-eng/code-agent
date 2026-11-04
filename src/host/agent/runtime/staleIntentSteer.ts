import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';
import { sanitizeToolResultsForHistoryWithCalls } from '../../agent/messageHandling/converter';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from '../../services/infra/logger';
import { classifyExecutionPhase } from '../../tools/executionPhase';
import type { RuntimeContext } from './runtimeContext';
import { classifyToolAttemptOutcome, toolAttemptOutcomeWord } from './toolAttemptTrace';

const logger = createLogger('MessageProcessor');

const VOID_NOTICE = '此前的工具结果属于用户刚刚换掉的计划，不要继续执行那个计划，按用户的新消息来。';

type SteerContextAssembly = {
  generateId(): string;
  addAndPersistMessage(message: Message): Promise<unknown>;
  pushPersistentSystemContext(content: string, source: ContextInjectionSource): void;
};

export async function settleSteerDuringToolExecution(input: {
  ctx: RuntimeContext;
  contextAssembly: SteerContextAssembly;
  toolResults: ToolResult[];
  toolCalls: ToolCall[];
  applyDeferredSkillActivations: (results: ToolResult[]) => void;
}): Promise<void> {
  const { ctx, contextAssembly, toolResults, toolCalls, applyDeferredSkillActivations } = input;
  logger.info('[AgentLoop] Steer detected during tool execution — saving results and re-inferring');
  if (toolResults.length > 0) {
    const partialResults = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls).map((result) => ({
      ...result,
      metadata: { ...(result.metadata ?? {}), staleIntent: true },
    }));
    const partialToolMessage: Message = {
      id: contextAssembly.generateId(),
      role: 'tool',
      content: JSON.stringify(partialResults),
      timestamp: Date.now(),
      toolResults: partialResults,
    };
    await contextAssembly.addAndPersistMessage(partialToolMessage);
    applyDeferredSkillActivations(toolResults);
  }
  contextAssembly.pushPersistentSystemContext(VOID_NOTICE, 'runtime-recovery');
  for (const result of toolResults) {
    const matched = toolCalls.find((call) => call.id === result.toolCallId);
    const phase = matched ? classifyExecutionPhase(matched.name) : undefined;
    // ToolResult 没有 dispatched。executionStarted === false 表示没派发出去；缺省按已派发。
    const dispatched = result.metadata?.executionStarted !== false;
    const outcome = classifyToolAttemptOutcome(result, dispatched);
    const level = outcome === 'failed' || outcome === 'rejected' ? 'ERROR' : 'INFO';
    logCollector.tool(level, `Tool result: ${toolAttemptOutcomeWord(outcome)}`, {
      toolCallId: result.toolCallId,
      phase,
    });
  }
  ctx.onEvent({
    type: 'interrupt_acknowledged',
    data: { message: '已收到新指令，正在调整方向...' },
  });
}
