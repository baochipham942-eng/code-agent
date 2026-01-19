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
} from './BrowserService';

export {
  getEvolutionPersistence,
  initEvolutionPersistence,
  type Strategy,
  type StrategyFeedback,
  type LearnedPattern,
} from './EvolutionPersistence';

export {
  getLangfuseService,
  initLangfuse,
  type LangfuseConfig,
  type TraceMetadata,
  type GenerationInput,
  type SpanInput,
} from './LangfuseService';

export {
  notificationService,
  type TaskNotificationData,
} from './NotificationService';

export {
  SessionManager,
  getSessionManager,
  type SessionWithMessages,
  type SessionCreateOptions,
  type SessionListOptions,
} from './SessionManager';

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
} from './SupabaseService';

export {
  type CacheEntry,
  type CacheStats,
} from './ToolCache';

// Re-export ToolCache function
import { getToolCache as _getToolCache } from './ToolCache';
export const getToolCache = _getToolCache;
