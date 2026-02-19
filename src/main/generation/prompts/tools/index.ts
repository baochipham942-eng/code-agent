// ============================================================================
// Tool Descriptions Index - 导出所有工具描述
// ============================================================================

export { BASH_TOOL_DESCRIPTION } from './bash';
export { EDIT_TOOL_DESCRIPTION } from './edit';
export { TASK_TOOL_DESCRIPTION } from './task';

import { BASH_TOOL_DESCRIPTION } from './bash';
import { EDIT_TOOL_DESCRIPTION } from './edit';
import { TASK_TOOL_DESCRIPTION } from './task';

import type { GenerationId } from '../../../../shared/types';

// ----------------------------------------------------------------------------
// 工具→描述文本映射
// ----------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: BASH_TOOL_DESCRIPTION,
  edit_file: EDIT_TOOL_DESCRIPTION,
  task: TASK_TOOL_DESCRIPTION,
};

// ----------------------------------------------------------------------------
// 工具→最低代际映射（新增工具只需在此注册）
// ----------------------------------------------------------------------------

/**
 * 每个工具描述引入的最低代际。
 * 键必须与 TOOL_DESCRIPTIONS 的键一致。
 * 条目按 minGen 升序排列，保持输出顺序稳定。
 */
const TOOL_GENERATION_MAP: Record<string, number> = {
  bash: 1,       // gen1+ 基础工具
  edit_file: 1,  // gen1+ 基础工具
  task: 3,       // gen3+ 子代理系统
};

// ----------------------------------------------------------------------------
// 按代际获取工具描述
// ----------------------------------------------------------------------------

/**
 * 根据代际返回应包含的工具描述列表。
 *
 * 逻辑：遍历 TOOL_GENERATION_MAP，选出 minGen <= genNum 的工具，
 * 返回对应的描述文本。顺序由 TOOL_GENERATION_MAP 条目顺序决定。
 */
export function getToolDescriptionsForGeneration(generationId: GenerationId): string[] {
  const genNum = parseInt(generationId.replace('gen', ''), 10);
  return Object.entries(TOOL_GENERATION_MAP)
    .filter(([, minGen]) => genNum >= minGen)
    .map(([toolName]) => TOOL_DESCRIPTIONS[toolName])
    .filter(Boolean);
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
