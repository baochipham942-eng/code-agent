// ============================================================================
// Skill Bridge - 兼容性桥接层
// 将旧的 SkillDefinition 转换为新的 ParsedSkill
// ============================================================================

import type { SkillDefinition } from '../../../shared/types/skill';
import type { ParsedSkill } from '../../../shared/types/agentSkill';

/**
 * 将云端/旧格式的 SkillDefinition 转换为 ParsedSkill
 *
 * @param old - 旧格式的 SkillDefinition
 * @returns 新格式的 ParsedSkill
 */
export function bridgeCloudSkill(old: SkillDefinition): ParsedSkill {
  return {
    // Agent Skills 标准字段
    name: old.name,
    description: old.description,

    // 内容
    promptContent: old.prompt,
    basePath: '',

    // 执行控制
    allowedTools: old.tools || [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',

    // 来源
    source: 'builtin',
  };
}

/**
 * 将 ParsedSkill 转换回 SkillDefinition
 * 用于向后兼容需要旧格式的地方
 *
 * @param parsed - 新格式的 ParsedSkill
 * @returns 旧格式的 SkillDefinition
 */
export function unbridgeSkill(parsed: ParsedSkill): SkillDefinition {
  return {
    name: parsed.name,
    description: parsed.description,
    prompt: parsed.promptContent,
    tools: parsed.allowedTools.length > 0 ? parsed.allowedTools : undefined,
  };
}
