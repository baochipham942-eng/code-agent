// ============================================================================
// Session Skill Service
// 会话级 Skill 挂载管理服务
// ============================================================================

import type {
  SessionSkillMount,
  SkillRecommendation,
} from '../../../shared/contract/skillRepository';
import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { getSkillInvocationAliases } from './skillInvocationResolver';
import { SKILL_KEYWORDS, DEFAULT_ENABLED_SKILLS } from './skillRepositories';
import { createLogger } from '../infra/logger';
import { getContextHealthService } from '../../context/contextHealthService';
import { estimateTokens } from '../../context/tokenEstimator';
import { loadSkillContent } from './skillLoader';

const logger = createLogger('SessionSkillService');

function getSkillLibraryId(skill: ParsedSkill): string {
  if (skill.source === 'builtin') return 'builtin';
  if (skill.source === 'cloud') return 'cloud';
  return skill.basePath;
}

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
      return true;
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

    // 异步上报 token 贡献到 ContextHealthService（不阻塞 mount）
    this.reportSkillTokens(sessionId, skill).catch((err) => {
      logger.debug('Failed to report skill token contribution', {
        skillName,
        error: err instanceof Error ? err.message : String(err),
      });
    });

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

    // 同步从 bySource 移除该 skill 占用
    try {
      getContextHealthService().clearSourceContribution(sessionId, {
        type: 'skill',
        name: skillName,
      });
    } catch (err) {
      logger.debug('Failed to clear skill token contribution', { skillName, err });
    }

    return true;
  }

  /**
   * 上报 skill 的 token 贡献（按需懒加载 content 后估算）
   * 使用 'set' 模式：替换该 skill 的累计占用，避免重复挂载时重复累加
   */
  private async reportSkillTokens(sessionId: string, skill: ParsedSkill): Promise<void> {
    if (!skill.loaded) {
      await loadSkillContent(skill);
    }
    const tokens = estimateTokens(skill.promptContent ?? '');
    getContextHealthService().recordSourceContribution(
      sessionId,
      { type: 'skill', name: skill.name },
      tokens,
      'set',
    );
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
    // getUserInvocableSkills 已过滤被全局禁用的 skill
    const allSkills = discoveryService.getUserInvocableSkills();

    if (!input.trim()) {
      return [];
    }

    const recommendationMap = new Map<string, SkillRecommendation>();

    for (const skill of allSkills) {
      // 跳过已挂载的
      if (mountedNames.has(skill.name)) continue;

      const aliases = getSkillInvocationAliases(skill)
        .map((alias) => alias.value)
        .filter((alias) => input.includes(alias.toLowerCase()));
      if (aliases.length === 0) continue;

      const score = Math.min(0.95, 0.55 + aliases.length * 0.12);
      recommendationMap.set(skill.name, {
        skillName: skill.name,
        libraryId: getSkillLibraryId(skill),
        reason: `匹配语义: ${aliases.slice(0, 3).join(', ')}`,
        score,
      });
    }

    for (const [skillName, keywords] of Object.entries(SKILL_KEYWORDS)) {
      // 跳过已挂载的
      if (mountedNames.has(skillName)) continue;
      const skill = allSkills.find((s) => s.name === skillName);
      if (!skill) continue;

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
        const previous = recommendationMap.get(skill.name);
        const score = Math.min(0.98, matchScore / keywords.length + 0.15);
        if (!previous || score > previous.score) {
          recommendationMap.set(skill.name, {
            skillName: skill.name,
            libraryId: getSkillLibraryId(skill),
            reason: `匹配关键词: ${matchedKeywords.join(', ')}`,
            score,
          });
        }
      }
    }

    // 按匹配分数排序
    return Array.from(recommendationMap.values()).sort((a, b) => b.score - a.score);
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
