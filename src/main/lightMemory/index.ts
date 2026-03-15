// ============================================================================
// Light Memory Module — File-as-Memory architecture
// Replaces the 13K+ line vector/embedding memory system with ~200 lines
// of code + prompt-based judgment.
// ============================================================================

export { loadMemoryIndex, ensureMemoryDir, getMemoryDir, getMemoryIndexPath } from './indexLoader';
export { memoryWriteTool } from './memoryWriteTool';
export { memoryReadTool } from './memoryReadTool';
export { recordSessionStart, recordSessionEnd, buildSessionMetadataBlock } from './sessionMetadata';
export { appendConversationSummary, buildRecentConversationsBlock } from './recentConversations';
export type { ConversationSummary } from './recentConversations';
