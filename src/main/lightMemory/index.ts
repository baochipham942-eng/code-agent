// ============================================================================
// Light Memory Module — File-as-Memory architecture
// Replaces the 13K+ line vector/embedding memory system with ~200 lines
// of code + prompt-based judgment.
// ============================================================================

export { loadMemoryIndex, ensureMemoryDir, getMemoryDir, getMemoryIndexPath } from './indexLoader';
export { recordSessionStart, recordSessionEnd, buildSessionMetadataBlock } from './sessionMetadata';
export { appendConversationSummary, buildRecentConversationsBlock } from './recentConversations';
export type { ConversationSummary } from './recentConversations';
export { judgeConversation } from './conversationJudge';
export type { ConversationJudgment } from './conversationJudge';
export { consolidateLightMemory } from './consolidation';
export type { ConsolidationReport, ConsolidationAction } from './consolidation';
export {
  recordFailurePatterns,
  loadFailureJournalEntries,
  buildFailureJournalBlock,
  buildFailurePatternKey,
  normalizeErrorMessage,
} from './failureJournal';
export type { FailurePattern } from './failureJournal';
