// ============================================================================
// Infra Services - 基础设施服务导出
// ============================================================================

export {
  browserService,
  BrowserLogger,
  type BrowserTab,
  type ScreenshotResult,
  type PageContent,
  type ElementInfo,
} from './browserService';

export {
  getEvolutionPersistence,
  initEvolutionPersistence,
  type Strategy,
  type StrategyFeedback,
  type LearnedPattern,
} from './evolutionPersistence';

export {
  getLangfuseService,
  initLangfuse,
  type LangfuseConfig,
  type TraceMetadata,
  type GenerationInput,
  type SpanInput,
} from './langfuseService';

export {
  notificationService,
  type TaskNotificationData,
} from './notificationService';

export {
  SessionManager,
  getSessionManager,
  type SessionWithMessages,
  type SessionCreateOptions,
  type SessionListOptions,
} from './sessionManager';

export {
  initSupabase,
  getSupabase,
  isSupabaseInitialized,
  getSupabaseConfig,
  type Database,
  type ProfileRow,
  type DeviceRow,
  type SessionRow,
  type MessageRow,
  type UserPreferenceRow,
  type InviteCodeRow,
  type VectorDocumentRow,
  type VectorMatchResult,
} from './supabaseService';

export {
  type CacheEntry,
  type CacheStats,
} from './toolCache';

// Re-export ToolCache function
import { getToolCache as _getToolCache } from './toolCache';
export const getToolCache = _getToolCache;
