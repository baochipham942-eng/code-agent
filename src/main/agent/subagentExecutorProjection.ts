// ============================================================================
// Subagent Executor Projection Helpers
// ============================================================================

import type { Message, MessageAttachment, ToolCall } from '../../shared/contract';
import type { SwarmAgentContextSnapshot } from '../../shared/contract/swarm';
import { getContextWindow } from '../../shared/constants';
import { getWarningLevel } from '../../shared/contract/contextHealth';
import { generateMessageId } from '../../shared/utils/id';
import type { ContextProvenanceCategory } from '../../shared/contract/contextView';
import { estimateTokens } from '../context/tokenEstimator';
import type { ModelMessage as ProviderModelMessage } from '../model/types';
import type { ModelRouter } from '../model/modelRouter';
import { normalizeImageData } from '../utils/imageUtils';

export interface SubagentAttachmentInput {
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}

export type MessageContent = {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

export type RuntimeMessage = {
  id: string;
  role: Message['role'];
  content: string | MessageContent[];
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  observation?: {
    category?: ContextProvenanceCategory;
    sourceDetail?: string;
    sourceKind?: 'message' | 'tool_result' | 'dependency_carry_over' | 'attachment' | 'compression_survivor' | 'system_anchor';
    layer?: string;
    toolCallId?: string;
  };
};

type ProjectionLogger = {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
};

export function flattenMessageContent(content: string | MessageContent[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part.type === 'text' && part.text) return part.text;
      if (part.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeAttachmentCategory(category?: string, type?: string): MessageAttachment['category'] {
  if (!category) {
    return type === 'image' ? 'image' : 'other';
  }
  const validCategories = new Set<MessageAttachment['category']>([
    'image',
    'pdf',
    'excel',
    'code',
    'text',
    'data',
    'document',
    'html',
    'folder',
    'other',
  ]);
  return validCategories.has(category as MessageAttachment['category'])
    ? category as MessageAttachment['category']
    : (type === 'image' ? 'image' : 'other');
}

export function buildMessageAttachments(
  attachments?: SubagentAttachmentInput[],
): MessageAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => ({
    id: `${Date.now()}-${index}-${attachment.name ?? 'attachment'}`,
    type: attachment.type === 'image' ? 'image' : 'file',
    category: normalizeAttachmentCategory(attachment.category, attachment.type),
    name: attachment.name || `attachment-${index + 1}`,
    size: attachment.data?.length ?? 0,
    mimeType: attachment.mimeType || 'application/octet-stream',
    data: attachment.data,
    path: attachment.path,
  }));
}

export function buildContextSnapshot(
  messages: RuntimeMessage[],
  model: string,
  toolsUsed: string[],
  attachments?: Array<{ name?: string }>,
): SwarmAgentContextSnapshot {
  const maxTokens = getContextWindow(model);
  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: flattenMessageContent(message.content),
  }));
  const currentTokens = normalizedMessages.reduce((sum, message) => (
    sum + 4 + estimateTokens(message.content)
  ), 3);
  const usagePercent = maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 1000) / 10 : 0;

  return {
    currentTokens,
    maxTokens,
    usagePercent,
    messageCount: normalizedMessages.length,
    warningLevel: getWarningLevel(usagePercent),
    lastUpdated: Date.now(),
    tools: [...new Set(toolsUsed)].slice(-6),
    attachments: [...new Set((attachments || []).map((attachment) => attachment.name).filter(Boolean) as string[])].slice(0, 6),
    previews: normalizedMessages.slice(-3).map((message) => ({
      role: message.role,
      contentPreview: message.content.length > 120
        ? `${message.content.slice(0, 120)}...`
        : message.content,
      tokens: estimateTokens(message.content),
    })),
    truncatedMessages: normalizedMessages.filter((message) => message.content.includes('[truncated]')).length,
  };
}

export function createRuntimeMessage(
  message: Omit<RuntimeMessage, 'id' | 'timestamp'> & Partial<Pick<RuntimeMessage, 'id' | 'timestamp'>>,
): RuntimeMessage {
  return {
    id: message.id || generateMessageId(),
    timestamp: message.timestamp || Date.now(),
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    toolCalls: message.toolCalls,
    observation: message.observation,
  };
}

export function materializeObservedMessages(messages: RuntimeMessage[]): Message[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: flattenMessageContent(message.content),
    attachments: message.attachments,
    toolCalls: message.toolCalls,
    timestamp: message.timestamp,
  }));
}

export function buildObservation(
  category: ContextProvenanceCategory,
  sourceDetail?: string,
  extras?: Partial<NonNullable<RuntimeMessage['observation']>>,
): NonNullable<RuntimeMessage['observation']> {
  return {
    category,
    sourceDetail,
    ...extras,
  };
}

export function buildInferenceMessages(messages: RuntimeMessage[]): ProviderModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          })),
          toolCallText: message.toolCalls
            .map((toolCall) => `Calling ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)
            .join('\n'),
        }
      : {}),
  }));
}

export function stringifyModelContent(content: ProviderModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image') return '[image]';
      if (part.type === 'thinking') return part.thinking || part.text || '';
      if (part.type === 'compaction') return part.compaction || part.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildModelPromptSummary(messages: ProviderModelMessage[]): string {
  return messages
    .slice(-3)
    .map((message) => `[${message.role}] ${stringifyModelContent(message.content)}`)
    .join('\n---\n')
    .slice(0, 8000);
}

export function buildModelCompletionSummary(response: Awaited<ReturnType<ModelRouter['inference']>>): string {
  let completion = response.content || response.thinking || '';
  if (response.toolCalls?.length) {
    const toolsSummary = response.toolCalls
      .map((toolCall) => `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`)
      .join('; ');
    completion += `${completion ? '\n' : ''}[tools: ${toolsSummary}]`;
  }
  return completion.slice(0, 4000);
}

export function buildInitialSubagentMessages(options: {
  agentName: string;
  systemPrompt: string;
  prompt: string;
  attachments?: SubagentAttachmentInput[];
  logger?: ProjectionLogger;
}): RuntimeMessage[] {
  const { agentName, systemPrompt, prompt, attachments, logger } = options;
  const isDependencySystemPrompt = /fork context|shared discoveries|shared context|dependency|carry-over/i.test(systemPrompt);
  const messages: RuntimeMessage[] = [
    createRuntimeMessage({
      role: 'system',
      content: systemPrompt,
      observation: buildObservation(
        isDependencySystemPrompt ? 'dependency_carry_over' : 'system_anchor',
        'system_prompt',
        {
          sourceKind: isDependencySystemPrompt ? 'dependency_carry_over' : 'system_anchor',
          layer: 'system_prompt',
        },
      ),
    }),
  ];

  const imageAttachments = attachments?.filter(
    (attachment) => attachment.type === 'image' || attachment.category === 'image',
  ) || [];

  if (imageAttachments.length > 0) {
    const multimodalContent: MessageContent[] = [{ type: 'text', text: prompt }];
    let successCount = 0;

    for (const image of imageAttachments) {
      const normalized = normalizeImageData(image.data, image.path, image.mimeType);

      if (normalized) {
        multimodalContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalized.mimeType,
            data: normalized.base64,
          },
        });
        successCount++;

        if (normalized.path || image.path) {
          multimodalContent.push({
            type: 'text',
            text: `📍 图片文件路径: ${normalized.path || image.path}`,
          });
        }

        logger?.debug(`[${agentName}] Added image`, {
          mimeType: normalized.mimeType,
          dataLength: normalized.base64.length,
          path: normalized.path,
        });
      } else {
        logger?.warn(`[${agentName}] Failed to normalize image data`, {
          hasData: !!image.data,
          dataLength: image.data?.length,
          path: image.path,
        });
      }
    }

    messages.push(createRuntimeMessage({
      role: 'user',
      content: multimodalContent,
      attachments: buildMessageAttachments(attachments),
      observation: buildObservation(
        'attachment',
        imageAttachments[0]?.name || 'user_prompt',
        {
          sourceKind: 'attachment',
          layer: 'attachment_input',
        },
      ),
    }));
    logger?.info(`[${agentName}] Built multimodal message with ${successCount}/${imageAttachments.length} images`);
    return messages;
  }

  messages.push(createRuntimeMessage({
    role: 'user',
    content: prompt,
    attachments: buildMessageAttachments(attachments),
    observation: buildObservation(
      attachments?.length ? 'attachment' : 'recent_turn',
      attachments?.[0]?.name || 'user_prompt',
      {
        sourceKind: attachments?.length ? 'attachment' : 'message',
        layer: attachments?.length ? 'attachment_input' : 'user_turn',
      },
    ),
  }));
  return messages;
}
