// ============================================================================
// Message Handling Module - Exports
// ============================================================================

export {
  formatToolCallForHistory,
  sanitizeToolResultForHistory,
  sanitizeToolResultsForHistory,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from './converter';

export {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  type RAGContextOptions,
} from './contextBuilder';
