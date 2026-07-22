// ============================================================================
// Role Pack Skills 聚合（E1 内置专家包：牧之/溯真/青禾/明镜，rollout-plan §5）
// 分发路径拍板（2026-07-21）：内置分发，随包开箱即用；
// Batch 4 E5 做 roleCatalog 云下发时按包整体迁移。
// ============================================================================

import type { ParsedSkill } from '../../../../shared/contract/agentSkill';
import type { SkillCategory } from '../../../../shared/contract/skillRepository';
import { PRODUCT_EXPERT_SKILLS } from './productExpertSkills';
import { DEEP_RESEARCH_EXPERT_SKILLS } from './deepResearchExpertSkills';
import { CONTENT_EXPERT_SKILLS } from './contentExpertSkills';
import { RETRO_REPORT_EXPERT_SKILLS } from './retroReportExpertSkills';

export const ROLE_PACK_SKILLS: ParsedSkill[] = [
  ...PRODUCT_EXPERT_SKILLS,
  ...DEEP_RESEARCH_EXPERT_SKILLS,
  ...CONTENT_EXPERT_SKILLS,
  ...RETRO_REPORT_EXPERT_SKILLS,
];

/** 产物分类（并入 builtinSkillsData 的 BUILTIN_SKILL_CATEGORY 回填） */
export const ROLE_PACK_SKILL_CATEGORY: Record<string, SkillCategory> = {
  // 牧之·产品
  brainstorming: 'development',
  'requirement-elicitation': 'product',
  'prd-authoring': 'product',
  'review-prep': 'product',
  'user-research-synthesis': 'research',
  // 溯真·调研
  'competitor-teardown': 'research',
  'multi-source-verification': 'research',
  'industry-scan': 'research',
  // 青禾·内容
  copywriting: 'content-marketing',
  'topic-to-draft': 'content-marketing',
  'xhs-post-crafting': 'content-marketing',
  'deck-outline': 'content-marketing',
  'notes-humanizer': 'content-marketing',
  // 明镜·复盘
  'internal-comms': 'docs-office',
  'weekly-report-synthesis': 'automation',
  'project-retro': 'automation',
  'monthly-review': 'automation',
};
