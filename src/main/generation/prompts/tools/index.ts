// ============================================================================
// Tool Descriptions Index - 导出所有工具描述
// ============================================================================

export { BASH_TOOL_DESCRIPTION } from './bash';
export { EDIT_TOOL_DESCRIPTION } from './edit';
export { TASK_TOOL_DESCRIPTION } from './task';

import { BASH_TOOL_DESCRIPTION } from './bash';
import { EDIT_TOOL_DESCRIPTION } from './edit';
import { TASK_TOOL_DESCRIPTION } from './task';



// ----------------------------------------------------------------------------
// 工具→描述文本映射
// ----------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: BASH_TOOL_DESCRIPTION,
  edit_file: EDIT_TOOL_DESCRIPTION,
  task: TASK_TOOL_DESCRIPTION,
};

// ----------------------------------------------------------------------------
// 获取所有工具描述（Sprint 2: 移除代际过滤，始终返回全部）
// ----------------------------------------------------------------------------

/**
 * 返回所有工具描述。代际参数已废弃，保留签名兼容性。
 */
export function getToolDescriptionsForGeneration(_generationId?: string): string[] {
  return Object.values(TOOL_DESCRIPTIONS).filter(Boolean);
}

// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------

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
  return Object.values(TOOL_DESCRIPTIONS).join('\n\n');
}
