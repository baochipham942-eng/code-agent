// ============================================================================
// 工具使用提醒 - edit vs write / task 委派 / git 安全
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 工具使用相关提醒（Priority 2）
 */
export const TOOL_USAGE_REMINDERS: ReminderDefinition[] = [
  {
    id: 'EDIT_NOT_WRITE',
    priority: 2,
    content: `<system-reminder>
**优先使用 Edit**：修改现有文件时，使用 Edit 而非 Write。
Edit 更安全，只修改指定部分，减少意外覆盖。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('Write') ? 0.9 : 0,
    category: 'tool',
  },
  {
    id: 'TASK_NOT_DIRECT',
    priority: 2,
    content: `<system-reminder>
**使用 Task 工具**：对于需要多步骤探索的任务，可以使用 Task 工具委派给专门的子代理。
目标文件、函数、编辑区域已经明确时，直接使用 Read/Edit/Bash 验证，不要为单点修改再委派。
</system-reminder>`,
    tokens: 60,
    shouldInclude: (ctx) => {
      const directTools = ['Glob', 'Grep', 'Read'];
      const usedDirectTools = directTools.filter((t) =>
        ctx.toolsUsedInTurn.includes(t)
      );
      return usedDirectTools.length >= 2 ? 0.8 : 0;
    },
    category: 'tool',
  },
  {
    id: 'GIT_NO_AUTO_COMMIT',
    priority: 2,
    content: `<system-reminder>
**Git 安全**：不要因为完成了文件修改就自动提交。只有用户明确要求 commit 时，才检查状态、暂存具体文件并提交；除非用户明确要求，否则不要 push。
</system-reminder>`,
    tokens: 45,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('Edit') ||
      ctx.toolsUsedInTurn.includes('Write')
        ? 0.3
        : 0,
    category: 'tool',
  },
];
