import type { Message } from '../../../../shared/contract';
import { formatToolCallForHistory } from '../../../agent/messageHandling/converter';
import type { ModelMessage } from '../../../agent/loopTypes';

/**
 * Project one durable ledger message into the model-message shapes that can be
 * recovered from that message alone. Runtime filters, attachments, compaction,
 * and post-assembly rewrites intentionally stay outside this function; callers
 * must fall back to a content ref when the emitted request differs.
 */
export function projectLedgerMessage(message: Message): ModelMessage[] {
  if (message.attachments?.length) return [];

  if (message.role === 'tool' && message.toolResults?.length) {
    return message.toolResults.map((result) => ({
      role: 'tool',
      content: result.output || result.error || '',
      ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}),
      ...(!result.success ? { toolError: true } : {}),
    }));
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return [{
      role: 'assistant',
      content: message.content || '',
      toolCalls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
      toolCallText: message.toolCalls.map((call) => formatToolCallForHistory(call)).join('\n'),
      thinking: message.thinking,
      ...(message.responsesOutput ? { responsesOutput: message.responsesOutput } : {}),
    }];
  }

  return [{
    role: message.role,
    content: message.content,
    ...(message.responsesOutput ? { responsesOutput: message.responsesOutput } : {}),
  }];
}
