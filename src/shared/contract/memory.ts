// ============================================================================
// Memory Types - 记忆管理相关类型定义
// ============================================================================

/**
 * 记忆分类
 * - about_me: 关于用户的身份信息
 * - preference: 用户的偏好设置
 * - frequent_info: 常用信息（邮箱、模板等）
 * - learned: AI 学习到的模式和经验
 */
export type MemoryCategory = 'about_me' | 'preference' | 'frequent_info' | 'learned';

/**
 * 记忆来源
 * - explicit: 用户明确提供
 * - learned: AI 自动学习
 */
export type MemorySource = 'explicit' | 'learned';

/**
 * 记忆条目
 */
export interface MemoryItem {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  confidence: number; // 0-1, learned 类型需要
  createdAt: number;
  updatedAt: number;
  sourceSessionId?: string;
  sourceContext?: string;
  tags?: string[];
  projectPath?: string;
}

export type MemoryEntryStatus = 'candidate' | 'active' | 'rejected' | 'stale' | 'archived';

export type MemoryEntryKind =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'session'
  | 'pattern';

export type MemoryEntryScope = 'global' | 'project' | 'session';

export type MemoryEntrySourceOfTruth = 'light_file' | 'db_memory';

export type MemoryEntrySourceKind =
  | 'light_file'
  | 'db_memory'
  | 'knowledge_inbox'
  | 'recent_conversation'
  | 'precompact_flush'
  | 'import';

export interface MemoryEntryEvidence {
  sessionId?: string | null;
  messageId?: string | null;
  filePath?: string | null;
  toolCallId?: string | null;
  flushHash?: string | null;
  candidateId?: string | null;
  memoryId?: string | null;
  contentHash?: string | null;
  source?: string | null;
}

export interface MemoryEntrySourceRef {
  kind: MemoryEntrySourceKind;
  sourceOfTruth: MemoryEntrySourceOfTruth;
  filePath?: string | null;
  memoryId?: string | null;
  label?: string | null;
}

export interface MemoryEntry {
  id: string;
  schemaVersion: 2;
  status: MemoryEntryStatus;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  title: string;
  summary: string;
  content: string;
  source: MemoryEntrySourceRef;
  evidence: MemoryEntryEvidence[];
  projectPath?: string | null;
  sessionId?: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntryListResult {
  entries: MemoryEntry[];
  sourceCounts: Record<MemoryEntrySourceOfTruth, number>;
}

export interface MemoryMirrorRebuildResult {
  totalLightFiles: number;
  mirrored: number;
  created: number;
  updated: number;
  skipped: Array<{ filename: string; reason: string }>;
}

export interface MemoryEntryUpdateRequest {
  entryId: string;
  title?: string;
  summary?: string;
  content?: string;
  status?: MemoryEntryStatus;
  kind?: MemoryEntryKind;
  scope?: MemoryEntryScope;
}

export interface MemoryEntryUpdateResult {
  entry: MemoryEntry;
  mirrorRebuild?: MemoryMirrorRebuildResult;
}

export interface MemoryEntryDeleteRequest {
  entryId: string;
}

export interface MemoryEntryDeleteResult {
  deleted: boolean;
  sourceOfTruth?: MemoryEntrySourceOfTruth;
  mirrorRebuild?: MemoryMirrorRebuildResult;
}

export interface MemoryPackRequest {
  query?: string;
  projectPath?: string | null;
  sessionId?: string | null;
  kinds?: MemoryEntryKind[];
  statuses?: MemoryEntryStatus[];
  maxItems?: number;
  perItemCharLimit?: number;
  totalCharBudget?: number;
}

export interface PackedMemoryItem {
  entryId: string;
  title: string;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  status: MemoryEntryStatus;
  score: number;
  scoreReasons: string[];
  source: MemoryEntrySourceRef;
  evidence: MemoryEntryEvidence[];
  content: string;
  originalChars: number;
  packedChars: number;
  truncated: boolean;
}

export interface MemoryPackResult {
  query: string;
  totalCandidates: number;
  selectedCount: number;
  totalChars: number;
  budget: number;
  items: PackedMemoryItem[];
  block: string;
}

export interface MemoryExportV2Bundle {
  schemaVersion: 2;
  exportedAt: number;
  entries: MemoryEntry[];
  index: {
    path: string;
    content: string | null;
  };
  evidenceManifest: Array<{
    entryId: string;
    evidence: MemoryEntryEvidence[];
    source: MemoryEntrySourceRef;
  }>;
  sourceCounts: Record<MemoryEntrySourceOfTruth, number>;
}

export type MemoryImportV2DiffStatus = 'add' | 'update' | 'conflict' | 'skip';

export interface MemoryImportV2DiffItem {
  entryId: string;
  status: MemoryImportV2DiffStatus;
  reason: string;
  incomingTitle?: string;
  existingTitle?: string;
  sourceOfTruth?: MemoryEntrySourceOfTruth;
}

export interface MemoryImportV2DryRunResult {
  schemaVersion: 2;
  incomingCount: number;
  existingCount: number;
  added: number;
  updated: number;
  conflicted: number;
  skipped: number;
  items: MemoryImportV2DiffItem[];
}

export interface MemoryImportV2ApplyRequest {
  bundle: MemoryExportV2Bundle;
  allowConflicts?: boolean;
}

export interface MemoryImportV2ApplyResult extends MemoryImportV2DryRunResult {
  applied: number;
  created: number;
  updatedApplied: number;
  skippedApply: number;
  writtenFiles: string[];
  mirrorRebuild?: MemoryMirrorRebuildResult;
}

/**
 * 记忆统计
 */
export interface MemoryStats {
  total: number;
  byCategory: Record<MemoryCategory, number>;
  recentlyAdded: number; // 最近 7 天
  learnedCount: number;
  explicitCount: number;
}

/**
 * 记忆导出格式
 */
export interface MemoryExport {
  version: number;
  exportedAt: number;
  items: MemoryItem[];
}

/**
 * 分类信息（用于 UI 展示）
 */
export interface MemoryCategoryInfo {
  key: MemoryCategory;
  icon: string;
  label: string;
  description: string;
}

/**
 * 记忆分类配置
 */
export const MEMORY_CATEGORIES: MemoryCategoryInfo[] = [
  {
    key: 'about_me',
    icon: '👤',
    label: '关于我',
    description: '身份、角色、沟通风格',
  },
  {
    key: 'preference',
    icon: '⭐',
    label: '我的偏好',
    description: '格式、风格、工具偏好',
  },
  {
    key: 'frequent_info',
    icon: '📋',
    label: '常用信息',
    description: '邮箱、模板、常用数据',
  },
  {
    key: 'learned',
    icon: '💡',
    label: '学到的经验',
    description: 'AI 观察到的模式和习惯',
  },
];

/**
 * 记忆学习事件（用于通知 UI）
 */
export interface MemoryLearnedEvent {
  /** 事件 ID */
  id: string;
  /** 学习的内容 */
  content: string;
  /** 分类 */
  category: string;
  /** 学习类型 */
  type: string;
  /** 置信度 */
  confidence: number;
  /** 是否需要用户确认 */
  needsConfirmation: boolean;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 记忆确认请求（用于用户确认学习到的记忆）
 */
export interface MemoryConfirmRequest {
  /** 请求 ID */
  id: string;
  /** 内容 */
  content: string;
  /** 分类 */
  category: string;
  /** 类型 */
  type: string;
  /** 置信度 */
  confidence: number;
  /** 时间戳 */
  timestamp: number;
}
