// ============================================================================
// Prompt Builder - Assembles system prompts for each generation
// ============================================================================

import type { GenerationId } from '../../../shared/types';
import { CONSTITUTION } from './constitution';
import { BASE_PROMPTS } from './base';
import {
  OUTPUT_FORMAT_RULES,
  HTML_GENERATION_RULES,
  PROFESSIONAL_OBJECTIVITY_RULES,
  CODE_REFERENCE_RULES,
  PARALLEL_TOOLS_RULES,
  PLAN_MODE_RULES,
  GIT_SAFETY_RULES,
  INJECTION_DEFENSE_RULES,
  GITHUB_ROUTING_RULES,
  ERROR_HANDLING_RULES,
  CODE_SNIPPET_RULES,
  ATTACHMENT_HANDLING_RULES,
} from './rules';
import {
  BASH_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
} from './tools';

// ----------------------------------------------------------------------------
// Tool Descriptions for Each Generation
// ----------------------------------------------------------------------------

/**
 * Defines which detailed tool descriptions are included in each generation.
 * These provide in-depth usage guides for the most important tools.
 *
 * bash & edit: Available from gen1 (basic tools)
 * task: Available from gen3 (subagent system)
 */
const GENERATION_TOOL_DESCRIPTIONS: Record<GenerationId, string[]> = {
  gen1: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION],
  gen2: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION],
  gen3: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
  gen4: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
  gen5: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
  gen6: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
  gen7: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
  gen8: [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION],
};

// ----------------------------------------------------------------------------
// Rule Sets for Each Generation
// ----------------------------------------------------------------------------

/**
 * Defines which rules are included in each generation's prompt.
 * Rules are appended in the order listed.
 */
const GENERATION_RULES: Record<GenerationId, string[]> = {
  gen1: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen2: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen3: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen4: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    GITHUB_ROUTING_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen5: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    GITHUB_ROUTING_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen6: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    GITHUB_ROUTING_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen7: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    GITHUB_ROUTING_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
  gen8: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    PARALLEL_TOOLS_RULES,
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
    GITHUB_ROUTING_RULES,
    ERROR_HANDLING_RULES,
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
};

// ----------------------------------------------------------------------------
// Prompt Builder
// ----------------------------------------------------------------------------

/**
 * Builds the complete system prompt for a generation.
 *
 * Prompt 组装顺序：
 * 1. 宪法层 - 所有代际共享的身份、价值观和行为准则
 * 2. 代际工具层 - 各代际的工具定义和使用说明
 * 3. 工具详细描述层 - 关键工具的详细使用指南
 * 4. 规则层 - 输出格式、安全规则等
 */
export function buildPrompt(generationId: GenerationId): string {
  const basePrompt = BASE_PROMPTS[generationId];
  const toolDescriptions = GENERATION_TOOL_DESCRIPTIONS[generationId];
  const rules = GENERATION_RULES[generationId];

  if (!basePrompt) {
    throw new Error(`Unknown generation: ${generationId}`);
  }

  // 组装完整的 System Prompt
  // 顺序：宪法 → 代际工具 → 工具详细描述 → 规则
  return [CONSTITUTION, basePrompt, ...toolDescriptions, ...rules].join('\n\n');
}

/**
 * Builds all system prompts and returns them as a record.
 */
export function buildAllPrompts(): Record<GenerationId, string> {
  const generationIds: GenerationId[] = [
    'gen1',
    'gen2',
    'gen3',
    'gen4',
    'gen5',
    'gen6',
    'gen7',
    'gen8',
  ];

  const prompts: Partial<Record<GenerationId, string>> = {};

  for (const id of generationIds) {
    prompts[id] = buildPrompt(id);
  }

  return prompts as Record<GenerationId, string>;
}

/**
 * Pre-built prompts for all generations.
 * Use this for performance when prompts are needed frequently.
 */
export const SYSTEM_PROMPTS: Record<GenerationId, string> = buildAllPrompts();
