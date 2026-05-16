// ============================================================================
// Skill Discovery Service - Agent Skills Standard
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ParsedSkill, SkillSource } from '../../../shared/contract/agentSkill';
import { parseSkillMetadataOnly, hasSkillMd } from './skillParser';
import { bridgeCloudSkill } from './skillBridge';
import { getBuiltinSkills } from './builtinSkills';
import { getCloudConfigService } from '../cloud';
import { createLogger } from '../infra/logger';
import { getToolSearchService } from '../toolSearch';
import { getSkillsDir, getUserConfigDir } from '../../config';

const logger = createLogger('SkillDiscoveryService');
const INCLUDE_CLAUDE_LEGACY_SKILLS_ENV = 'CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS';
const SKILL_METADATA_CACHE_VERSION = 2;
const SKILL_METADATA_CACHE_FILE = 'skill-metadata-index-v2.json';

export interface SkillDiscoveryServiceOptions {
  includeClaudeLegacySkills?: boolean;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function shouldIncludeClaudeLegacySkills(options: SkillDiscoveryServiceOptions): boolean {
  if (options.includeClaudeLegacySkills !== undefined) {
    return options.includeClaudeLegacySkills;
  }

  const envValue = process.env[INCLUDE_CLAUDE_LEGACY_SKILLS_ENV];
  if (isTruthyEnv(envValue)) return true;
  if (isFalsyEnv(envValue)) return false;
  return true;
}

/**
 * 库元数据接口
 */
interface LibraryMeta {
  repoId: string;
  repoName: string;
  skillsPath?: string;
  downloadedAt?: number;
  lastUpdated?: number;
  version?: string;
}

interface SkillMetadataCacheEntry {
  source: SkillSource;
  mtimeMs: number;
  size: number;
  skill: ParsedSkill;
}

interface SkillMetadataCachePayload {
  version: number;
  entries: Record<string, SkillMetadataCacheEntry>;
}

/**
 * Skill 发现服务
 *
 * 负责从多个来源发现和加载 Skills：
 * 1. 用户级目录: ~/.code-agent/skills/
 * 2. 项目级目录: .code-agent/skills/
 * 3. Claude legacy 目录: 默认纳入发现，实际内容仍按需加载
 * 4. 内置 Skills (从 cloudConfigService 转换)
 *
 * 优先级：项目 > 用户 > 内置（后加载的覆盖先加载的）
 */
class SkillDiscoveryService {
  private skills: Map<string, ParsedSkill> = new Map();
  private initialized = false;
  private workingDirectory = '';
  private readonly includeClaudeLegacySkills: boolean;
  private readonly metadataCachePath = path.join(
    getUserConfigDir(),
    'cache',
    SKILL_METADATA_CACHE_FILE
  );
  private metadataCache = new Map<string, SkillMetadataCacheEntry>();
  private metadataCacheLoaded = false;
  private metadataCacheDirty = false;
  /** 初始化中的 promise，用于 fire-and-forget 场景下的并发锁 */
  private initPromise: Promise<void> | null = null;

  constructor(options: SkillDiscoveryServiceOptions = {}) {
    this.includeClaudeLegacySkills = shouldIncludeClaudeLegacySkills(options);
  }

  private normalizeWorkingDirectory(workingDirectory: string): string {
    return path.resolve(workingDirectory);
  }

  /**
   * 初始化 Skill 发现服务
   *
   * @param workingDirectory - 当前工作目录
   */
  async initialize(workingDirectory: string): Promise<void> {
    const normalized = this.normalizeWorkingDirectory(workingDirectory);

    // 并发锁：若同目录的 init 正在跑，复用同一个 promise
    if (this.initPromise && this.workingDirectory === normalized) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize(normalized);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(normalizedDir: string): Promise<void> {
    this.workingDirectory = normalizedDir;
    this.skills.clear();
    await this.loadMetadataCache();

    // 1. 加载内置 Skills（最低优先级）
    await this.loadBuiltinSkills();

    // 2. 加载用户级 Skills。Claude legacy 参与发现，内容仍保持懒加载。
    const skillsDirs = getSkillsDir(this.workingDirectory);
    if (this.includeClaudeLegacySkills) {
      await this.scanDirectory(skillsDirs.user.legacy, 'user');
    } else {
      logger.debug('Skipping Claude legacy user skills directory by configuration', {
        dir: skillsDirs.user.legacy,
        optInEnv: INCLUDE_CLAUDE_LEGACY_SKILLS_ENV,
      });
    }
    await this.scanDirectory(skillsDirs.user.new, 'user');

    // 3. 加载远程库 Skills
    await this.loadFromLibraries();

    // 4. 加载项目级 Skills（最高优先级）
    if (skillsDirs.project) {
      if (this.includeClaudeLegacySkills) {
        await this.scanDirectory(skillsDirs.project.legacy, 'project');
      } else {
        logger.debug('Skipping Claude legacy project skills directory by configuration', {
          dir: skillsDirs.project.legacy,
          optInEnv: INCLUDE_CLAUDE_LEGACY_SKILLS_ENV,
        });
      }
      await this.scanDirectory(skillsDirs.project.new, 'project');
    }

    this.initialized = true;
    await this.persistMetadataCache();
    logger.info('Skill discovery completed', {
      total: this.skills.size,
      skills: Array.from(this.skills.keys()),
    });

    // 注册 Skills 到 ToolSearchService，支持通过 tool_search 发现
    this.registerSkillsToToolSearch();
  }

  /**
   * Ensure the discovery state matches the requested working directory.
   * Long-lived desktop/web processes can switch projects between runs.
   */
  async ensureInitialized(workingDirectory: string): Promise<void> {
    const normalized = this.normalizeWorkingDirectory(workingDirectory);

    // 已经在跑同目录的 init，直接等它
    if (this.initPromise && this.workingDirectory === normalized) {
      return this.initPromise;
    }

    if (!this.initialized || this.workingDirectory !== normalized) {
      await this.initialize(normalized);
    }
  }

  /**
   * 将发现的 Skills 注册到 ToolSearchService
   * 使模型可以通过 tool_search 发现可用的 skills
   */
  private registerSkillsToToolSearch(): void {
    try {
      const toolSearchService = getToolSearchService();
      toolSearchService.clearSkills(); // 清除旧的 skills

      const skillsToRegister = Array.from(this.skills.values()).map(skill => ({
        name: skill.name,
        description: skill.description,
        aliases: skill.aliases,
      }));

      toolSearchService.registerSkills(skillsToRegister);
      logger.debug('Registered skills to ToolSearchService', {
        count: skillsToRegister.length,
      });
    } catch (error) {
      logger.warn('Failed to register skills to ToolSearchService', { error });
    }
  }

  /**
   * 加载内置 Skills（从 builtinSkills.ts 和云端配置）
   */
  private async loadBuiltinSkills(): Promise<void> {
    // 1. 先加载 builtinSkills.ts 中的 skills（优先级较低）
    try {
      const localBuiltins = getBuiltinSkills();
      for (const skill of localBuiltins) {
        this.skills.set(skill.name, skill);
      }
      logger.debug('Loaded local builtin skills', { count: localBuiltins.length });
    } catch (error) {
      logger.warn('Failed to load local builtin skills', { error });
    }

    // 2. 再加载云端配置的 skills（优先级较高，会覆盖同名 skill）
    try {
      const cloudSkills = getCloudConfigService().getSkills();
      for (const skill of cloudSkills) {
        const parsed = bridgeCloudSkill(skill);
        this.skills.set(parsed.name, parsed);
      }
      logger.debug('Loaded cloud builtin skills', { count: cloudSkills.length });
    } catch (error) {
      logger.warn('Failed to load cloud builtin skills', { error });
    }
  }

  /**
   * 扫描目录中的 Skills
   *
   * @param dir - 要扫描的目录
   * @param source - Skill 来源标识
   */
  private async scanDirectory(
    dir: string,
    source: SkillSource
  ): Promise<void> {
    try {
      // 检查目录是否存在
      await fs.access(dir);
    } catch {
      // 目录不存在，跳过
      logger.debug('Skills directory not found', { dir });
      return;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(dir, entry.name);

        // 检查是否包含 SKILL.md
        if (!(await hasSkillMd(skillDir))) {
          continue;
        }

        try {
          const skill = await this.readSkillMetadata(skillDir, source);
          this.skills.set(skill.name, skill);
          logger.debug('Loaded skill', {
            name: skill.name,
            source,
            path: skillDir,
          });
        } catch (error) {
          logger.warn('Failed to parse skill', {
            dir: skillDir,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      logger.error('Failed to scan skills directory', { dir, error });
    }
  }

  /**
   * 从远程库目录加载 Skills
   * 路径: ~/.code-agent/skills/
   */
  private async loadFromLibraries(): Promise<void> {
    const librariesDir = path.join(getUserConfigDir(), 'skills');

    try {
      await fs.access(librariesDir);
    } catch {
      logger.debug('Libraries directory not found', { dir: librariesDir });
      return;
    }

    try {
      const entries = await fs.readdir(librariesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const libraryPath = path.join(librariesDir, entry.name);

        // 读取 .meta.json 获取 skillsPath
        const metaPath = path.join(libraryPath, '.meta.json');
        let skillsSubPath = '.'; // 默认 skills 在根目录

        try {
          const metaContent = await fs.readFile(metaPath, 'utf-8');
          const meta = JSON.parse(metaContent) as LibraryMeta;
          skillsSubPath = meta.skillsPath || '.';
          logger.debug('Loaded library meta', {
            library: entry.name,
            skillsPath: skillsSubPath,
          });
        } catch {
          // 没有 meta 文件，使用默认值
          logger.debug('No meta file found, using default skillsPath', {
            library: entry.name,
          });
        }

        const skillsDir = path.join(libraryPath, skillsSubPath);
        await this.scanDirectory(skillsDir, 'library');
      }

      logger.debug('Loaded skills from libraries', {
        libraryCount: entries.filter((e) => e.isDirectory()).length,
      });
    } catch (error) {
      logger.error('Failed to load from libraries', { error });
    }
  }

  /**
   * 刷新远程库 Skills
   * 在下载/更新/删除仓库后调用
   */
  async refreshLibraries(): Promise<void> {
    // 清除 library 来源的 skills
    for (const [name, skill] of this.skills) {
      if (skill.source === 'library') {
        this.skills.delete(name);
      }
    }

    // 重新加载
    await this.loadFromLibraries();
    await this.persistMetadataCache();

    logger.info('Libraries refreshed', {
      librarySkills: Array.from(this.skills.values()).filter(
        (s) => s.source === 'library'
      ).length,
    });
  }

  /**
   * 获取指定名称的 Skill
   */
  getSkill(name: string): ParsedSkill | undefined {
    return this.skills.get(name);
  }

  /**
   * 获取所有已加载的 Skills
   */
  getAllSkills(): ParsedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取可供模型上下文使用的 Skills
   * 排除 disableModelInvocation = true 的 Skills
   */
  getSkillsForContext(): ParsedSkill[] {
    return this.getAllSkills().filter((s) => !s.disableModelInvocation);
  }

  /**
   * 获取用户可通过 /name 调用的 Skills
   */
  getUserInvocableSkills(): ParsedSkill[] {
    return this.getAllSkills().filter((s) => s.userInvocable);
  }

  /**
   * 检查服务是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取当前初始化所使用的工作目录
   */
  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  /**
   * 重新加载所有 Skills
   */
  async reload(): Promise<void> {
    if (this.workingDirectory) {
      await this.initialize(this.workingDirectory);
    }
  }

  /**
   * 获取 Skills 统计信息
   */
  getStats(): {
    total: number;
    bySource: Record<SkillSource, number>;
    userInvocable: number;
    modelAvailable: number;
  } {
    const skills = this.getAllSkills();
    const bySource: Record<SkillSource, number> = {
      user: 0,
      project: 0,
      plugin: 0,
      builtin: 0,
      cloud: 0,
      library: 0,
    };

    for (const skill of skills) {
      bySource[skill.source]++;
    }

    return {
      total: skills.length,
      bySource,
      userInvocable: this.getUserInvocableSkills().length,
      modelAvailable: this.getSkillsForContext().length,
    };
  }

  private getMetadataCacheKey(skillPath: string, source: SkillSource): string {
    return `${source}:${path.resolve(skillPath)}`;
  }

  private cloneCachedSkill(skill: ParsedSkill, basePathOverride?: string): ParsedSkill {
    return {
      ...skill,
      basePath: basePathOverride ?? skill.basePath,
      aliases: skill.aliases ? [...skill.aliases] : undefined,
      allowedTools: [...skill.allowedTools],
      metadata: skill.metadata ? { ...skill.metadata } : undefined,
      bins: skill.bins ? [...skill.bins] : undefined,
      envVars: skill.envVars ? [...skill.envVars] : undefined,
      references: skill.references ? [...skill.references] : undefined,
      promptContent: '',
      loaded: false,
      referenceContents: undefined,
      dependencyStatus: undefined,
    };
  }

  private async loadMetadataCache(): Promise<void> {
    if (this.metadataCacheLoaded) return;

    try {
      const content = await fs.readFile(this.metadataCachePath, 'utf-8');
      const payload = JSON.parse(content) as SkillMetadataCachePayload;
      if (payload.version === SKILL_METADATA_CACHE_VERSION && payload.entries) {
        this.metadataCache = new Map(Object.entries(payload.entries));
      }
      logger.debug('Loaded skill metadata cache', {
        entries: this.metadataCache.size,
        path: this.metadataCachePath,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        logger.warn('Failed to load skill metadata cache', {
          path: this.metadataCachePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.metadataCacheLoaded = true;
    }
  }

  private async persistMetadataCache(): Promise<void> {
    if (!this.metadataCacheLoaded || !this.metadataCacheDirty) return;

    const payload: SkillMetadataCachePayload = {
      version: SKILL_METADATA_CACHE_VERSION,
      entries: Object.fromEntries(this.metadataCache.entries()),
    };

    try {
      await fs.mkdir(path.dirname(this.metadataCachePath), { recursive: true });
      await fs.writeFile(this.metadataCachePath, JSON.stringify(payload, null, 2), 'utf-8');
      this.metadataCacheDirty = false;
      logger.debug('Persisted skill metadata cache', {
        entries: this.metadataCache.size,
        path: this.metadataCachePath,
      });
    } catch (error) {
      logger.warn('Failed to persist skill metadata cache', {
        path: this.metadataCachePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readSkillMetadata(skillDir: string, source: SkillSource): Promise<ParsedSkill> {
    const skillPath = path.join(skillDir, 'SKILL.md');
    const stat = await fs.stat(skillPath);
    const cacheKey = this.getMetadataCacheKey(skillPath, source);
    const cached = this.metadataCache.get(cacheKey);

    if (
      cached?.source === source &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      const skill = this.cloneCachedSkill(cached.skill, skillDir);
      logger.debug('Loaded skill metadata from cache', {
        name: skill.name,
        source,
        path: skillDir,
      });
      return skill;
    }

    const parsed = await parseSkillMetadataOnly(skillDir, source);
    this.metadataCache.set(cacheKey, {
      source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      skill: this.cloneCachedSkill(parsed, skillDir),
    });
    this.metadataCacheDirty = true;
    return parsed;
  }
}

// Global singleton
let globalInstance: SkillDiscoveryService | null = null;

/**
 * 获取全局 SkillDiscoveryService 实例
 */
export function getSkillDiscoveryService(): SkillDiscoveryService {
  if (!globalInstance) {
    globalInstance = new SkillDiscoveryService();
  }
  return globalInstance;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetSkillDiscoveryService(): void {
  globalInstance = null;
}

export { SkillDiscoveryService };
