// ============================================================================
// Prompt Builder - Assembles system prompts
// ============================================================================
// Claude Code Style: 极简身份 + 内联规则 + 工具描述
// 目标：<2000 tokens（对标 Claude Code 269 tokens 核心 + 工具描述）
// ============================================================================

import { IDENTITY_PROMPT } from './identity';
import { getSoul } from './soulLoader';
import { TOOLS_PROMPT } from './base';
import { GENERATIVE_UI_PROMPT } from './generativeUI';
// 规则已内联到 identity.ts，无需静态导入
// 动态提醒系统可按需加载特定规则
import { getToolDescriptions } from './tools';
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
} from '../config/rulesLoader';
import { getRulesDir } from '../config/configPaths';

// ----------------------------------------------------------------------------
// Rule Tiers - Token-optimized rule groupings
// ----------------------------------------------------------------------------

const RULE_TIERS = {
  basic: [],
  collaboration: [],
  standard: [],
  network: [],
  content: [],
};

function getRulesForPrompt(): string[] {
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

export function buildPrompt(): string {
  const basePrompt = TOOLS_PROMPT;
  const toolDescriptions = getToolDescriptions();
  const rules = getRulesForPrompt();

  if (!basePrompt) {
    throw new Error('Base prompt not found');
  }

  return [getSoul(), basePrompt, ...toolDescriptions, ...rules, GENERATIVE_UI_PROMPT].join('\n\n');
}

export const SYSTEM_PROMPT: string = buildPrompt();

// ----------------------------------------------------------------------------
// Simple Task Mode Prompt (Phase 3)
// ----------------------------------------------------------------------------

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

export function getPromptForTask(): string {
  return SYSTEM_PROMPT;
}

// ----------------------------------------------------------------------------
// Dynamic Prompt Building
// ----------------------------------------------------------------------------

export interface DynamicPromptResult {
  systemPrompt: string;
  userMessage: string;
  features: TaskFeatures;
  mode: AgentMode;
  modeConfig: ModeConfig;
}

export function buildDynamicPrompt(
  taskPrompt: string
): DynamicPromptResult {
  const basePrompt = SYSTEM_PROMPT;
  const features = detectTaskFeatures(taskPrompt);
  const mode = selectMode(taskPrompt);
  const modeConfig = getModeConfig(mode);
  const modeReminder = getModeReminder(mode);
  const generalReminders = getSystemReminders(taskPrompt);

  const allReminders: string[] = [];
  if (modeReminder) {
    allReminders.push(modeReminder);
  }
  if (mode === 'normal') {
    allReminders.push(...generalReminders);
  }

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

export { detectTaskFeatures, getSystemReminders, type TaskFeatures };
export { selectMode, getModeReminder, getModeConfig, type AgentMode, type ModeConfig };

// ----------------------------------------------------------------------------
// Dynamic Prompt Building V2
// ----------------------------------------------------------------------------

export interface DynamicPromptResultV2 extends DynamicPromptResult {
  reminderStats: ReminderSelectionResult['stats'];
  tokensUsed: number;
  tokenBudget: number;
}

export function buildDynamicPromptV2(
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
  const basePrompt = SYSTEM_PROMPT;
  const features = detectTaskFeatures(taskPrompt);
  const mode = selectMode(taskPrompt);
  const modeConfig = getModeConfig(mode);

  const reminderContext = createReminderContext(taskPrompt, {
    toolsUsedInTurn: options.toolsUsedInTurn || [],
    iterationCount: options.iterationCount || 0,
    currentMode: mode,
    hasError: options.hasError || false,
    lastToolResult: options.lastToolResult,
    tokenBudget: options.maxReminderTokens || 800,
  });

  const reminderResult = selectReminders(reminderContext, {
    maxTokens: options.maxReminderTokens || 800,
    includeFewShot: options.includeFewShot ?? true,
  });

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

export { createReminderContext, selectReminders, type ReminderSelectionResult, type ReminderContext };

// ----------------------------------------------------------------------------
// Path-Specific Rules (from .code-agent/rules/*.md)
// ----------------------------------------------------------------------------

let cachedRules: PathRule[] | null = null;

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

export async function reloadRules(workingDirectory?: string): Promise<PathRule[]> {
  cachedRules = null;
  return loadRules(workingDirectory);
}

export function getRulesForFile(filePath: string): string[] {
  if (!cachedRules) return [];
  return getMatchingRules(cachedRules, filePath);
}

export function buildPromptWithRules(
  filePaths: string[]
): string {
  const basePrompt = buildPrompt();
  if (!cachedRules || filePaths.length === 0) return basePrompt;

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
