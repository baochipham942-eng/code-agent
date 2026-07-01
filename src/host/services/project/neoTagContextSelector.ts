import type { Message } from '../../../shared/contract/message';
import type {
  NeoTagContextPack,
  NeoWorkCard,
  NeoWorkCardDelta,
  NeoWorkCardRevision,
} from '../../../shared/contract/tag';
import { estimateTokens } from '../../context/tokenOptimizer';

export interface BuildNeoTagContextPackInput {
  workCard: NeoWorkCard;
  revision: NeoWorkCardRevision;
  messages?: Message[];
  previousDeltas?: NeoWorkCardDelta[];
  now?: number;
  maxMessages?: number;
  maxTokens?: number;
}

function packId(workCardId: string, revisionId: string, createdAt: number): string {
  return `neoctx_${workCardId}_${revisionId}_${createdAt}`;
}

function addCandidate(
  selected: Map<string, { id: string; reason: string; score: number }>,
  id: string | undefined,
  reason: string,
  score: number,
): void {
  const normalized = id?.trim();
  if (!normalized) return;
  const existing = selected.get(normalized);
  if (!existing || score > existing.score) {
    selected.set(normalized, { id: normalized, reason, score });
  }
}

export function buildNeoTagContextPack(input: BuildNeoTagContextPackInput): NeoTagContextPack {
  const now = input.now ?? Date.now();
  const maxMessages = Math.max(1, Math.min(input.maxMessages ?? 12, 40));
  const maxTokens = Math.max(800, Math.min(input.maxTokens ?? 6000, 24000));
  const messages = input.messages ?? [];
  const selected = new Map<string, { id: string; reason: string; score: number }>();
  const excluded: NeoTagContextPack['excluded'] = [];

  addCandidate(selected, input.workCard.sourceTurnId, 'source turn for the approved work card', 1);
  for (const messageId of input.revision.readScope.messageIds) {
    addCandidate(selected, messageId, 'explicitly approved readScope.messageIds', 0.95);
  }

  const scopedConversationIds = new Set(input.revision.readScope.conversationIds);
  const scopedMessages = messages.filter((message) => {
    const conversationId = message.metadata?.neoTag?.sourceConversationId;
    return scopedConversationIds.size === 0
      || scopedConversationIds.has(input.workCard.sourceConversationId)
      || (conversationId && scopedConversationIds.has(conversationId));
  });

  for (const message of scopedMessages.slice(-maxMessages)) {
    addCandidate(selected, message.id, 'recent bounded message from approved conversation scope', 0.55);
  }

  for (const message of scopedMessages.slice(0, Math.max(0, scopedMessages.length - maxMessages))) {
    if (!selected.has(message.id)) {
      excluded.push({ id: message.id, reason: 'outside P0 recent-message budget' });
    }
  }

  const selectedMessages = Array.from(selected.values())
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxMessages);
  const selectedIds = new Set(selectedMessages.map((message) => message.id));

  for (const message of scopedMessages) {
    if (!selectedIds.has(message.id) && !excluded.some((item) => item.id === message.id)) {
      excluded.push({ id: message.id, reason: 'lower relevance than selected bounded messages' });
    }
  }

  const previousDelta = input.previousDeltas?.at(-1);
  const deltaTokens = previousDelta ? estimateTokens(JSON.stringify(previousDelta)) : 0;
  const selectedMessageTokens = messages
    .filter((message) => selectedIds.has(message.id))
    .reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
  const fileTokens = input.revision.readScope.fileGlobs.length * 24;
  const memoryTokens = input.revision.readScope.memoryEntryIds.length * 16;
  const estimatedTokens = Math.min(maxTokens, selectedMessageTokens + deltaTokens + fileTokens + memoryTokens + 200);

  return {
    id: packId(input.workCard.id, input.revision.id, now),
    projectId: input.workCard.projectId,
    workCardId: input.workCard.id,
    workCardRevisionId: input.revision.id,
    seedConversationId: input.workCard.sourceConversationId,
    seedTurnId: input.workCard.sourceTurnId,
    strategy: input.revision.readScope.mode === 'selected_context' ? 'focused_reply' : 'work_card_thread',
    selectedMessages,
    selectedArtifacts: input.revision.readScope.artifactIds.map((id) => ({
      id,
      reason: 'explicitly approved readScope.artifactIds',
      score: 0.9,
    })),
    selectedMemoryEntryIds: [...input.revision.readScope.memoryEntryIds],
    selectedFiles: input.revision.readScope.fileGlobs.map((path) => ({
      path,
      reason: 'approved fileGlobs placeholder; runtime may read on demand',
    })),
    excluded,
    expandableScopes: [
      ...input.revision.readScope.fileGlobs.map((scope) => ({
        scope,
        handle: `file-glob:${scope}`,
        reason: 'approved file scope can be expanded by tools when needed',
      })),
      ...input.revision.readScope.memoryEntryIds.map((scope) => ({
        scope,
        handle: `memory:${scope}`,
        reason: 'approved memory entry placeholder',
      })),
      ...(previousDelta
        ? [{
            scope: previousDelta.id,
            handle: `work-card-delta:${previousDelta.id}`,
            reason: 'latest work card delta is available as prior progress',
          }]
        : []),
    ],
    budget: { maxTokens, estimatedTokens },
    createdAt: now,
  };
}
