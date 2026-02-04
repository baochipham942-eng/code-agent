// ============================================================================
// Skill Repository Service - Manage Skill Repository Downloads and Updates
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  SkillRepository,
  LocalSkillLibrary,
  LocalSkillInfo,
  SkillConfig,
  DownloadResult,
  UpdateResult,
} from '@shared/types/skillRepository';
import {
  downloadRepository,
  parseGitHubUrl,
  checkForUpdates,
  updateRepository as gitUpdateRepository,
  readRepoMeta,
  readRepoMetaAsync,
} from './gitDownloader';
import { parseSkillMd, hasSkillMd } from './skillParser';
import {
  RECOMMENDED_REPOSITORIES,
  AUTO_DOWNLOAD_REPOS,
  DEFAULT_ENABLED_SKILLS,
  getDefaultEnabledSkills,
} from './skillRepositories';
import { createLogger } from '../infra/logger';

const logger = createLogger('SkillRepositoryService');

// ============================================================================
// Service Class
// ============================================================================

/**
 * Skill 仓库管理服务
 * 负责下载、更新、删除远程 Skill 仓库
 */
class SkillRepositoryService {
  private skillsDir: string; // ~/.code-agent/skills/
  private configPath: string; // ~/.code-agent/skill-config.json
  private config: SkillConfig;
  private libraries: Map<string, LocalSkillLibrary> = new Map();
  private initialized = false;

  constructor() {
    const baseDir = path.join(os.homedir(), '.code-agent');
    this.skillsDir = path.join(baseDir, 'skills');
    this.configPath = path.join(baseDir, 'skill-config.json');
    this.config = {
      repositories: [],
      enabledSkills: [],
      autoDownload: AUTO_DOWNLOAD_REPOS,
    };
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 创建目录
    await fs.mkdir(this.skillsDir, { recursive: true });

    // 加载配置
    await this.loadConfig();

    // 扫描本地已下载的库
    await this.scanLocalLibraries();

    this.initialized = true;
    logger.info('SkillRepositoryService initialized', {
      skillsDir: this.skillsDir,
      libraryCount: this.libraries.size,
    });
  }

  /**
   * 预下载推荐仓库
   */
  async preloadRecommendedRepositories(): Promise<void> {
    for (const repoId of this.config.autoDownload) {
      if (this.libraries.has(repoId)) {
        logger.debug('Repository already downloaded', { repoId });
        continue;
      }

      const repo = RECOMMENDED_REPOSITORIES.find((r) => r.id === repoId);
      if (!repo) continue;

      logger.info('Preloading repository', { repoId });
      try {
        await this.downloadRepository(repo);
      } catch (error) {
        logger.warn('Failed to preload repository', { repoId, error });
      }
    }
  }

  // ==========================================================================
  // Repository Operations
  // ==========================================================================

  /**
   * 下载仓库到本地
   */
  async downloadRepository(repo: SkillRepository): Promise<DownloadResult> {
    const targetDir = path.join(this.skillsDir, repo.id);

    logger.info('Downloading repository', {
      repoId: repo.id,
      url: repo.url,
      targetDir,
    });

    try {
      // 解析 URL
      const parsed = parseGitHubUrl(repo.url);
      if (!parsed) {
        return {
          success: false,
          error: `Invalid GitHub URL: ${repo.url}`,
        };
      }

      // 使用 gitDownloader 下载
      const result = await downloadRepository({
        owner: parsed.owner,
        repo: parsed.repo,
        branch: repo.branch || parsed.branch,
        targetDir,
        skillsPath: repo.skillsPath === '.' ? undefined : repo.skillsPath,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Download failed',
        };
      }

      // 扫描 skills 目录
      const localPath = result.localPath;
      const skills = await this.scanSkillsInLibrary(localPath, repo.skillsPath);

      // 创建 LocalSkillLibrary
      const library: LocalSkillLibrary = {
        repoId: repo.id,
        repoName: repo.name,
        localPath,
        downloadedAt: Date.now(),
        lastUpdated: Date.now(),
        version: result.commitHash,
        skills,
      };

      // 更新内存状态
      this.libraries.set(repo.id, library);

      // 更新配置：添加仓库
      if (!this.config.repositories.find((r) => r.id === repo.id)) {
        this.config.repositories.push(repo);
      }

      // 启用默认 Skills
      const defaultSkills = getDefaultEnabledSkills(repo.id);
      for (const skillName of defaultSkills) {
        if (!this.config.enabledSkills.includes(skillName)) {
          this.config.enabledSkills.push(skillName);
        }
      }

      await this.saveConfig();

      logger.info('Repository downloaded successfully', {
        repoId: repo.id,
        skillCount: skills.length,
        version: result.commitHash?.substring(0, 7),
      });

      return {
        success: true,
        localPath,
        library,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to download repository', {
        repoId: repo.id,
        error: errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 更新已下载的仓库
   */
  async updateRepository(repoId: string): Promise<UpdateResult> {
    const library = this.libraries.get(repoId);
    if (!library) {
      return {
        success: false,
        error: `Repository not found: ${repoId}`,
      };
    }

    logger.info('Updating repository', { repoId, localPath: library.localPath });

    try {
      // 检查是否有更新
      const updateCheck = await checkForUpdates(library.localPath);
      if (!updateCheck.hasUpdate) {
        logger.info('Repository is up to date', { repoId });
        return {
          success: true,
          hasUpdates: false,
          currentVersion: library.version,
        };
      }

      const previousVersion = library.version;

      // 执行更新
      const result = await gitUpdateRepository(library.localPath);
      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Update failed',
        };
      }

      // 重新扫描 skills
      const repo = this.config.repositories.find((r) => r.id === repoId);
      const skillsPath = repo?.skillsPath || 'skills';
      const skills = await this.scanSkillsInLibrary(library.localPath, skillsPath);

      // 更新库信息
      library.lastUpdated = Date.now();
      library.version = result.commitHash;
      library.skills = skills;
      this.libraries.set(repoId, library);

      await this.saveConfig();

      logger.info('Repository updated successfully', {
        repoId,
        previousVersion: previousVersion?.substring(0, 7),
        currentVersion: result.commitHash?.substring(0, 7),
        skillCount: skills.length,
      });

      return {
        success: true,
        hasUpdates: true,
        previousVersion,
        currentVersion: result.commitHash,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to update repository', {
        repoId,
        error: errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 删除本地仓库
   */
  async removeRepository(repoId: string): Promise<void> {
    const library = this.libraries.get(repoId);
    if (!library) {
      logger.warn('Repository not found for removal', { repoId });
      return;
    }

    logger.info('Removing repository', { repoId, localPath: library.localPath });

    try {
      // 删除目录
      await fs.rm(library.localPath, { recursive: true, force: true });

      // 更新内存状态
      this.libraries.delete(repoId);

      // 更新配置
      this.config.repositories = this.config.repositories.filter((r) => r.id !== repoId);

      // 移除该库中所有 skills 的启用状态
      const skillNames = library.skills.map((s) => s.name);
      this.config.enabledSkills = this.config.enabledSkills.filter(
        (s) => !skillNames.includes(s)
      );

      await this.saveConfig();

      logger.info('Repository removed successfully', { repoId });
    } catch (error) {
      logger.error('Failed to remove repository', { repoId, error });
      throw error;
    }
  }

  /**
   * 从 URL 添加自定义仓库
   */
  async addCustomRepository(url: string, name?: string): Promise<DownloadResult> {
    // 解析 URL
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      return {
        success: false,
        error: `Invalid GitHub URL: ${url}`,
      };
    }

    // 生成仓库 ID
    const repoId = `${parsed.owner}-${parsed.repo}`.toLowerCase();

    // 检查是否已存在
    if (this.libraries.has(repoId)) {
      return {
        success: false,
        error: `Repository already exists: ${repoId}`,
      };
    }

    // 创建 SkillRepository 对象
    const repo: SkillRepository = {
      id: repoId,
      name: name || `${parsed.owner}/${parsed.repo}`,
      url,
      branch: parsed.branch,
      skillsPath: 'skills', // 默认使用 skills 目录
      category: 'community',
      recommended: false,
      author: parsed.owner,
    };

    // 下载仓库
    return this.downloadRepository(repo);
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * 获取所有本地库
   */
  getLocalLibraries(): LocalSkillLibrary[] {
    return Array.from(this.libraries.values());
  }

  /**
   * 获取单个库
   */
  getLibrary(repoId: string): LocalSkillLibrary | undefined {
    return this.libraries.get(repoId);
  }

  /**
   * 获取推荐仓库列表
   */
  getRecommendedRepositories(): SkillRepository[] {
    return RECOMMENDED_REPOSITORIES;
  }

  /**
   * 获取未安装的推荐仓库
   */
  getUninstalledRecommendedRepos(): SkillRepository[] {
    return RECOMMENDED_REPOSITORIES.filter((r) => !this.libraries.has(r.id));
  }

  /**
   * 获取所有可用的 Skills
   */
  getAllSkills(): LocalSkillInfo[] {
    const skills: LocalSkillInfo[] = [];
    for (const library of this.libraries.values()) {
      skills.push(...library.skills);
    }
    return skills;
  }

  /**
   * 根据名称查找 Skill
   */
  findSkill(skillName: string): LocalSkillInfo | undefined {
    for (const library of this.libraries.values()) {
      const skill = library.skills.find((s) => s.name === skillName);
      if (skill) return skill;
    }
    return undefined;
  }

  // ==========================================================================
  // Skill Enable/Disable
  // ==========================================================================

  /**
   * 启用 skill
   */
  enableSkill(skillName: string): void {
    if (!this.config.enabledSkills.includes(skillName)) {
      this.config.enabledSkills.push(skillName);
      this.updateSkillEnabledStatus(skillName, true);
      this.saveConfig();
    }
  }

  /**
   * 禁用 skill
   */
  disableSkill(skillName: string): void {
    this.config.enabledSkills = this.config.enabledSkills.filter((s) => s !== skillName);
    this.updateSkillEnabledStatus(skillName, false);
    this.saveConfig();
  }

  /**
   * 检查 skill 是否启用
   */
  isSkillEnabled(skillName: string): boolean {
    return this.config.enabledSkills.includes(skillName);
  }

  /**
   * 获取所有启用的 skills
   */
  getEnabledSkills(): string[] {
    return [...this.config.enabledSkills];
  }

  /**
   * 批量设置启用的 skills
   */
  setEnabledSkills(skillNames: string[]): void {
    this.config.enabledSkills = [...skillNames];

    // 更新所有 skill 的启用状态
    for (const library of this.libraries.values()) {
      for (const skill of library.skills) {
        skill.enabled = skillNames.includes(skill.name);
      }
    }

    this.saveConfig();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * 加载配置文件
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const loaded = JSON.parse(content) as Partial<SkillConfig>;

      this.config = {
        repositories: loaded.repositories || [],
        enabledSkills: loaded.enabledSkills || [],
        autoDownload: loaded.autoDownload || AUTO_DOWNLOAD_REPOS,
      };

      logger.debug('Config loaded', {
        repositoryCount: this.config.repositories.length,
        enabledSkillCount: this.config.enabledSkills.length,
      });
    } catch (error) {
      // 配置文件不存在或无效，使用默认值
      logger.debug('Config file not found or invalid, using defaults');
    }
  }

  /**
   * 保存配置文件
   */
  private async saveConfig(): Promise<void> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.debug('Config saved');
    } catch (error) {
      logger.error('Failed to save config', { error });
    }
  }

  /**
   * 扫描本地已下载的库
   */
  private async scanLocalLibraries(): Promise<void> {
    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // 跳过隐藏目录

        const libraryPath = path.join(this.skillsDir, entry.name);

        // 读取元数据
        const meta = await readRepoMetaAsync(libraryPath);
        if (!meta) {
          logger.warn('No metadata found for library directory', {
            path: libraryPath,
          });
          continue;
        }

        // 查找对应的仓库配置
        const repo = this.config.repositories.find(
          (r) => r.id === entry.name || `${meta.owner}-${meta.repo}`.toLowerCase() === entry.name
        );

        // 扫描 skills（优先使用 meta.skillsPath，其次是 repo.skillsPath，最后默认 'skills'）
        const skillsPath = meta.skillsPath || repo?.skillsPath || 'skills';
        const skills = await this.scanSkillsInLibrary(libraryPath, skillsPath);

        // 创建库对象
        const library: LocalSkillLibrary = {
          repoId: entry.name,
          repoName: repo?.name || `${meta.owner}/${meta.repo}`,
          localPath: libraryPath,
          downloadedAt: meta.downloadedAt,
          lastUpdated: meta.lastUpdated,
          version: meta.commitHash,
          skills,
        };

        this.libraries.set(entry.name, library);
        logger.debug('Loaded local library', {
          repoId: entry.name,
          skillCount: skills.length,
        });
      }
    } catch (error) {
      // 目录不存在时忽略
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to scan local libraries', { error });
      }
    }
  }

  /**
   * 扫描库中的所有 skills
   */
  private async scanSkillsInLibrary(
    libraryPath: string,
    skillsSubPath: string
  ): Promise<LocalSkillInfo[]> {
    const skills: LocalSkillInfo[] = [];

    // 确定 skills 目录路径
    const skillsDir = skillsSubPath === '.' ? libraryPath : path.join(libraryPath, skillsSubPath);

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // 跳过隐藏目录

        const skillDir = path.join(skillsDir, entry.name);

        // 检查是否包含 SKILL.md
        if (!(await hasSkillMd(skillDir))) {
          continue;
        }

        try {
          // 解析 SKILL.md
          const parsed = await parseSkillMd(skillDir, 'library');

          const skillInfo: LocalSkillInfo = {
            name: parsed.name,
            description: parsed.description,
            libraryId: path.basename(libraryPath),
            localPath: skillDir,
            enabled: this.config.enabledSkills.includes(parsed.name),
          };

          skills.push(skillInfo);
        } catch (parseError) {
          logger.warn('Failed to parse skill', {
            skillDir,
            error: parseError instanceof Error ? parseError.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      // skills 目录不存在时忽略
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to scan skills directory', {
          skillsDir,
          error,
        });
      }
    }

    return skills;
  }

  /**
   * 更新 skill 的启用状态
   */
  private updateSkillEnabledStatus(skillName: string, enabled: boolean): void {
    for (const library of this.libraries.values()) {
      const skill = library.skills.find((s) => s.name === skillName);
      if (skill) {
        skill.enabled = enabled;
        break;
      }
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalInstance: SkillRepositoryService | null = null;

/**
 * 获取 SkillRepositoryService 单例
 */
export function getSkillRepositoryService(): SkillRepositoryService {
  if (!globalInstance) {
    globalInstance = new SkillRepositoryService();
  }
  return globalInstance;
}

/**
 * 重置 SkillRepositoryService 单例 (用于测试)
 */
export function resetSkillRepositoryService(): void {
  globalInstance = null;
}

export { SkillRepositoryService };
