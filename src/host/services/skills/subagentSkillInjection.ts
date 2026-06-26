// ============================================================================
// Subagent Skill Injection — 子代理 skills 全文预注入（GAP-011，课程"方向 A"）
// SubagentConfig.skills 声明的 SKILL.md 在 spawn 时一次性全量注入子代理
// system prompt（知识注入），与 availableTools 权限边界（GAP-001 fork 限权）
// 正交：注入 skill 不扩张子代理的工具集。
// ============================================================================

import { getSkillDiscoveryService } from './skillDiscoveryService';
import { loadSkillContent } from './skillLoader';
import { createLogger } from '../infra/logger';

const logger = createLogger('SubagentSkillInjection');

export interface SubagentSkillsBlockResult {
  /** 拼进 system prompt 的块；没有任何 skill 加载成功时为 null */
  block: string | null;
  /** 成功加载的 skill 名 */
  loaded: string[];
  /** 未找到或加载失败的 skill 名 */
  missing: string[];
}

/**
 * 按 skill 名加载 SKILL.md 全文，构建子代理 system prompt 注入块。
 * 全量加载（非渐进式披露）——课程第 12 讲："SubAgent 中 skills 字段是全量加载"。
 */
export async function buildSubagentSkillsBlock(
  skillNames: string[],
): Promise<SubagentSkillsBlockResult> {
  const loaded: string[] = [];
  const missing: string[] = [];
  const sections: string[] = [];

  const discovery = getSkillDiscoveryService();

  for (const name of skillNames) {
    const skill = discovery.getSkill(name);
    if (!skill) {
      missing.push(name);
      logger.warn('Subagent skill not found in discovery', { name });
      continue;
    }

    try {
      await loadSkillContent(skill);
    } catch (error) {
      missing.push(name);
      logger.warn('Failed to load subagent skill content', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    loaded.push(name);
    sections.push(
      [
        `<skill name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        '',
        `> ${skill.description}`,
        '',
        skill.promptContent,
        '</skill>',
      ].join('\n'),
    );
  }

  if (sections.length === 0) {
    return { block: null, loaded, missing };
  }

  const block = [
    '<preloaded_skills>',
    '以下 skill 已预装为你的领域知识。执行任务时直接运用这些方法论，无需再请求加载：',
    '',
    ...sections,
    '</preloaded_skills>',
  ].join('\n');

  return { block, loaded, missing };
}
