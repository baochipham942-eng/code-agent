// ============================================================================
// Skill Repository Service - Manage Skill Repository Downloads and Updates
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import type {
  SkillRepository,
  LocalSkillLibrary,
  LocalSkillInfo,
  SkillConfig,
  DownloadResult,
  StageRepositoryResult,
  StagedSkillPreview,
  SkillRepoSourceType,
  UpdateResult,
} from '@shared/contract/skillRepository';
import {
  downloadRepository,
  parseRepoUrl,
  checkForUpdates,
  updateRepository as gitUpdateRepository,
  readRepoMetaAsync,
  saveRepoMeta,
} from './gitDownloader';
import { parseSkillMd, hasSkillMd } from './skillParser';
import {
  detectRepositoryLayout,
  type RepositoryLayout,
} from './skillRepositoryLayout';
import {
  RECOMMENDED_REPOSITORIES,
  getDefaultAutoDownloadRepos,
  isRecommendedSkillAutoDownloadAllowed,
} from './skillRepositories';
import { createLogger } from '../infra/logger';

import { Disposable, getServiceRegistry } from '../serviceRegistry';
const logger = createLogger('SkillRepositoryService');

interface StagedRepositoryRecord {
  stageId: string;
  repoId: string;
  repoName: string;
  sourceType: SkillRepoSourceType;
  repository: SkillRepository;
  localPath: string;
  layout: RepositoryLayout;
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * Skill 仓库管理服务
 * 负责下载、更新、删除远程 Skill 仓库
 */
class SkillRepositoryService implements Disposable {
  private skillsDir: string; // ~/.code-agent/skills/
  private stagingDir: string; // ~/.code-agent/skills/.staging/
  private configPath: string; // ~/.code-agent/skill-config.json
  private config: SkillConfig;
  private libraries: Map<string, LocalSkillLibrary> = new Map();
  private stagedRepositories: Map<string, StagedRepositoryRecord> = new Map();
  private initialized = false;

  async dispose(): Promise<void> {
    this.libraries.clear();
    this.stagedRepositories.clear();
    this.initialized = false;
  }

  constructor() {
    const baseDir = getUserConfigDir();
    this.skillsDir = path.join(baseDir, 'skills');
    this.stagingDir = path.join(this.skillsDir, '.staging');
    this.configPath = path.join(baseDir, 'skill-config.json');
    this.config = {
      repositories: [],
      enabledSkills: [],
      disabledSkills: [],
      autoDownload: getDefaultAutoDownloadRepos(),
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
    // Staging entries are process-local transactions. Anything left from a
    // prior process is an orphan and must never become an installed library.
    await fs.rm(this.stagingDir, { recursive: true, force: true });
    await fs.mkdir(this.stagingDir, { recursive: true });

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
    if (!isRecommendedSkillAutoDownloadAllowed()) {
      logger.info('Recommended skill repository preload skipped; explicit opt-in is required');
      return;
    }

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
      const parsed = parseRepoUrl(repo.url);
      if (!parsed) {
        return {
          success: false,
          error: `Invalid repository URL: ${repo.url}`,
        };
      }

      // 使用 gitDownloader 下载
      const result = await downloadRepository({
        source: parsed.source,
        owner: parsed.owner,
        repo: parsed.repo,
        branch: repo.branch || parsed.branch,
        targetDir,
        modelScopeRepoType: parsed.source === 'modelscope' ? parsed.repoType : undefined,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Download failed',
        };
      }

      const localPath = result.localPath;
      const layout = await detectRepositoryLayout(localPath);
      const installedRepo: SkillRepository = {
        ...repo,
        skillsPath: layout.skillsPath,
      };
      const meta = await readRepoMetaAsync(localPath);
      if (meta) {
        await saveRepoMeta(localPath, {
          ...meta,
          skillsPath: layout.skillsPath,
        });
      }
      const skills = await this.scanSkillsInLibrary(localPath, layout);

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
        this.config.repositories.push(installedRepo);
      }

      // 黑名单语义下新安装的 skills 默认全部启用，无需额外写入

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

      // 重新探测布局并扫描 skills
      const repo = this.config.repositories.find((r) => r.id === repoId);
      const layout = await detectRepositoryLayout(library.localPath);
      const skills = await this.scanSkillsInLibrary(library.localPath, layout);
      if (repo) {
        repo.skillsPath = layout.skillsPath;
      }
      const meta = await readRepoMetaAsync(library.localPath);
      if (meta) {
        await saveRepoMeta(library.localPath, {
          ...meta,
          skillsPath: layout.skillsPath,
        });
      }

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

      // 清理该库中所有 skills 的禁用记录
      const skillNames = library.skills.map((s) => s.name);
      this.config.disabledSkills = this.config.disabledSkills.filter(
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
    const parsed = parseRepoUrl(url);
    if (!parsed) {
      return {
        success: false,
        error: `Invalid repository URL: ${url}`,
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
      // The actual path is filled by repository layout detection after download.
      skillsPath: '.',
      category: 'community',
      recommended: false,
      author: parsed.owner,
    };

    // 下载仓库
    return this.downloadRepository(repo);
  }

  /**
   * Download and inspect a repository without mutating installed libraries or
   * skill-config.json.
   */
  async stageRepository(url: string, name?: string): Promise<StageRepositoryResult> {
    await this.initialize();

    const parsed = parseRepoUrl(url);
    if (!parsed) {
      return {
        success: false,
        error: `Invalid repository URL: ${url}`,
      };
    }

    const repoId = `${parsed.owner}-${parsed.repo}`.toLowerCase();
    const repoName = name || `${parsed.owner}/${parsed.repo}`;
    const stageId = randomUUID();
    const stagePath = path.join(this.stagingDir, stageId);

    try {
      const result = await downloadRepository({
        source: parsed.source,
        owner: parsed.owner,
        repo: parsed.repo,
        branch: parsed.branch,
        targetDir: stagePath,
        modelScopeRepoType: parsed.source === 'modelscope' ? parsed.repoType : undefined,
      });
      if (!result.success) {
        await fs.rm(stagePath, { recursive: true, force: true });
        return {
          success: false,
          error: result.error || 'Repository staging download failed',
        };
      }

      const layout = await detectRepositoryLayout(stagePath);
      const skillDirectories = await this.getSkillDirectories(stagePath, layout);
      const skills: StagedSkillPreview[] = [];
      const warnings: string[] = [];

      for (const skillDirectory of skillDirectories) {
        const parsedSkill = await parseSkillMd(skillDirectory, 'library');
        const skillMdContent = await fs.readFile(
          path.join(skillDirectory, 'SKILL.md'),
          'utf-8'
        );
        skills.push({
          name: parsedSkill.name,
          description: parsedSkill.description,
          skillMdContent,
        });
        if (parsedSkill.frontmatterWarnings) {
          warnings.push(
            ...parsedSkill.frontmatterWarnings.map(
              (warning) => `${parsedSkill.name}: ${warning}`
            )
          );
        }
      }

      const repository: SkillRepository = {
        id: repoId,
        name: repoName,
        url,
        branch: parsed.branch,
        skillsPath: layout.skillsPath,
        category: 'community',
        recommended: false,
        author: parsed.owner,
      };
      this.stagedRepositories.set(stageId, {
        stageId,
        repoId,
        repoName,
        sourceType: parsed.source,
        repository,
        localPath: stagePath,
        layout,
      });

      return {
        success: true,
        stageId,
        repoId,
        repoName,
        sourceType: parsed.source,
        layout: layout.layout,
        skills,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown staging error',
      };
    }
  }

  /** Confirm a staged install by atomically moving it into the installed root. */
  async confirmStagedRepository(stageId: string): Promise<DownloadResult> {
    await this.initialize();

    const staged = this.stagedRepositories.get(stageId);
    if (!staged) {
      return {
        success: false,
        error: `Staged repository not found: ${stageId}`,
      };
    }

    const targetPath = path.join(this.skillsDir, staged.repoId);
    if (this.libraries.has(staged.repoId) || await this.pathExists(targetPath)) {
      return {
        success: false,
        error: `Repository already exists: ${staged.repoId}`,
      };
    }

    try {
      const meta = await readRepoMetaAsync(staged.localPath);
      if (meta) {
        await saveRepoMeta(staged.localPath, {
          ...meta,
          skillsPath: staged.layout.skillsPath,
        });
      }

      await fs.rename(staged.localPath, targetPath);
      const skills = await this.scanSkillsInLibrary(targetPath, staged.layout);
      const installedMeta = await readRepoMetaAsync(targetPath);
      const now = Date.now();
      const library: LocalSkillLibrary = {
        repoId: staged.repoId,
        repoName: staged.repoName,
        localPath: targetPath,
        downloadedAt: installedMeta?.downloadedAt || now,
        lastUpdated: installedMeta?.lastUpdated || now,
        version: installedMeta?.commitHash,
        skills,
      };

      this.libraries.set(staged.repoId, library);
      this.config.repositories.push(staged.repository);
      await this.saveConfig();
      this.stagedRepositories.delete(stageId);

      return {
        success: true,
        localPath: targetPath,
        library,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown confirmation error',
      };
    }
  }

  /** Delete staged content without changing installed state. */
  async cancelStagedRepository(stageId: string): Promise<void> {
    await this.initialize();

    const staged = this.stagedRepositories.get(stageId);
    if (!staged) {
      throw new Error(`Staged repository not found: ${stageId}`);
    }
    await fs.rm(staged.localPath, { recursive: true, force: true });
    this.stagedRepositories.delete(stageId);
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
  // Skill Enable/Disable（黑名单语义：默认启用，禁用进 disabledSkills）
  // ==========================================================================

  /**
   * 启用 skill（从黑名单移除）
   */
  enableSkill(skillName: string): void {
    if (this.config.disabledSkills.includes(skillName)) {
      this.config.disabledSkills = this.config.disabledSkills.filter((s) => s !== skillName);
      this.updateSkillEnabledStatus(skillName, true);
      this.saveConfig();
    }
  }

  /**
   * 禁用 skill（加入黑名单）
   */
  disableSkill(skillName: string): void {
    if (!this.config.disabledSkills.includes(skillName)) {
      this.config.disabledSkills.push(skillName);
      this.updateSkillEnabledStatus(skillName, false);
      this.saveConfig();
    }
  }

  /**
   * 检查 skill 是否启用（不在黑名单 = 启用）
   */
  isSkillEnabled(skillName: string): boolean {
    return !this.config.disabledSkills.includes(skillName);
  }

  /**
   * 获取所有被禁用的 skills
   */
  getDisabledSkills(): string[] {
    return [...this.config.disabledSkills];
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
        disabledSkills: loaded.disabledSkills || [],
        autoDownload: loaded.autoDownload || getDefaultAutoDownloadRepos(),
      };

      logger.debug('Config loaded', {
        repositoryCount: this.config.repositories.length,
        disabledSkillCount: this.config.disabledSkills.length,
      });
    } catch {
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

        const layout = await detectRepositoryLayout(libraryPath);
        const skills = await this.scanSkillsInLibrary(libraryPath, layout);

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
    layout: RepositoryLayout
  ): Promise<LocalSkillInfo[]> {
    const skills: LocalSkillInfo[] = [];

    if (layout.layout === 'single-skill') {
      try {
        const parsed = await parseSkillMd(libraryPath, 'library');
        return [{
          name: parsed.name,
          description: parsed.description,
          libraryId: path.basename(libraryPath),
          localPath: libraryPath,
          enabled: !this.config.disabledSkills.includes(parsed.name),
        }];
      } catch (parseError) {
        logger.warn('Failed to parse single-skill repository', {
          libraryPath,
          error: parseError instanceof Error ? parseError.message : 'Unknown error',
        });
        return [];
      }
    }

    const skillsDir = layout.skillsPath === '.'
      ? libraryPath
      : path.join(libraryPath, layout.skillsPath);

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
            enabled: !this.config.disabledSkills.includes(parsed.name),
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

  private async getSkillDirectories(
    libraryPath: string,
    layout: RepositoryLayout
  ): Promise<string[]> {
    if (layout.layout === 'single-skill') {
      return [libraryPath];
    }

    const skillsDir = layout.skillsPath === '.'
      ? libraryPath
      : path.join(libraryPath, layout.skillsPath);
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skillDirectories: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const skillDirectory = path.join(skillsDir, entry.name);
      if (await hasSkillMd(skillDirectory)) {
        skillDirectories.push(skillDirectory);
      }
    }
    return skillDirectories;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
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

getServiceRegistry().register('SkillRepositoryService', getSkillRepositoryService());
export { SkillRepositoryService };
