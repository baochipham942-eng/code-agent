import { getBackgroundSubagentRegistry } from './backgroundSubagentRegistry';
import type { SubagentEventPort, SubagentExecutionContext } from './subagentExecutorTypes';

/** 复制 events，标上后台 durable run id。父工具的 emit/progress 原样转发。 */
export function withBackgroundDurableAgentId(events: SubagentEventPort, agentId: string): SubagentEventPort {
  return {
    emit: (event, data) => events.emit(event, data),
    progress: (stage, detail, percent) => events.progress?.(stage, detail, percent),
    backgroundDurableAgentId: agentId,
  };
}

/**
 * 子代理每轮结束时调用。lastProgress 取已产出的助手正文，否则取最近一次工具名
 * （与 tool_call_start 发出的标签同一来源）。没有后台账本条目时直接返回。
 * 任何失败都吞掉，不能打断子代理。
 */
export function noteSubagentLiveProgress(
  context: SubagentExecutionContext,
  executionAgentId: string,
  getTotalCost: () => number,
  getTotalTokens: () => number,
  getIterations: () => number,
  getToolCalls: () => number,
  getAssistantText: () => string,
  toolsUsed: readonly string[],
): void {
  try {
    const durableAgentId = context.events.backgroundDurableAgentId;
    const agentId = durableAgentId ?? executionAgentId;
    const registry = getBackgroundSubagentRegistry();
    if (!durableAgentId && registry.getStatus(agentId)?.status !== 'running') return;
    const assistantText = getAssistantText().trim();
    const latestTool = toolsUsed.at(-1);
    const lastProgress = assistantText || latestTool;
    registry.noteLiveProgress(agentId, {
      cost: getTotalCost(),
      tokensUsed: getTotalTokens(),
      iterations: getIterations(),
      toolCalls: getToolCalls(),
      ...(lastProgress ? { lastProgress } : {}),
    });
  } catch {
    // 记账失败只影响重启后的通知，不能打断子代理。
  }
}
