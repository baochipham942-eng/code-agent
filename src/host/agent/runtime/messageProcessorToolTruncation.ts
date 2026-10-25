// ============================================================================
// handleTruncatedToolCalls — tool_use 响应的 max_tokens 截断恢复，从
// MessageProcessor.handleToolResponse 的 `if (response.truncated)` 块逐字搬出
// （N-MAXLINES-MINEFIELD-2-FU1-S1 降 god-file 行数）：动态 maxTokens 提升、
// write_file 截断警告、截断 bash heredoc 合成失败结果、通用 truncation-recovery 提示。
// 返回 'continue' = 截断路径已落账（调用方直接 return 它）；undefined = 无截断或
// 仅注入提示，调用方继续走普通工具执行链。
// ============================================================================

import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import type { ModelResponse } from '../../agent/loopTypes';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import { sanitizeToolCallsForHistory } from '../../agent/messageHandling/converter';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector.js';
import { MODEL_MAX_TOKENS, getModelMaxOutputTokens } from '../../../shared/constants';
import { generateTruncationWarning } from './truncationPrompts';
import { attachTurnQualityMetadata } from './turnQuality';

const logger = createLogger('MessageProcessor');

export async function handleTruncatedToolCalls(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  response: ModelResponse,
  toolCalls: ToolCall[],
): Promise<'continue' | undefined> {
  if (!response.truncated) return undefined;
  logger.warn('[AgentLoop] ⚠️ Tool call was truncated due to max_tokens limit!');
  logCollector.agent('WARN', 'Tool call truncated - content may be incomplete');

  // 提高 maxTokens 防止后续截断
  const currentMax = ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
  const boostedMax = Math.max(currentMax, getModelMaxOutputTokens(ctx.modelConfig.model));
  if (boostedMax > currentMax) {
    ctx.modelConfig.maxTokens = boostedMax;
    logger.info(`[AgentLoop] Tool truncation: boosted maxTokens ${currentMax} → ${boostedMax}`);
  }

  const writeFileCall = toolCalls.find((tc: ToolCall) =>
    tc.name === 'write_file' ||
    tc.name === 'Write' ||
    tc.name === 'append_file' ||
    tc.name === 'Append'
  );
  if (writeFileCall) {
    const content = writeFileCall.arguments?.content as string;
    if (content) {
      logger.warn(`${writeFileCall.name} content length: ${content.length} chars - may be truncated!`);
      contextAssembly.injectSystemMessage(generateTruncationWarning(), 'truncation-recovery');
    }
  } else {
    // 检测截断的 bash heredoc
    const truncatedBashHeredocs = toolCalls.filter((tc: ToolCall) =>
      (tc.name === 'bash' || tc.name === 'Bash') &&
      typeof tc.arguments?.command === 'string' &&
      /<<\s*['"]?\w+['"]?/.test(tc.arguments.command as string)
    );

    if (truncatedBashHeredocs.length > 0) {
      logger.warn(`[AgentLoop] Skipping ${truncatedBashHeredocs.length} truncated bash heredoc(s) to avoid SyntaxError`);

      const truncAssistantMsg: Message = {
        id: contextAssembly.generateId(),
        role: 'assistant',
        content: response.content || '',
        timestamp: Date.now(),
        toolCalls: sanitizeToolCallsForHistory(toolCalls),
        thinking: response.thinking,
        responsesOutput: response.responsesOutput,
        effortLevel: ctx.turn.effortLevel,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        metadata: attachTurnQualityMetadata(ctx, undefined, response),
      };
      await contextAssembly.addAndPersistMessage(truncAssistantMsg);
      ctx.onEvent({ type: 'message', data: truncAssistantMsg });

      const syntheticResults: ToolResult[] = toolCalls.map((tc: ToolCall) => ({
        toolCallId: tc.id,
        success: false,
        output: '',
        error: (tc.name === 'bash' || tc.name === 'Bash') && /<<\s*['"]?\w+['"]?/.test((tc.arguments?.command as string) || '')
          ? '⚠️ 此 bash heredoc 命令因 max_tokens 截断而不完整，已跳过执行以避免 SyntaxError。请重新生成完整命令。'
          : '⚠️ 此工具调用因同批次存在截断的 heredoc 而被跳过。',
        duration: 0,
      }));

      const toolMsg: Message = {
        id: contextAssembly.generateId(),
        role: 'tool',
        content: JSON.stringify(syntheticResults),
        timestamp: Date.now(),
        toolResults: syntheticResults,
      };
      await contextAssembly.addAndPersistMessage(toolMsg);

      contextAssembly.injectSystemMessage(
        `<truncation-recovery>\n` +
        `上一次的 bash 命令包含 heredoc（<<EOF...EOF），但因 max_tokens 限制被截断，命令不完整。\n` +
        `已跳过执行以避免 SyntaxError。请重新生成完整的命令。\n` +
        `提示：如果内联脚本很长，考虑先用 write_file 写入临时文件再用 bash 执行，而不是使用 heredoc。\n` +
        `</truncation-recovery>`,
        'truncation-recovery',
      );

      return 'continue';
    }

    contextAssembly.injectSystemMessage(
      `<truncation-recovery>\n` +
      `上一次输出因 max_tokens 限制被截断。请继续完成未完成的操作。\n` +
      `</truncation-recovery>`,
      'truncation-recovery',
    );
  }
  return undefined;
}
