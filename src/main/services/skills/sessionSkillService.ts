// ============================================================================
// Session Skill Service
// 会话级 Skill 挂载管理服务
// ============================================================================

import type {
  SessionSkillMount,
  SkillRecommendation,
} from '../../../shared/types/skillRepository';
import type { ParsedSkill } from '../../../shared/types/agentSkill';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { SKILL_KEYWORDS, DEFAULT_ENABLED_SKILLS } from './skillRepositories';
import { createLogger } from '../infra/logger';

const logger = createLogger('SessionSkillService');

/**
 * 会话级 Skill 挂载服务
 * 管理每个会话挂载的 skills
 */
class SessionSkillService {
  // 会话挂载状态: sessionId -> mounted skills
  private sessionMounts: Map<string, SessionSkillMount[]> = new Map();

  /**
   * 获取会话当前挂载的 skills
   */
  getMountedSkills(sessionId: string): SessionSkillMount[] {
    return this.sessionMounts.get(sessionId) || [];
  }

  /**
   * 获取会话挂载的 ParsedSkill 对象列表
   */
  getMountedParsedSkills(sessionId: string): ParsedSkill[] {
    const mounts = this.getMountedSkills(sessionId);
    const discoveryService = getSkillDiscoveryService();

    return mounts
      .map((mount) => discoveryService.getSkill(mount.skillName))
      .filter((skill): skill is ParsedSkill => skill !== undefined);
  }

  /**
   * 挂载 skill 到会话
   */
  mountSkill(
    sessionId: string,
    skillName: string,
    libraryId: string,
    source: 'auto' | 'manual' | 'recommended' = 'manual'
  ): boolean {
    const mounts = this.sessionMounts.get(sessionId) || [];

    // 检查是否已挂载
    if (mounts.some((m) => m.skillName === skillName)) {
      logger.debug('Skill already mounted', { sessionId, skillName });
      return false;
    }

    // 检查 skill 是否存在
    const discoveryService = getSkillDiscoveryService();
    const skill = discoveryService.getSkill(skillName);
    if (!skill) {
      logger.warn('Skill not found', { skillName });
      return false;
    }

    mounts.push({
      skillName,
      libraryId,
      mountedAt: Date.now(),
      source,
    });

    this.sessionMounts.set(sessionId, mounts);
    logger.info('Skill mounted', { sessionId, skillName, source });
    return true;
  }

  /**
   * 从会话卸载 skill
   */
  unmountSkill(sessionId: string, skillName: string): boolean {
    const mounts = this.sessionMounts.get(sessionId);
    if (!mounts) return false;

    const index = mounts.findIndex((m) => m.skillName === skillName);
    if (index === -1) return false;

    mounts.splice(index, 1);
    logger.info('Skill unmounted', { sessionId, skillName });
    return true;
  }

  /**
   * 自动挂载默认启用的 skills
   * 在新会话创建时调用
   */
  autoMountDefaultSkills(sessionId: string): void {
    // 遍历 DEFAULT_ENABLED_SKILLS，挂载所有默认启用的 skills
    for (const [libraryId, skillNames] of Object.entries(DEFAULT_ENABLED_SKILLS)) {
      for (const skillName of skillNames) {
        this.mountSkill(sessionId, skillName, libraryId, 'auto');
      }
    }
    logger.info('Auto-mounted default skills', {
      sessionId,
      count: this.getMountedSkills(sessionId).length,
    });
  }

  /**
   * 根据用户输入推荐 skills
   */
  recommendSkills(sessionId: string, userInput: string): SkillRecommendation[] {
    const input = userInput.toLowerCase();
    const mounted = this.getMountedSkills(sessionId);
    const mountedNames = new Set(mounted.map((m) => m.skillName));
    const discoveryService = getSkillDiscoveryService();
    const allSkills = discoveryService.getAllSkills();

    const recommendations: SkillRecommendation[] = [];

    for (const [skillName, keywords] of Object.entries(SKILL_KEYWORDS)) {
      // 跳过已挂载的
      if (mountedNames.has(skillName)) continue;

      // 检查关键词匹配
      const matchedKeywords: string[] = [];
      let matchScore = 0;

      for (const keyword of keywords) {
        if (input.includes(keyword.toLowerCase())) {
          matchedKeywords.push(keyword);
          matchScore += 1;
        }
      }

      if (matchScore > 0) {
        const skill = allSkills.find((s) => s.name === skillName);
        if (skill) {
          // 确定所属库 ID
          const libraryId = skill.source === 'builtin' ? 'builtin' : skill.basePath;

          recommendations.push({
            skillName: skill.name,
            libraryId,
            reason: `匹配关键词: ${matchedKeywords.join(', ')}`,
            score: matchScore / keywords.length, // 归一化到 0-1
          });
        }
      }
    }

    // 按匹配分数排序
    return recommendations.sort((a, b) => b.score - a.score);
  }

  /**
   * 批量挂载 skills
   */
  mountSkills(
    sessionId: string,
    skills: Array<{ skillName: string; libraryId: string }>,
    source: 'auto' | 'manual' | 'recommended' = 'manual'
  ): number {
    let mountedCount = 0;
    for (const { skillName, libraryId } of skills) {
      if (this.mountSkill(sessionId, skillName, libraryId, source)) {
        mountedCount++;
      }
    }
    return mountedCount;
  }

  /**
   * 清理会话数据
   */
  clearSession(sessionId: string): void {
    this.sessionMounts.delete(sessionId);
    logger.debug('Session cleared', { sessionId });
  }

  /**
   * 获取所有会话的统计信息
   */
  getStats(): { sessionCount: number; totalMounts: number } {
    let totalMounts = 0;
    for (const mounts of this.sessionMounts.values()) {
      totalMounts += mounts.length;
    }
    return {
      sessionCount: this.sessionMounts.size,
      totalMounts,
    };
  }

  /**
   * 检查 skill 是否已挂载到会话
   */
  isSkillMounted(sessionId: string, skillName: string): boolean {
    const mounts = this.sessionMounts.get(sessionId);
    if (!mounts) return false;
    return mounts.some((m) => m.skillName === skillName);
  }

  /**
   * 获取会话挂载的 skill 名称列表
   */
  getMountedSkillNames(sessionId: string): string[] {
    return this.getMountedSkills(sessionId).map((m) => m.skillName);
  }
}

// 全局单例
let globalInstance: SessionSkillService | null = null;

export function getSessionSkillService(): SessionSkillService {
  if (!globalInstance) {
    globalInstance = new SessionSkillService();
  }
  return globalInstance;
}

export function resetSessionSkillService(): void {
  globalInstance = null;
}

export { SessionSkillService };
