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
  buildEnhancedSystemPromptWithProactiveContext,
  buildEnhancedSystemPromptAsync,
  type RAGContextOptions,
} from './contextBuilder';
