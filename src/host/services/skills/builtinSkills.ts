// ============================================================================
// Built-in Skills - 内置 Skill accessor 层（数据见 builtinSkillsData.ts）
// ============================================================================

import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import { refreshFrontendSlidesBasePath } from './builtinFrontendSlides';
import { BUILTIN_SKILLS } from './builtinSkillsData';

export { BUILTIN_SKILLS };

/**
 * 获取所有内置 Skills
 */
export function getBuiltinSkills(): ParsedSkill[] {
  refreshFrontendSlidesBasePath();
  return BUILTIN_SKILLS;
}

/**
 * 按名称获取内置 Skill
 */
export function getBuiltinSkill(name: string): ParsedSkill | undefined {
  refreshFrontendSlidesBasePath();
  return BUILTIN_SKILLS.find(skill => skill.name === name);
}

/**
 * 检查是否为内置 Skill
 */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.some(skill => skill.name === name);
}
