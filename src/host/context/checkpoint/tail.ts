import type { Message } from '../../../shared/contract';
import { estimateTokens } from '../tokenOptimizer';

export interface CheckpointTailOptions {
  minTokens?: number;
  maxTokens?: number;
  minTextMessages?: number;
}

export interface CheckpointTailSelection {
  boundaryMessageId: string | null;
  preservedMessages: Message[];
  compactedMessages: Message[];
  preservedTokens: number;
}

const DEFAULT_MIN_TOKENS = 10_000;
const DEFAULT_MAX_TOKENS = 20_000;
const DEFAULT_MIN_TEXT_MESSAGES = 5;

function estimateMessageTokens(message: Message): number {
  let total = estimateTokens(message.content || '');
  if (message.toolCalls?.length) {
    total += estimateTokens(JSON.stringify(message.toolCalls));
  }
  if (message.toolResults?.length) {
    total += estimateTokens(JSON.stringify(message.toolResults));
  }
  if (message.reasoning) {
    total += estimateTokens(message.reasoning);
  }
  return Math.max(1, total);
}

function hasText(message: Message): boolean {
  return Boolean((message.content || '').trim() || (message.reasoning || '').trim());
}

export function selectCheckpointTail(
  messages: readonly Message[],
  options: CheckpointTailOptions = {},
): CheckpointTailSelection {
  if (messages.length === 0) {
    return {
      boundaryMessageId: null,
      preservedMessages: [],
      compactedMessages: [],
      preservedTokens: 0,
    };
  }

  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minTextMessages = options.minTextMessages ?? DEFAULT_MIN_TEXT_MESSAGES;
  const tokens = messages.map(estimateMessageTokens);
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  let startIndex = lastAssistant > 0 ? lastAssistant - 1 : 0;

  let preservedTokens = 0;
  let textMessages = 0;
  for (let index = startIndex; index < messages.length; index += 1) {
    preservedTokens += tokens[index];
    if (hasText(messages[index])) textMessages += 1;
  }

  if (preservedTokens < maxTokens) {
    while (
      startIndex > 0
      && preservedTokens < maxTokens
      && (preservedTokens < minTokens || textMessages < minTextMessages)
    ) {
      startIndex -= 1;
      preservedTokens += tokens[startIndex];
      if (hasText(messages[startIndex])) textMessages += 1;
    }
  }

  return {
    boundaryMessageId: messages[startIndex]?.id ?? null,
    preservedMessages: messages.slice(startIndex),
    compactedMessages: messages.slice(0, startIndex),
    preservedTokens,
  };
}

