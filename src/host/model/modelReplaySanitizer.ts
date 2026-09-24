import { createLogger } from '../services/infra/logger';
import type { ModelMessage, MessageContent } from './types';

const logger = createLogger('ModelReplaySanitizer');

const IMAGE_PLACEHOLDER = '[Image omitted: the current model cannot view images.]';

export interface ReplayModelCapabilities {
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export interface ReplaySanitizationResult {
  messages: ModelMessage[];
  imagePartsReplaced: number;
  reasoningPartsDropped: number;
}

function sanitizeResponsesOutput(
  output: unknown[],
): { output: unknown[]; dropped: number } {
  let dropped = 0;
  const sanitized = output.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [item];
    const record = item as Record<string, unknown>;
    if (record.type === 'reasoning') {
      dropped += 1;
      return [];
    }

    const stripped = { ...record };
    for (const key of ['encrypted_content', 'reasoning_content', 'reasoning_id']) {
      if (key in stripped) {
        delete stripped[key];
        dropped += 1;
      }
    }
    return [stripped];
  });
  return { output: sanitized, dropped };
}

function sanitizeContent(
  content: string | MessageContent[],
  capabilities: ReplayModelCapabilities,
): { content: string | MessageContent[]; images: number; reasoning: number } {
  if (typeof content === 'string') return { content, images: 0, reasoning: 0 };

  let images = 0;
  let reasoning = 0;
  const parts = content.flatMap((part): MessageContent[] => {
    if (part.type === 'image' && !capabilities.supportsVision) {
      images += 1;
      return [{ type: 'text', text: IMAGE_PLACEHOLDER }];
    }
    if (part.type === 'thinking' && !capabilities.supportsReasoning) {
      reasoning += 1;
      return [];
    }
    return [part];
  });

  if (parts.length > 0) return { content: parts, images, reasoning };
  return {
    content: [{ type: 'text', text: '' }],
    images,
    reasoning,
  };
}

/**
 * Remove replay-only content the target model cannot accept. The returned
 * messages are request-local copies; callers must keep persisted history intact.
 */
export function sanitizeModelReplay(
  messages: ModelMessage[],
  capabilities: ReplayModelCapabilities,
): ReplaySanitizationResult {
  let imagePartsReplaced = 0;
  let reasoningPartsDropped = 0;
  let changed = false;

  const sanitizedMessages = messages.map((message) => {
    const contentResult = sanitizeContent(message.content, capabilities);
    imagePartsReplaced += contentResult.images;
    reasoningPartsDropped += contentResult.reasoning;

    let next = message;
    if (contentResult.images > 0 || contentResult.reasoning > 0) {
      next = { ...next, content: contentResult.content };
      changed = true;
    }

    if (!capabilities.supportsReasoning && Object.prototype.hasOwnProperty.call(next, 'thinking')) {
      const { thinking: _thinking, ...withoutThinking } = next;
      next = withoutThinking;
      reasoningPartsDropped += 1;
      changed = true;
    }

    if (!capabilities.supportsReasoning && next.responsesOutput?.length) {
      const outputResult = sanitizeResponsesOutput(next.responsesOutput);
      if (outputResult.dropped > 0) {
        next = { ...next, responsesOutput: outputResult.output };
        reasoningPartsDropped += outputResult.dropped;
        changed = true;
      }
    }

    return next;
  });

  if (imagePartsReplaced > 0 || reasoningPartsDropped > 0) {
    const rules: string[] = [];
    if (imagePartsReplaced > 0) rules.push('target-does-not-support-image');
    if (reasoningPartsDropped > 0) rules.push('target-does-not-support-reasoning');
    logger.debug('Sanitized outgoing model replay', {
      imagePartsReplaced,
      reasoningPartsDropped,
      rules,
    });
  }

  return {
    messages: changed ? sanitizedMessages : messages,
    imagePartsReplaced,
    reasoningPartsDropped,
  };
}

export function sanitizeModelReplayForModelInfo(
  messages: ModelMessage[],
  modelInfo: { supportsVision?: boolean; capabilities?: readonly string[] } | null,
): ModelMessage[] {
  return sanitizeModelReplay(messages, {
    supportsVision: modelInfo?.supportsVision === true,
    supportsReasoning: modelInfo?.capabilities?.includes('reasoning') === true,
  }).messages;
}
