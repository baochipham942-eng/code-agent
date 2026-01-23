// ============================================================================
// Skill Discovery Service - Agent Skills Standard
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ParsedSkill, SkillSource } from '../../../shared/types/agentSkill';
import { parseSkillMd, hasSkillMd } from './skillParser';
import { bridgeCloudSkill } from './skillBridge';
import { getCloudConfigService } from '../cloud';
import { createLogger } from '../infra/logger';

const logger = createLogger('SkillDiscoveryService');

/**
 * Skill 发现服务
 *
 * 负责从多个来源发现和加载 Skills：
 * 1. 用户级目录: ~/.claude/skills/
 * 2. 项目级目录: .claude/skills/
 * 3. 内置 Skills (从 cloudConfigService 转换)
 *
 * 优先级：项目 > 用户 > 内置（后加载的覆盖先加载的）
 */
class SkillDiscoveryService {
  private skills: Map<string, ParsedSkill> = new Map();
  private initialized = false;
  private workingDirectory = '';

  /**
   * 初始化 Skill 发现服务
   *
   * @param workingDirectory - 当前工作目录
   */
  async initialize(workingDirectory: string): Promise<void> {
    this.workingDirectory = workingDirectory;
    this.skills.clear();

    // 1. 加载内置 Skills（最低优先级）
    await this.loadBuiltinSkills();

    // 2. 加载用户级 Skills
    const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    await this.scanDirectory(userSkillsDir, 'user');

    // 3. 加载项目级 Skills（最高优先级）
    const projectSkillsDir = path.join(workingDirectory, '.claude', 'skills');
    await this.scanDirectory(projectSkillsDir, 'project');

    this.initialized = true;
    logger.info('Skill discovery completed', {
      total: this.skills.size,
      skills: Array.from(this.skills.keys()),
    });
  }

  /**
   * 从云端配置加载内置 Skills
   */
  private async loadBuiltinSkills(): Promise<void> {
    try {
      const cloudSkills = getCloudConfigService().getSkills();
      for (const skill of cloudSkills) {
        const parsed = bridgeCloudSkill(skill);
        this.skills.set(parsed.name, parsed);
      }
      logger.debug('Loaded builtin skills', { count: cloudSkills.length });
    } catch (error) {
      logger.warn('Failed to load builtin skills', { error });
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
          const skill = await parseSkillMd(skillDir, source);
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
