// ============================================================================
// Prompt Builder - Assembles system prompts for each generation
// ============================================================================
// Claude Code Style: 极简身份 + 内联规则 + 工具描述
// 目标：<2000 tokens（对标 Claude Code 269 tokens 核心 + 工具描述）
// ============================================================================

import type { GenerationId } from '../../../shared/types';
import { DEFAULT_GENERATION } from '../../../shared/constants';
import { IDENTITY_PROMPT } from './identity';
import { getSoul } from './soulLoader';
import { BASE_PROMPTS } from './base';
// 规则已内联到 identity.ts，无需静态导入
// 动态提醒系统可按需加载特定规则
import { getToolDescriptionsForGeneration } from './tools';
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
import {
  loadRulesDir,
  getMatchingRules,
  type PathRule,
} from '../../config/rulesLoader';
import { getRulesDir } from '../../config/configPaths';

// ----------------------------------------------------------------------------
// Rule Tiers - Token-optimized rule groupings
// ----------------------------------------------------------------------------

/**
 * Rule tiers - Claude Code 风格：所有规则内联到 identity.ts 和 gen8.ts
 * 无静态加载的规则（安全规则已内联到 identity.ts）
 */
const RULE_TIERS = {
  basic: [],
  collaboration: [],
  standard: [],  // 注入防护已内联到 identity.ts
  network: [],
  content: [],
};

/**
 * Get rules for a specific generation using tiered loading.
 * This optimizes token consumption by only including necessary rules.
 */
/** @simplified Always returns gen8 rules (all tiers) */
function getRulesForGeneration(_generationId: GenerationId): string[] {
  return [
    ...RULE_TIERS.basic,
    ...RULE_TIERS.collaboration,
    ...RULE_TIERS.standard,
    ...RULE_TIERS.network,
    ...RULE_TIERS.content,
  ];
}

// ----------------------------------------------------------------------------
// Prompt Builder
// ----------------------------------------------------------------------------

/**
 * Builds the complete system prompt for a generation.
 *
 * Claude Code 风格组装顺序：
 * 1. Identity - 极简身份声明 + 简洁要求 + 任务指南
 * 2. Generation Tools - 代际工具定义（包含内联规则）
 * 3. Tool Descriptions - 工具详细描述（包含工作流）
 * 4. Rules - 仅保留安全关键规则（注入防护）
 */
/** @simplified Always builds gen8 prompt regardless of generationId */
export function buildPrompt(generationId: GenerationId): string {
  const targetId = DEFAULT_GENERATION;
  const basePrompt = BASE_PROMPTS[targetId];
  const toolDescriptions = getToolDescriptionsForGeneration(targetId);
  const rules = getRulesForGeneration(targetId);

  if (!basePrompt) {
    throw new Error(`Unknown generation: ${targetId}`);
  }

  // Claude Code 风格组装：Identity/Soul → 代际工具 → 工具描述 → 规则
  return [getSoul(), basePrompt, ...toolDescriptions, ...rules].join('\n\n');
}

/**
 * Builds all system prompts and returns them as a record.
 */
export function buildAllPrompts(): Partial<Record<GenerationId, string>> {
  return {
    gen8: buildPrompt('gen8'),
  };
}

/**
 * Pre-built prompts for all generations.
 * Use this for performance when prompts are needed frequently.
 */
export const SYSTEM_PROMPTS: Partial<Record<GenerationId, string>> = buildAllPrompts();

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
- Read: Read file contents
- Write: Write/create files
- Edit: Edit existing files
- Bash: Run shell commands
- Glob: Find files by pattern

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
/** @simplified Always returns gen8 prompt */
export function getPromptForTask(
  _generationId: GenerationId,
  _isSimpleTask: boolean
): string {
  return SYSTEM_PROMPTS[DEFAULT_GENERATION]!;
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
  // Locked to gen8: ignore generationId
  const basePrompt = SYSTEM_PROMPTS[DEFAULT_GENERATION] ?? "";
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
  // Locked to gen8: ignore generationId
  const basePrompt = SYSTEM_PROMPTS[DEFAULT_GENERATION] ?? "";
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

// ----------------------------------------------------------------------------
// Path-Specific Rules (from .code-agent/rules/*.md)
// ----------------------------------------------------------------------------

let cachedRules: PathRule[] | null = null;

/**
 * Load path-specific rules from user and project rules directories.
 * Results are cached; call reloadRules() to refresh.
 */
export async function loadRules(workingDirectory?: string): Promise<PathRule[]> {
  const dirs = getRulesDir(workingDirectory);
  const allRules: PathRule[] = [];

  for (const dir of [dirs.user, dirs.project].filter(Boolean)) {
    const rules = await loadRulesDir(dir!);
    allRules.push(...rules);
  }

  cachedRules = allRules;
  return allRules;
}

/**
 * Force reload rules from disk.
 */
export async function reloadRules(workingDirectory?: string): Promise<PathRule[]> {
  cachedRules = null;
  return loadRules(workingDirectory);
}

/**
 * Get rules matching a file path. Uses cached rules if available.
 */
export function getRulesForFile(filePath: string): string[] {
  if (!cachedRules) return [];
  return getMatchingRules(cachedRules, filePath);
}

/**
 * Build a prompt with path-specific rules injected for the given file paths.
 */
export function buildPromptWithRules(
  generationId: GenerationId,
  filePaths: string[]
): string {
  const basePrompt = buildPrompt(DEFAULT_GENERATION);
  if (!cachedRules || filePaths.length === 0) return basePrompt;

  // Collect unique matching rules across all file paths
  const matchedRules = new Set<string>();
  for (const fp of filePaths) {
    for (const rule of getMatchingRules(cachedRules, fp)) {
      matchedRules.add(rule);
    }
  }

  if (matchedRules.size === 0) return basePrompt;

  const rulesSection = `\n\n# Path-Specific Rules\n\n${[...matchedRules].join('\n\n')}`;
  return basePrompt + rulesSection;
}
