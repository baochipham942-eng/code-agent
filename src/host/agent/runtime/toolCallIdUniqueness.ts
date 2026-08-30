// ============================================================================
// ToolCall ID 唯一性护栏
//
// 弱模型（实测 glm-5.3-flash）会在同一批次、甚至每一轮都重复发同一个
// toolCallId（如永远叫 "call_1"）。下游路由/投影/遥测/导出全部以 toolCallId
// 为 Map 键（transcriptProjector / messageHydration / telemetryCollector /
// completionSummaryService / transcriptReplayBuilder），同 id 后写覆盖前写——
// 表现就是「Bash 的 tool_result 被另一条同 id 调用的错误结果替换」。
//
// 在入口（handleToolResponse）把重复 id 改写为全局唯一，让所有按 id 配对的
// 下游回到正确语义。改写只发生在入口一处，assistant 消息落库、工具执行、
// 结果回填用的是同一份 toolCalls，配对天然一致。
// ============================================================================

import type { Message, ToolCall } from '../../../shared/contract';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentLoop');

export interface ToolCallIdRewrite {
  toolName: string;
  from: string;
  to: string;
}

function collectHistoricalToolCallIds(messages: readonly Message[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const message of messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      if (call.id) ids.add(call.id);
    }
    for (const result of message.toolResults ?? []) {
      if (result.toolCallId) ids.add(result.toolCallId);
    }
  }
  return ids;
}

/**
 * 保证本批 toolCalls 的 id 在「批次内 + 本会话历史」全局唯一。
 * 无重复时原样返回（零开销路径）；有重复时返回改写后的新数组与改写记录。
 */
export function ensureUniqueToolCallIds(
  toolCalls: ToolCall[],
  messages: readonly Message[] | undefined,
): { toolCalls: ToolCall[]; rewrites: ToolCallIdRewrite[] } {
  if (toolCalls.length === 0) return { toolCalls, rewrites: [] };

  const seen = collectHistoricalToolCallIds(messages);
  const rewrites: ToolCallIdRewrite[] = [];
  const out = toolCalls.map((call) => {
    let id = call.id;
    if (!id || seen.has(id)) {
      const base = id || 'call';
      let candidate = `${base}::dedup-${seen.size}`;
      while (seen.has(candidate)) {
        candidate = `${candidate}x`;
      }
      rewrites.push({ toolName: call.name, from: id, to: candidate });
      id = candidate;
    }
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });

  if (rewrites.length > 0) {
    logger.warn('[AgentLoop] Duplicate/empty toolCallIds from model rewritten to unique ids', {
      rewrites,
    });
  }
  return { toolCalls: out, rewrites };
}
