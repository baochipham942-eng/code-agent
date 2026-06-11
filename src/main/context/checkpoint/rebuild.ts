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
    const rendered = renderTailMessage(message);
    const nextTokens = estimateTokens(rendered);
    if (tailBlocks.length > 0 && tailTokens + nextTokens > maxTokens) break;
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

