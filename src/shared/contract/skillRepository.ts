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

// ----------------------------------------------------------------------------
// 推荐分类（产物导向）
// ----------------------------------------------------------------------------

/**
 * Skill 产物分类
 * 按"用户要交付什么"划分，面向 cowork 协作者（非程序员）的心智模型
 */
export type SkillCategory =
  | 'docs-office' // 文档办公
  | 'data-analysis' // 数据分析
  | 'design-creative' // 设计创意
  | 'content-marketing' // 内容营销
  | 'research' // 研究调研
  | 'automation' // 效率自动化
  | 'development'; // 开发工程

/**
 * Skill 产物分类元数据（用于推荐页展示）
 */
export interface SkillCategoryMeta {
  /** 分类 ID */
  id: SkillCategory;
  /** 中文显示名 */
  label: string;
  /** 一句话说明 */
  description: string;
}

/**
 * 推荐 Skill 条目（skill 粒度）
 * 安装时下载其来源仓库；repoId 为 'builtin' 表示已内置无需安装
 */
export interface RecommendedSkillEntry {
  /** skill 名称（与仓库内 skill 目录名一致） */
  name: string;
  /** 中文显示名 */
  displayName: string;
  /** 一句话功能描述 */
  description: string;
  /** 产物分类 */
  category: SkillCategory;
  /** 来源仓库 ID；'builtin' 表示内置 */
  repoId: string;
  /** 热度/来源标签（如 "官方生产级"、"GitHub 20万+ Star"） */
  badge?: string;
}

/**
 * 角色场景包
 * 按用户角色组织的精选 skill 合集（产品经理包、运营增长包等）
 */
export interface SkillRoleBundle {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 包内 skill 引用 */
  skills: Array<{
    /** skill 名称（与仓库内 skill 目录名一致） */
    name: string;
    /** 中文显示名 */
    displayName: string;
    /** 来源仓库 ID；'builtin' 表示内置 */
    repoId: string;
  }>;
}

/** 内置 skill 的来源仓库 ID 标记 */
export const BUILTIN_REPO_ID = 'builtin';

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
  /**
   * 全局启用的 skill 名称列表
   * @deprecated 已改用 disabledSkills 黑名单语义（默认全开），保留此字段仅为兼容旧配置文件
   */
  enabledSkills: string[];
  /** 全局禁用的 skill 名称列表（黑名单：不在列表中的 skill 默认启用） */
  disabledSkills: string[];
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
