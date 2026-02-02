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
  // PARALLEL_TOOLS_RULES,      // 已合并到 Gen8 prompt
  PLAN_MODE_RULES,
  GIT_SAFETY_RULES,
  INJECTION_DEFENSE_RULES,
  GITHUB_ROUTING_RULES,
  ERROR_HANDLING_RULES,
  CODE_SNIPPET_RULES,
  ATTACHMENT_HANDLING_RULES,
  // TOOL_USAGE_POLICY,         // 已合并到 Gen8 prompt
  // TOOL_DECISION_TREE,        // 已合并到 Gen8 prompt
  // TASK_MANAGEMENT_RULES,     // 已合并到 Gen8 prompt (todo_write)
  TASK_CLASSIFICATION_RULES,
} from './rules';
import {
  BASH_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
} from './tools';
import {
  detectTaskFeatures,
  getSystemReminders,
  type TaskFeatures,
} from './systemReminders';
import {
  selectMode,
  getModeReminder,
  getModeConfig,
  type AgentMode,
  type ModeConfig,
} from './agentModes';
import {
  selectReminders,
  createReminderContext,
  appendRemindersToMessage as appendDynamicReminders,
  type ReminderSelectionResult,
} from './dynamicReminders';
import type { ReminderContext } from './reminderRegistry';

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
   * - Task classification (fast routing)
   * - Output formatting
   * - Professional objectivity
   * - Code references
   * - Error handling
   */
  basic: [
    TASK_CLASSIFICATION_RULES,  // 首轮任务分类，避免额外 LLM 调用
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    ERROR_HANDLING_RULES,
  ],

  /**
   * Collaboration tier (Gen2+): 已合并到 Gen8 prompt
   * - PARALLEL_TOOLS_RULES → Gen8 "并行派发" 部分
   * - TOOL_DECISION_TREE → Gen8 "核心工具" 表格
   */
  collaboration: [],  // 已合并到 Gen8 prompt

  /**
   * Standard tier (Gen3+): Adds planning, git safety
   * - TOOL_USAGE_POLICY → 已合并到 Gen8 "强制规则"
   * - TASK_MANAGEMENT_RULES → 已合并到 Gen8 "todo_write"
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

// ----------------------------------------------------------------------------
// Dynamic Prompt Building (借鉴 Claude Code 动态系统提醒)
// ----------------------------------------------------------------------------

/**
 * 动态 Prompt 构建结果
 */
export interface DynamicPromptResult {
  systemPrompt: string;
  userMessage: string;
  features: TaskFeatures;
  mode: AgentMode;
  modeConfig: ModeConfig;
}

/**
 * 动态构建 prompt，根据任务特征注入系统提醒和模式
 *
 * 借鉴 Claude Code 的设计：
 * 1. 40 个动态系统提醒，按需注入
 * 2. 模式系统：normal/plan/review/audit
 * 3. 避免所有规则同时竞争模型注意力
 */
export function buildDynamicPrompt(
  generationId: GenerationId,
  taskPrompt: string
): DynamicPromptResult {
  const basePrompt = SYSTEM_PROMPTS[generationId];
  const features = detectTaskFeatures(taskPrompt);
  const mode = selectMode(taskPrompt);
  const modeConfig = getModeConfig(mode);
  const modeReminder = getModeReminder(mode);
  const generalReminders = getSystemReminders(taskPrompt);

  // 组合所有提醒：模式提醒 + 通用提醒
  const allReminders: string[] = [];
  if (modeReminder) {
    allReminders.push(modeReminder);
  }
  // 如果已有模式提醒，减少通用提醒的重复
  if (mode === 'normal') {
    allReminders.push(...generalReminders);
  }

  // 将系统提醒附加到用户消息末尾
  const userMessage =
    allReminders.length > 0
      ? taskPrompt + '\n\n' + allReminders.join('\n')
      : taskPrompt;

  return {
    systemPrompt: basePrompt,
    userMessage,
    features,
    mode,
    modeConfig,
  };
}

/**
 * 检测任务特征（导出供外部使用）
 */
export { detectTaskFeatures, getSystemReminders, type TaskFeatures };

/**
 * 模式相关导出
 */
export { selectMode, getModeReminder, getModeConfig, type AgentMode, type ModeConfig };

// ----------------------------------------------------------------------------
// Dynamic Prompt Building V2 (基于优先级和预算的动态提醒)
// ----------------------------------------------------------------------------

/**
 * 动态 Prompt V2 构建结果
 */
export interface DynamicPromptResultV2 extends DynamicPromptResult {
  reminderStats: ReminderSelectionResult['stats'];
  tokensUsed: number;
  tokenBudget: number;
}

/**
 * 动态构建 prompt V2 - 增强版
 *
 * 改进点：
 * 1. 基于优先级的提醒选择
 * 2. Token 预算管理
 * 3. 上下文感知规则
 * 4. 去重机制
 * 5. 可选 few-shot 示例
 */
export function buildDynamicPromptV2(
  generationId: GenerationId,
  taskPrompt: string,
  options: {
    toolsUsedInTurn?: string[];
    iterationCount?: number;
    hasError?: boolean;
    lastToolResult?: string;
    maxReminderTokens?: number;
    includeFewShot?: boolean;
  } = {}
): DynamicPromptResultV2 {
  const basePrompt = SYSTEM_PROMPTS[generationId];
  const features = detectTaskFeatures(taskPrompt);
  const mode = selectMode(taskPrompt);
  const modeConfig = getModeConfig(mode);

  // 创建提醒上下文
  const reminderContext = createReminderContext(taskPrompt, {
    toolsUsedInTurn: options.toolsUsedInTurn || [],
    iterationCount: options.iterationCount || 0,
    currentMode: mode,
    hasError: options.hasError || false,
    lastToolResult: options.lastToolResult,
    tokenBudget: options.maxReminderTokens || 800,
  });

  // 选择动态提醒
  const reminderResult = selectReminders(reminderContext, {
    maxTokens: options.maxReminderTokens || 800,
    includeFewShot: options.includeFewShot ?? true,
  });

  // 组合用户消息
  const userMessage = appendDynamicReminders(taskPrompt, reminderResult.reminders);

  return {
    systemPrompt: basePrompt,
    userMessage,
    features,
    mode,
    modeConfig,
    reminderStats: reminderResult.stats,
    tokensUsed: reminderResult.tokensUsed,
    tokenBudget: reminderResult.tokenBudget,
  };
}

/**
 * 获取增强版动态提醒（不构建完整 prompt）
 */
export function getEnhancedReminders(
  taskPrompt: string,
  options: {
    toolsUsedInTurn?: string[];
    iterationCount?: number;
    currentMode?: string;
    hasError?: boolean;
    maxTokens?: number;
  } = {}
): ReminderSelectionResult {
  const context = createReminderContext(taskPrompt, options);
  return selectReminders(context, { maxTokens: options.maxTokens });
}

/**
 * 导出动态提醒相关类型和函数
 */
export { createReminderContext, selectReminders, type ReminderSelectionResult, type ReminderContext };
