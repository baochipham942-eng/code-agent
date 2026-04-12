// ============================================================================
// Projectable model messages - shared model-input expansion for runtime + IPC
// ============================================================================

import type { Message, MessageAttachment, ToolCall } from '../../shared/contract';
import type { ContextInterventionSnapshot } from '../../shared/contract/contextView';
import type { ModelMessage } from '../model/types';
import { buildMultimodalContent, formatToolCallForHistory } from '../agent/messageHandling/converter';
import type { ProjectableMessage } from './projectionEngine';

const REMOVED_TOOLS = new Set(['TodoWrite', 'todo_write']);

export interface ProjectableModelMessage extends ProjectableMessage {
  sourceMessageId: string;
  originalRole: Message['role'];
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolError?: boolean;
  thinking?: string;
}

export function buildProjectableModelMessages(messages: Message[]): ProjectableModelMessage[] {
  const projectable: ProjectableModelMessage[] = [];

  for (const message of messages) {
    if (message.role === 'tool' && message.toolResults?.length) {
      message.toolResults.forEach((result, index) => {
        projectable.push({
          id: `${message.id}::tool-result::${result.toolCallId || index}`,
          sourceMessageId: message.id,
          originalRole: message.role,
          role: 'tool',
          content: result.output || result.error || '',
          toolCallId: result.toolCallId,
          toolError: !result.success,
        });
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolCalls = message.toolCalls.filter((toolCall) => !REMOVED_TOOLS.has(toolCall.name));
      if (toolCalls.length === 0 && !message.content) continue;
      projectable.push({
        id: message.id,
        sourceMessageId: message.id,
        originalRole: message.role,
        role: 'assistant',
        content: message.content || '',
        toolCalls,
        thinking: message.thinking,
      });
      continue;
    }

    projectable.push({
      id: message.id,
      sourceMessageId: message.id,
      originalRole: message.role,
      role: message.role,
      content: message.content || '',
      attachments: message.attachments,
      thinking: message.thinking,
    });
  }

  return projectable;
}

export function expandInterventionsToProjectableMessages(
  interventions: ContextInterventionSnapshot,
  messages: ProjectableModelMessage[],
): ContextInterventionSnapshot {
  const messageIdsBySourceId = new Map<string, string[]>();

  for (const message of messages) {
    const ids = messageIdsBySourceId.get(message.sourceMessageId) || [];
    ids.push(message.id);
    messageIdsBySourceId.set(message.sourceMessageId, ids);
  }

  const expand = (ids: string[]) => ids.flatMap((id) => messageIdsBySourceId.get(id) || []);

  return {
    pinned: expand(interventions.pinned),
    excluded: expand(interventions.excluded),
    retained: expand(interventions.retained),
  };
}

function buildAssistantMessage(message: ProjectableModelMessage): ModelMessage {
  const toolCalls = message.toolCalls || [];

  return {
    role: 'assistant',
    content: message.content,
    ...(toolCalls.length > 0
      ? {
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          })),
          toolCallText: toolCalls.map((toolCall) => formatToolCallForHistory(toolCall)).join('\n'),
        }
      : {}),
    thinking: message.thinking,
  };
}

export function materializeProjectedModelMessage(message: ProjectableModelMessage): ModelMessage {
  if (message.role === 'assistant' && message.originalRole === 'assistant') {
    return buildAssistantMessage(message);
  }

  if (message.role === 'tool' && message.originalRole === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolError === 'boolean' ? { toolError: message.toolError } : {}),
    };
  }

  if (
    message.role === 'user' &&
    message.originalRole === 'user' &&
    (message.attachments?.length ?? 0) > 0
  ) {
    return {
      role: 'user',
      content: buildMultimodalContent(message.content, message.attachments!),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}
