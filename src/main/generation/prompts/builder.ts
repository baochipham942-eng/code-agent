// ============================================================================
// Prompt Builder - Assembles system prompts for each generation
// ============================================================================
// Token Optimization: Uses tiered rule loading to reduce prompt size
// - Gen1-2: Basic rules (~4k tokens)
// - Gen3-4: Standard rules (~6k tokens)
// - Gen5+:  Full rules (~8k tokens)
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
// Rule Tiers - Token-optimized rule groupings
// ----------------------------------------------------------------------------

/**
 * Rule tiers for progressive loading based on generation capabilities.
 * This reduces token consumption for simpler generations.
 */
const RULE_TIERS = {
  /**
   * Basic tier (Gen1-2): Essential rules only
   * - Output formatting
   * - Professional objectivity
   * - Code references
   * - Error handling
   */
  basic: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    ERROR_HANDLING_RULES,
  ],

  /**
   * Collaboration tier (Gen2+): Adds parallel execution
   */
  collaboration: [
    PARALLEL_TOOLS_RULES,
  ],

  /**
   * Standard tier (Gen3+): Adds planning and git safety
   */
  standard: [
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
  ],

  /**
   * Network tier (Gen4+): Adds GitHub integration
   */
  network: [
    GITHUB_ROUTING_RULES,
  ],

  /**
   * Content tier (all): Content generation rules
   */
  content: [
    CODE_SNIPPET_RULES,
    HTML_GENERATION_RULES,
    ATTACHMENT_HANDLING_RULES,
  ],
};

/**
 * Get rules for a specific generation using tiered loading.
 * This optimizes token consumption by only including necessary rules.
 */
function getRulesForGeneration(generationId: GenerationId): string[] {
  const genNum = parseInt(generationId.replace('gen', ''), 10);
  const rules: string[] = [];

  // Always include basic rules
  rules.push(...RULE_TIERS.basic);

  // Gen2+: Add collaboration rules
  if (genNum >= 2) {
    rules.push(...RULE_TIERS.collaboration);
  }

  // Gen3+: Add standard rules (planning, git, security)
  if (genNum >= 3) {
    rules.push(...RULE_TIERS.standard);
  }

  // Gen4+: Add network rules (GitHub)
  if (genNum >= 4) {
    rules.push(...RULE_TIERS.network);
  }

  // Always include content rules
  rules.push(...RULE_TIERS.content);

  return rules;
}

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
function getToolDescriptionsForGeneration(generationId: GenerationId): string[] {
  const genNum = parseInt(generationId.replace('gen', ''), 10);

  if (genNum >= 3) {
    return [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION];
  }

  return [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION];
}

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
 * 4. 规则层 - 输出格式、安全规则等（分层加载）
 */
export function buildPrompt(generationId: GenerationId): string {
  const basePrompt = BASE_PROMPTS[generationId];
  const toolDescriptions = getToolDescriptionsForGeneration(generationId);
  const rules = getRulesForGeneration(generationId);

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

// ----------------------------------------------------------------------------
// Simple Task Mode Prompt (Phase 3)
// ----------------------------------------------------------------------------

/**
 * Minimal prompt for simple tasks - significantly reduces token consumption.
 * Used when task complexity analysis identifies a simple, single-step task.
 *
 * Token savings: ~85% compared to full Gen1 prompt
 */
export const SIMPLE_TASK_PROMPT = `# Code Agent - Simple Mode

You are a helpful coding assistant. Help the user with their request directly and concisely.

## Available Tools
- read_file: Read file contents
- write_file: Write/create files
- edit_file: Edit existing files
- bash: Run shell commands
- glob: Find files by pattern

## Guidelines
- Be direct and concise
- Use only necessary tools
- Don't add unnecessary explanations
- Focus on completing the task efficiently

## Output Format
- Use markdown for code blocks
- Keep responses focused on the task
`;

/**
 * Get the appropriate prompt based on task complexity.
 * For simple tasks, returns minimal prompt to save tokens.
 */
export function getPromptForTask(
  generationId: GenerationId,
  isSimpleTask: boolean
): string {
  // Only use simple prompt for Gen1-2 simple tasks
  const genNum = parseInt(generationId.replace('gen', ''), 10);

  if (isSimpleTask && genNum <= 2) {
    return SIMPLE_TASK_PROMPT;
  }

  return SYSTEM_PROMPTS[generationId];
}
