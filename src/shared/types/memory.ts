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
