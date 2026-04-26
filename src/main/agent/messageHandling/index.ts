// ============================================================================
// Message Handling Module - Exports
// ============================================================================

export {
  formatToolCallForHistory,
  sanitizeToolResultForHistory,
  sanitizeToolResultForHistoryWithCall,
  sanitizeToolCallsForHistory,
  sanitizeToolResultsForHistory,
  sanitizeToolResultsForHistoryWithCalls,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from './converter';

export {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  type RAGContextOptions,
} from './contextBuilder';
