// ============================================================================
// Core Services - 核心服务导出
// ============================================================================

export {
  isProduction,
  sanitizeForLogging,
  safeLog,
  ConfigService,
  initConfigService,
  getConfigService,
} from './configService';

export {
  DatabaseService,
  getDatabase,
  initDatabase,
  type StoredSession,
  type StoredMessage,
  type ToolExecution,
  type UserPreference,
  type ProjectKnowledge,
  type MemoryRecord,
  type RelationQueryOptions,
  type EntityRelation,
} from './databaseService';

export {
  getSecureStorage,
  type SecureStorageService,
} from './secureStorage';

export {
  type PermissionPreset,
  type PermissionConfig,
  PERMISSION_PRESETS,
  PRESET_DESCRIPTIONS,
  getPresetConfig,
  isPathTrusted,
  isCommandBlocked,
  isDangerousCommand,
} from './permissionPresets';

export {
  BudgetService,
  BudgetAlertLevel,
  initBudgetService,
  getBudgetService,
  type BudgetConfig,
  type BudgetStatus,
  type TokenUsage,
} from './budgetService';

// promptSuggestions 故意不在此处 re-export：它通过动态 import 依赖 ../../model/quickModel，
// 而 quickModel 间接依赖 services barrel，会形成 core ↔ model 循环。
// 消费方请 `import ... from '@main/services/core/promptSuggestions'` 直接引用。
