// ============================================================================
// Tool Descriptions Index - 导出所有工具描述
// ============================================================================

export { BASH_TOOL_DESCRIPTION } from './bash';
export { EDIT_TOOL_DESCRIPTION } from './edit';
export { TASK_TOOL_DESCRIPTION } from './task';

/**
 * 所有工具描述的组合
 *
 * 在 System Prompt 中插入详细的工具使用指南
 */
import { BASH_TOOL_DESCRIPTION } from './bash';
import { EDIT_TOOL_DESCRIPTION } from './edit';
import { TASK_TOOL_DESCRIPTION } from './task';

export const TOOL_DESCRIPTIONS = {
  bash: BASH_TOOL_DESCRIPTION,
  edit_file: EDIT_TOOL_DESCRIPTION,
  task: TASK_TOOL_DESCRIPTION,
};

/**
 * 获取指定工具的详细描述
 */
export function getToolDescription(toolName: string): string | undefined {
  return TOOL_DESCRIPTIONS[toolName as keyof typeof TOOL_DESCRIPTIONS];
}

/**
 * 获取所有工具描述组合成的完整文本
 */
export function getAllToolDescriptions(): string {
  return [BASH_TOOL_DESCRIPTION, EDIT_TOOL_DESCRIPTION, TASK_TOOL_DESCRIPTION].join('\n\n');
}
