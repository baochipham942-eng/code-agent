// ============================================================================
// Skill Repository Types
// 用于 Skill 仓库管理系统的类型定义
// ============================================================================

// ----------------------------------------------------------------------------
// 仓库配置
// ----------------------------------------------------------------------------

/**
 * Skill 仓库分类
 */
export type SkillRepositoryCategory = 'core' | 'workflow' | 'productivity' | 'community';

/**
 * Skill 仓库配置
 * 定义一个可下载的 Skill 仓库源
 */
export interface SkillRepository {
  /** 唯一标识，如 'anthropic-skills' */
  id: string;
  /** 显示名称 */
  name: string;
  /** GitHub 仓库 URL */
  url: string;
  /** 分支，默认 'main' */
  branch: string;
  /** skills 目录路径，如 'skills' 或 '.' */
  skillsPath: string;
  /** 仓库分类 */
  category: SkillRepositoryCategory;
  /** 是否为推荐仓库 */
  recommended: boolean;
  /** 仓库描述 */
  description?: string;
  /** 作者/组织 */
  author?: string;
  /** GitHub stars 数量 */
  stars?: number;
}

// ----------------------------------------------------------------------------
// 本地库信息
// ----------------------------------------------------------------------------

/**
 * Skill 依赖状态
 */
export interface SkillDependencyInfo {
  /** 是否所有依赖都满足 */
  satisfied: boolean;
  /** 缺失的命令行工具 */
  missingBins?: string[];
  /** 缺失的环境变量 */
  missingEnvVars?: string[];
  /** 缺失的引用文件 */
  missingReferences?: string[];
}

/**
 * 本地 Skill 信息
 * 描述本地存储的单个 Skill
 */
export interface LocalSkillInfo {
  /** skill 名称 */
  name: string;
  /** skill 描述 */
  description: string;
  /** 所属库 ID */
  libraryId: string;
  /** skill 目录路径 */
  localPath: string;
  /** 是否全局启用 */
  enabled: boolean;
  /** 依赖状态（如果有依赖的话）*/
  dependencyStatus?: SkillDependencyInfo;
  /** 需要的命令行工具 */
  bins?: string[];
  /** 需要的环境变量 */
  envVars?: string[];
}

/**
 * 本地已下载的 Skill 库
 * 表示一个已下载到本地的 Skill 仓库
 */
export interface LocalSkillLibrary {
  /** 关联的仓库 ID */
  repoId: string;
  /** 仓库显示名称 */
  repoName: string;
  /** 本地存储路径 */
  localPath: string;
  /** 下载时间戳 */
  downloadedAt: number;
  /** 最后更新时间戳 */
  lastUpdated: number;
  /** 版本/commit hash */
  version?: string;
  /** 包含的 skills */
  skills: LocalSkillInfo[];
}

// ----------------------------------------------------------------------------
// 会话挂载
// ----------------------------------------------------------------------------

/**
 * Skill 挂载来源
 */
export type SkillMountSource = 'auto' | 'manual' | 'recommended';

/**
 * 会话级 Skill 挂载状态
 * 描述一个 Skill 在当前会话中的挂载状态
 */
export interface SessionSkillMount {
  /** skill 名称 */
  skillName: string;
  /** 所属库 ID */
  libraryId: string;
  /** 挂载时间戳 */
  mountedAt: number;
  /** 挂载来源 */
  source: SkillMountSource;
}

// ----------------------------------------------------------------------------
// 持久化配置
// ----------------------------------------------------------------------------

/**
 * Skill 配置 (持久化)
 * 存储用户的 Skill 偏好设置
 */
export interface SkillConfig {
  /** 已添加的仓库列表 */
  repositories: SkillRepository[];
  /** 全局启用的 skill 名称列表 */
  enabledSkills: string[];
  /** 自动下载的仓库 ID 列表 */
  autoDownload: string[];
}

// ----------------------------------------------------------------------------
// 操作结果
// ----------------------------------------------------------------------------

/**
 * 仓库下载结果
 */
export interface DownloadResult {
  /** 是否成功 */
  success: boolean;
  /** 本地存储路径 */
  localPath?: string;
  /** 下载的库信息 */
  library?: LocalSkillLibrary;
  /** 错误信息 */
  error?: string;
}

/**
 * 仓库更新结果
 */
export interface UpdateResult {
  /** 是否成功 */
  success: boolean;
  /** 是否有更新 */
  hasUpdates?: boolean;
  /** 更新前版本 */
  previousVersion?: string;
  /** 更新后版本 */
  currentVersion?: string;
  /** 错误信息 */
  error?: string;
}

// ----------------------------------------------------------------------------
// 推荐系统
// ----------------------------------------------------------------------------

/**
 * Skill 推荐项
 */
export interface SkillRecommendation {
  /** skill 名称 */
  skillName: string;
  /** 所属库 ID */
  libraryId: string;
  /** 推荐理由 */
  reason: string;
  /** 推荐分数 (0-1) */
  score: number;
}
