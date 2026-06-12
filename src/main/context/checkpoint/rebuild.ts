import type { Message } from '../../../shared/contract';
import { estimateTokens } from '../tokenOptimizer';
import { selectCheckpointTail } from './tail';

export interface RebuildContextInput {
  checkpoint: string;
  memory: string;
  notes?: string;
  tailMessages: Message[];
  maxTokens?: number;
}

function renderTailMessage(message: Message): string {
  const label = `${message.role}:${message.id}`;
  const content = (message.content || '').trim();
  if (!content) return `### ${label}\n(empty)`;
  return `### ${label}\n${content}`;
}

const TRUNCATION_MARKER = '\n[truncated by checkpoint rebuild token cap]';

function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) return TRUNCATION_MARKER.trim();
  // 估算 4 字符/token 起步，超预算则按比例继续收缩
  let candidate = text.slice(0, budgetTokens * 4);
  let tokens = estimateTokens(candidate);
  while (tokens > budgetTokens && candidate.length > 0) {
    candidate = candidate.slice(0, Math.floor(candidate.length * (budgetTokens / tokens) * 0.95));
    tokens = estimateTokens(candidate);
  }
  return `${candidate}${TRUNCATION_MARKER}`;
}

export function renderCheckpointRebuildContext(input: RebuildContextInput): string {
  const maxTokens = input.maxTokens ?? 24_000;
  const sections = [
    '<checkpoint-rebuild>',
    'This session is continuing from a checkpoint boundary. Use the checkpoint and project memory as reconstruction context, then continue from the recent tail messages.',
    '',
    '## Session checkpoint',
    input.checkpoint.trim() || '(none)',
    '',
    '## Project memory',
    input.memory.trim() || '(none)',
  ];

  if (input.notes?.trim()) {
    sections.push('', '## Open notes', input.notes.trim());
  }

  const tailBlocks: string[] = [];
  let tailTokens = estimateTokens(sections.join('\n\n'));
  for (const message of input.tailMessages) {
    let rendered = renderTailMessage(message);
    let nextTokens = estimateTokens(rendered);
    if (tailTokens + nextTokens > maxTokens) {
      // 首条消息也要进 cap（audit C-M3）：超预算时截断而非无条件放行
      if (tailBlocks.length > 0) break;
      rendered = truncateToTokenBudget(rendered, Math.max(maxTokens - tailTokens, 0));
      nextTokens = estimateTokens(rendered);
    }
    tailBlocks.push(rendered);
    tailTokens += nextTokens;
  }

  sections.push('', '## Recent tail messages', tailBlocks.length > 0 ? tailBlocks.join('\n\n') : '(none)');
  sections.push('</checkpoint-rebuild>');
  return sections.join('\n');
}

export function buildRebuildTailContext(messages: Message[], options: { maxTokens?: number } = {}): {
  boundaryMessageId: string | null;
  compactedMessageCount: number;
  tailMessages: Message[];
} {
  const tail = selectCheckpointTail(messages, {
    maxTokens: options.maxTokens,
  });
  return {
    boundaryMessageId: tail.boundaryMessageId,
    compactedMessageCount: tail.compactedMessages.length,
    tailMessages: tail.preservedMessages,
  };
}

